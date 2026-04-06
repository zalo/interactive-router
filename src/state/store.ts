import { create } from "zustand"
import type {
  AppMode,
  BoardData,
  ComponentData,
  ConnectionData,
  PlacementState,
  RoutedTrace,
  ActiveRoute,
  Metrics,
  Point,
} from "../types"
import { parseCircuitJson, type ParsedCircuit } from "./circuitParser"
import { clearPadClearanceCache } from "../pathfinding/meshManager"
import { pack, type PackInput, type PackOutput, type InputComponent } from "calculate-packing"

export interface AppState {
  // Mode
  mode: AppMode

  // Board
  board: BoardData

  // Components (immutable after parse)
  components: Map<string, ComponentData>

  // Placement state (mutable positions)
  placements: Map<string, PlacementState>

  // Connection graph (immutable after parse)
  connections: ConnectionData[]

  // Routing state
  routedTraces: Map<string, RoutedTrace>
  unroutedConnectionIds: Set<string>

  // Interactive routing
  activeRoute: ActiveRoute | null

  // Metrics
  metrics: Metrics

  // Camera
  camera: { panX: number; panY: number; zoom: number }

  // Drag state
  dragState: {
    componentId: string | null
    offsetX: number
    offsetY: number
    pointerId: number | null
  }

  // Hover state
  hoveredComponentId: string | null

  // Auto-placed reference positions (from sequential optimal packing)
  autoPlacedPlacements: Map<string, PlacementState>

  // Settings
  componentMargin: number // mm of padding around components for trace routing
  debugView: "normal" | "obstacles" | "mesh" // render debug overlay

  // Loading
  initialized: boolean
  autorouterProgress: number
  placementVersion: number // bumped on randomize to trigger physics reinit

  // Actions
  loadCircuit: (circuitJson: any[]) => void
  setMode: (mode: AppMode) => void
  updatePlacement: (componentId: string, state: Partial<PlacementState>) => void
  batchUpdatePlacements: (updates: Map<string, Partial<PlacementState>>) => void
  setCamera: (camera: Partial<AppState["camera"]>) => void
  setDragState: (state: Partial<AppState["dragState"]>) => void
  setHoveredComponent: (id: string | null) => void
  toggleFrozen: (componentId: string) => void
  setRoutedTraces: (traces: Map<string, RoutedTrace>, unrouted: Set<string>) => void
  setActiveRoute: (route: ActiveRoute | null) => void
  setAutorouterProgress: (progress: number) => void
  setComponentMargin: (margin: number) => void
  setDebugView: (view: "normal" | "obstacles" | "mesh") => void
  randomizePlacements: () => void
  resetToAutoPlacement: () => void
  recomputeMetrics: () => void
}

function computeMetrics(
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
  connections: ConnectionData[],
  routedTraces: Map<string, RoutedTrace>,
  unroutedConnectionIds: Set<string>,
): Metrics {
  let totalConnectionLength = 0
  let crossingCount = 0
  const segments: Array<{ x1: number; y1: number; x2: number; y2: number }> = []

  for (const conn of connections) {
    if (conn.endpoints.length < 2) continue

    for (let i = 0; i < conn.endpoints.length - 1; i++) {
      const ep1 = conn.endpoints[i]
      const ep2 = conn.endpoints[i + 1]
      const p1 = getWorldPadPosition(components, placements, ep1.componentId, ep1.padId)
      const p2 = getWorldPadPosition(components, placements, ep2.componentId, ep2.padId)
      if (!p1 || !p2) continue

      const dx = p2.x - p1.x
      const dy = p2.y - p1.y
      totalConnectionLength += Math.sqrt(dx * dx + dy * dy)
      segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y })
    }
  }

  // Count crossings (O(n^2) but fine for <100 segments)
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      if (segmentsIntersect(segments[i], segments[j])) {
        crossingCount++
      }
    }
  }

  return {
    totalConnectionLength: Math.round(totalConnectionLength * 10) / 10,
    crossingCount,
    drcViolations: 0,
    unroutedCount: unroutedConnectionIds.size,
    routedCount: routedTraces.size,
  }
}

function segmentsIntersect(
  s1: { x1: number; y1: number; x2: number; y2: number },
  s2: { x1: number; y1: number; x2: number; y2: number },
): boolean {
  const d1x = s1.x2 - s1.x1, d1y = s1.y2 - s1.y1
  const d2x = s2.x2 - s2.x1, d2y = s2.y2 - s2.y1
  const cross = d1x * d2y - d1y * d2x
  if (Math.abs(cross) < 1e-10) return false

  const dx = s2.x1 - s1.x1, dy = s2.y1 - s1.y1
  const t = (dx * d2y - dy * d2x) / cross
  const u = (dx * d1y - dy * d1x) / cross
  return t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999
}

export function getWorldPadPosition(
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
  componentId: string,
  padId: string,
): Point | null {
  const comp = components.get(componentId)
  const placement = placements.get(componentId)
  if (!comp || !placement) return null

  const pad = comp.pads.find((p) => p.id === padId)
  if (!pad) return null

  const rad = (placement.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)

  return {
    x: placement.x + pad.localX * cos - pad.localY * sin,
    y: placement.y + pad.localX * sin + pad.localY * cos,
  }
}

/**
 * Run the Sequential Optimal Packing algorithm from calculate-packing.
 * Converts our parsed circuit into PackInput, runs the solver, and
 * returns a PlacementState map with the packed positions/rotations.
 */
function runAutoPlacement(
  parsed: ParsedCircuit,
  margin = 1.5,
  frozenPlacements?: Map<string, PlacementState>,
): Map<string, PlacementState> {
  const { components, connections, board } = parsed

  // Build PackInput components from our internal model
  const packComponents: InputComponent[] = []
  const padIdToNetworks = new Map<string, string[]>()

  // Build network map from connections
  for (const conn of connections) {
    for (const ep of conn.endpoints) {
      const key = `${ep.componentId}:${ep.padId}`
      const nets = padIdToNetworks.get(key) || []
      nets.push(conn.id)
      padIdToNetworks.set(key, nets)
    }
  }

  for (const [compId, comp] of components) {
    // Real pads with network connections
    const pads = comp.pads.map((pad) => ({
      padId: pad.id,
      networkId: padIdToNetworks.get(`${compId}:${pad.id}`)?.[0] || `unconnected_${pad.id}`,
      type: "rect" as const,
      offset: { x: pad.localX, y: pad.localY },
      size: { x: pad.width, y: pad.height },
    }))

    // Add a single large "body" pad covering the entire footprint so
    // the packer's outline algorithm treats the whole component body
    // as occupied space. Without this, components get placed between
    // sparse pads of other components.
    pads.push({
      padId: `${compId}_body`,
      networkId: `_body_${compId}`,
      type: "rect",
      offset: { x: 0, y: 0 },
      size: { x: comp.width, y: comp.height },
    })

    // If this component is frozen, mark it static at its current position
    const frozen = frozenPlacements?.get(compId)
    packComponents.push({
      componentId: compId,
      pads,
      ...(frozen ? {
        isStatic: true,
        center: { x: frozen.x, y: frozen.y },
        ccwRotationOffset: frozen.rotation,
      } : {}),
    })
  }

  // Build weighted connections for packing cost function
  const weightedConnections: PackInput["weightedConnections"] = []
  for (const conn of connections) {
    const padIds = conn.endpoints.map((ep) => {
      const comp = components.get(ep.componentId)
      return comp?.pads.find((p) => p.id === ep.padId)?.id
    }).filter(Boolean) as string[]
    if (padIds.length >= 2) {
      weightedConnections.push({ padIds, weight: 1 })
    }
  }

  const halfW = board.width / 2
  const halfH = board.height / 2

  try {
    const packResult = pack({
      components: packComponents,
      bounds: { minX: -halfW, minY: -halfH, maxX: halfW, maxY: halfH },
      minGap: margin,
      packOrderStrategy: "largest_to_smallest",
      packPlacementStrategy: "minimum_sum_squared_distance_to_network",
      weightedConnections,
      disconnectedPackDirection: "nearest_to_center",
    })

    // Convert pack output to PlacementState map
    const placements = new Map<string, PlacementState>()
    for (const packed of packResult.components) {
      placements.set(packed.componentId, {
        x: packed.center?.x ?? 0,
        y: packed.center?.y ?? 0,
        rotation: packed.ccwRotationDegrees ?? packed.ccwRotationOffset ?? 0,
        frozen: false,
      })
    }
    console.log(`[autoplacement] Packed ${placements.size} components using sequential optimal packing`)
    return placements
  } catch (e) {
    console.error("[autoplacement] Packing failed, falling back to original positions:", e)
    // Fallback to original positions
    const placements = new Map<string, PlacementState>()
    for (const [id, comp] of components) {
      placements.set(id, {
        x: comp.originalPcbX,
        y: comp.originalPcbY,
        rotation: comp.originalRotation,
        frozen: false,
      })
    }
    return placements
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  mode: "placement",
  board: { width: 55, height: 60, layerCount: 2 },
  components: new Map(),
  placements: new Map(),
  connections: [],
  routedTraces: new Map(),
  unroutedConnectionIds: new Set(),
  activeRoute: null,
  metrics: { totalConnectionLength: 0, crossingCount: 0, drcViolations: 0, unroutedCount: 0, routedCount: 0 },
  camera: { panX: 0, panY: 0, zoom: 8 },
  dragState: { componentId: null, offsetX: 0, offsetY: 0, pointerId: null },
  hoveredComponentId: null,
  autoPlacedPlacements: new Map(),
  componentMargin: 1.5,
  debugView: "normal" as const,
  initialized: false,
  autorouterProgress: 0,
  placementVersion: 0,

  loadCircuit(circuitJson) {
    const parsed = parseCircuitJson(circuitJson)
    clearPadClearanceCache()

    // Use original component positions from the circuit file
    const placements = new Map<string, PlacementState>()
    for (const [id, comp] of parsed.components) {
      placements.set(id, {
        x: comp.originalPcbX,
        y: comp.originalPcbY,
        rotation: comp.originalRotation,
        frozen: false,
      })
    }

    const unrouted = new Set(parsed.connections.map((c) => c.id))
    const autoPlacedPlacements = new Map(placements)

    set({
      board: parsed.board,
      components: parsed.components,
      placements,
      autoPlacedPlacements,
      connections: parsed.connections,
      unroutedConnectionIds: unrouted,
      initialized: true,
    })
    get().recomputeMetrics()
  },

  setMode: (mode) => set({ mode }),

  updatePlacement(componentId, partial) {
    const placements = new Map(get().placements)
    const current = placements.get(componentId)
    if (current) {
      placements.set(componentId, { ...current, ...partial })
      set({ placements })
    }
  },

  batchUpdatePlacements(updates) {
    const placements = new Map(get().placements)
    for (const [id, partial] of updates) {
      const current = placements.get(id)
      if (current) {
        placements.set(id, { ...current, ...partial })
      }
    }
    set({ placements })
  },

  setCamera: (camera) => set({ camera: { ...get().camera, ...camera } }),
  setDragState: (state) => set({ dragState: { ...get().dragState, ...state } }),
  setHoveredComponent: (id) => set({ hoveredComponentId: id }),

  toggleFrozen(componentId) {
    const placements = new Map(get().placements)
    const current = placements.get(componentId)
    if (current) {
      placements.set(componentId, { ...current, frozen: !current.frozen })
      set({ placements })
    }
  },

  setRoutedTraces(traces, unrouted) {
    set({ routedTraces: traces, unroutedConnectionIds: unrouted })
    get().recomputeMetrics()
  },

  setActiveRoute: (route) => set({ activeRoute: route }),
  setAutorouterProgress: (progress) => set({ autorouterProgress: progress }),
  setComponentMargin: (margin) => set({ componentMargin: margin }),
  setDebugView: (view) => set({ debugView: view }),

  randomizePlacements() {
    const s = get()
    const placements = new Map(s.placements)
    const halfW = s.board.width / 2 - 5
    const halfH = s.board.height / 2 - 5
    for (const [id, placement] of placements) {
      placements.set(id, {
        ...placement,
        x: (Math.random() * 2 - 1) * halfW,
        y: (Math.random() * 2 - 1) * halfH,
        rotation: Math.floor(Math.random() * 8) * 45,
      })
    }
    set({ placements, placementVersion: s.placementVersion + 1 })
  },

  resetToAutoPlacement() {
    const s = get()
    // Re-run the packer with current margin, respecting frozen components
    const frozenPlacements = new Map<string, PlacementState>()
    for (const [id, p] of s.placements) {
      if (p.frozen) frozenPlacements.set(id, p)
    }

    const parsed = { board: s.board, components: s.components, connections: s.connections }
    const placements = runAutoPlacement(
      parsed,
      s.componentMargin,
      frozenPlacements.size > 0 ? frozenPlacements : undefined,
    )

    // Preserve frozen flags
    for (const [id, p] of s.placements) {
      if (p.frozen) {
        placements.set(id, { ...placements.get(id)!, frozen: true })
      }
    }

    const autoPlacedPlacements = new Map(placements)
    set({ placements, autoPlacedPlacements, placementVersion: s.placementVersion + 1 })
  },

  recomputeMetrics() {
    const s = get()
    const metrics = computeMetrics(s.components, s.placements, s.connections, s.routedTraces, s.unroutedConnectionIds)
    set({ metrics })
  },
}))
