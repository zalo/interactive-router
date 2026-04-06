/**
 * Simplified mesh manager: builds ONE navigation mesh from pad obstacles,
 * then routes all connections via Polyanya with no regard for trace overlap.
 *
 * On component move → rebake CDT from pad footprints → merge convex regions → route all traces.
 */

import type { ComponentData, PlacementState, RoutedTrace, BoardData, Point, ConnectionData, PadData } from "../types"
import { cdtTriangulate } from "../lib/polyanya/index"
import { buildMeshFromRegions } from "../lib/polyanya/index"
import { mergeMesh } from "../lib/polyanya/index"
import { SearchInstance } from "../lib/polyanya/index"
import { getWorldPadPosition } from "../state/store"
import { PointLocationType } from "../lib/polyanya/types"

const PAD_CLEARANCE = 0.15 // mm max clearance around pads
const MIN_CLEARANCE = 0.02 // mm minimum so obstacles don't degenerate
const GAP_MARGIN = 0.04    // mm kept free between expanded obstacles so traces can pass

// ─── Per-pad clearance cache (computed once per component) ───────────

/** Cache: componentId → Map<padId, clearance> */
const padClearanceCache = new Map<string, Map<string, number>>()

/**
 * Compute per-pad clearance for all pads in a component, using local-space
 * edge-to-edge distances between same-component pads. Rotation-invariant
 * since local coords don't change.
 *
 * clearance = min(PAD_CLEARANCE, (gap - GAP_MARGIN) / 2)
 * clamped to [MIN_CLEARANCE, PAD_CLEARANCE]
 */
function getPadClearances(comp: ComponentData): Map<string, number> {
  const cached = padClearanceCache.get(comp.id)
  if (cached) return cached

  const pads = comp.pads
  // Build local-space (unrotated) rectangles for each pad
  const localPolys = pads.map(pad => localRect(pad))

  const clearances = new Map<string, number>()
  for (let i = 0; i < pads.length; i++) {
    let minGap = Infinity
    for (let j = 0; j < pads.length; j++) {
      if (i === j) continue
      const d = polyPolyDist(localPolys[i]!, localPolys[j]!)
      if (d < minGap) minGap = d
    }
    // Leave GAP_MARGIN of free space so the gap between obstacles is navigable
    const clearance = Math.max(MIN_CLEARANCE, Math.min(PAD_CLEARANCE, (minGap - GAP_MARGIN) / 2))
    clearances.set(pads[i]!.id, clearance)
  }

  padClearanceCache.set(comp.id, clearances)
  return clearances
}

/** Axis-aligned rect polygon for a pad in local (component) space. */
function localRect(pad: PadData): { x: number; y: number }[] {
  const hw = pad.width / 2
  const hh = pad.height / 2
  return [
    { x: pad.localX - hw, y: pad.localY - hh },
    { x: pad.localX + hw, y: pad.localY - hh },
    { x: pad.localX + hw, y: pad.localY + hh },
    { x: pad.localX - hw, y: pad.localY + hh },
  ]
}

/** Call when components change (e.g. new circuit loaded). */
export function clearPadClearanceCache() {
  padClearanceCache.clear()
}

// ─── Geometry helpers ────────────────────────────────────────────────

/** Create a rotated rectangle polygon (4 corners CCW) */
function rotatedRectPolygon(
  cx: number, cy: number, w: number, h: number,
  rotation: number, clearance: number,
): { x: number; y: number }[] {
  const hw = w / 2 + clearance
  const hh = h / 2 + clearance
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const corners = [
    { lx: -hw, ly: -hh },
    { lx:  hw, ly: -hh },
    { lx:  hw, ly:  hh },
    { lx: -hw, ly:  hh },
  ]
  return corners.map(({ lx, ly }) => ({
    x: cx + lx * cos - ly * sin,
    y: cy + lx * sin + ly * cos,
  }))
}

/**
 * Clip a polygon's vertices to stay within bounds.
 */
function clipObstacleToBounds(
  poly: { x: number; y: number }[],
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
): { x: number; y: number }[] {
  return poly.map(p => ({
    x: Math.max(bounds.minX + 0.01, Math.min(bounds.maxX - 0.01, p.x)),
    y: Math.max(bounds.minY + 0.01, Math.min(bounds.maxY - 0.01, p.y)),
  }))
}

/** Minimum distance between two convex polygons (edge-to-edge). */
function polyPolyDist(
  a: { x: number; y: number }[],
  b: { x: number; y: number }[],
): number {
  let best = Infinity
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i]!, a2 = a[(i + 1) % a.length]!
    for (let j = 0; j < b.length; j++) {
      const b1 = b[j]!, b2 = b[(j + 1) % b.length]!
      best = Math.min(best, segSegDist(a1, a2, b1, b2))
    }
  }
  return best
}

/** Minimum distance between two line segments. */
function segSegDist(
  p1: { x: number; y: number }, p2: { x: number; y: number },
  p3: { x: number; y: number }, p4: { x: number; y: number },
): number {
  return Math.min(
    ptSegDist(p1, p3, p4),
    ptSegDist(p2, p3, p4),
    ptSegDist(p3, p1, p2),
    ptSegDist(p4, p1, p2),
  )
}

/** Distance from point p to segment a-b. */
function ptSegDist(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

// ─── Debug state ─────────────────────────────────────────────────────

export const meshDebug = {
  lastMeshObstacles: 0,
  lastRerouteAttempts: 0,
  lastRerouteSuccesses: 0,
  lastError: "",
  frameCount: 0,
  lastObstaclePolygons: [] as Array<{ x: number; y: number }[]>,
  lastMeshPolygons: [] as Array<{ vertices: { x: number; y: number }[]; blocked: boolean; obstacleIndex: number }>,
  autorouterBaseObstacles: [] as Array<{ x: number; y: number }[]>,
  autorouterTraceObstacles: [] as Array<{ x: number; y: number }[]>,
  autorouterMeshPolygons: [] as Array<{ vertices: { x: number; y: number }[]; blocked: boolean; obstacleIndex: number }>,
  lastCdtRegions: 0,
  lastRawMeshPolygons: 0,
  lastMergedPolygons: 0,
}

export function invalidateAllMeshes() {}
export function invalidateLayerMesh(_layer: string) {}

// ─── Mesh building ───────────────────────────────────────────────────

/** Extract debug visualization data from an already-built mesh + obstacles. */
function updateDebugData(mesh: any, obstacles: Array<{ x: number; y: number }[]>) {
  meshDebug.lastObstaclePolygons = obstacles
  meshDebug.lastMeshPolygons = mesh.polygons.map((poly: any) => ({
    vertices: poly.vertices.map((vi: number) => ({
      x: mesh.vertices[vi].p.x,
      y: mesh.vertices[vi].p.y,
    })),
    blocked: false,
    obstacleIndex: -1,
  }))
}

/**
 * Build a debug mesh only if routeAllTraces hasn't already populated it
 * (e.g. when no traces are routed yet but debug view is on).
 */
export function buildDebugMesh(
  layer: string,
  board: BoardData,
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
  _routedTraces: Map<string, RoutedTrace>,
) {
  // If routeAllTraces already ran this frame, debug data is up to date
  if (meshDebug.lastObstaclePolygons.length > 0) return

  const { mesh, obstacles } = buildPadOnlyMesh(layer, board, components, placements)
  if (mesh) updateDebugData(mesh, obstacles)
}

/**
 * Build a single navigation mesh from ALL pad obstacles.
 * Uses precomputed per-pad clearance (same-component edge-to-edge gaps).
 */
function buildPadOnlyMesh(
  layer: string,
  board: BoardData,
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
): { mesh: any; obstacles: Array<{ x: number; y: number }[]> } {
  const halfW = board.width / 2
  const halfH = board.height / 2
  const bounds = { minX: -halfW - 1, maxX: halfW + 1, minY: -halfH - 1, maxY: halfH + 1 }

  const obstacles: Array<{ x: number; y: number }[]> = []

  for (const [compId, comp] of components) {
    const placement = placements.get(compId)
    if (!placement) continue

    const rad = (placement.rotation * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const clearances = getPadClearances(comp)

    for (const pad of comp.pads) {
      const padLayers = pad.layers || [pad.layer]
      if (!padLayers.includes(layer)) continue

      const wx = placement.x + pad.localX * cos - pad.localY * sin
      const wy = placement.y + pad.localX * sin + pad.localY * cos
      const clearance = clearances.get(pad.id) ?? PAD_CLEARANCE

      let poly = rotatedRectPolygon(wx, wy, pad.width, pad.height, rad, clearance)
      poly = clipObstacleToBounds(poly, bounds)
      obstacles.push(poly)
    }
  }

  try {
    meshDebug.lastMeshObstacles = obstacles.length
    const cdtResult = cdtTriangulate({ bounds, obstacles })
    meshDebug.lastCdtRegions = cdtResult.regions.length

    if (cdtResult.regions.length === 0) {
      console.warn(`[meshManager] CDT produced 0 regions from ${obstacles.length} obstacles — CDT failed`)
      return { mesh: null, obstacles }
    }

    const rawMesh = buildMeshFromRegions(cdtResult)
    meshDebug.lastRawMeshPolygons = rawMesh.polygons.length
    const mesh = mergeMesh(rawMesh)
    meshDebug.lastMergedPolygons = mesh.polygons.length

    if (mesh.polygons.length <= 5 && obstacles.length > 5) {
      console.warn(
        `[meshManager] Mesh collapsed: ${obstacles.length} obstacles → ` +
        `${cdtResult.regions.length} CDT regions → ${rawMesh.polygons.length} raw polys → ` +
        `${mesh.polygons.length} merged polys`
      )
    }

    return { mesh, obstacles }
  } catch (e) {
    meshDebug.lastError = `mesh build failed: ${e}`
    return { mesh: null, obstacles }
  }
}

// ─── Point snapping ──────────────────────────────────────────────────

/**
 * Snap a point that's inside an obstacle (off-mesh) to the nearest
 * navigable point on the mesh boundary.
 */
function snapToMesh(mesh: any, p: Point): Point | null {
  let bestDist = Infinity
  let bestPoint: Point | null = null

  for (const poly of mesh.polygons) {
    const verts: number[] = poly.vertices
    for (let i = 0; i < verts.length; i++) {
      const ai = verts[i]!
      const bi = verts[(i + 1) % verts.length]!
      const a = mesh.vertices[ai].p
      const b = mesh.vertices[bi].p

      const dx = b.x - a.x
      const dy = b.y - a.y
      const lenSq = dx * dx + dy * dy
      if (lenSq < 1e-12) continue

      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq
      t = Math.max(0, Math.min(1, t))

      const proj = { x: a.x + t * dx, y: a.y + t * dy }
      const dist = Math.hypot(proj.x - p.x, proj.y - p.y)
      if (dist < bestDist) {
        bestDist = dist
        bestPoint = proj
      }
    }
  }

  return bestPoint
}

/** If the point is on the mesh, return it. Otherwise snap to nearest mesh edge. */
function resolveOrSnap(mesh: any, p: Point): Point | null {
  const loc = mesh.getPointLocation(p)
  if (loc.type !== PointLocationType.NOT_ON_MESH) return p
  return snapToMesh(mesh, p)
}

// ─── Pathfinding ─────────────────────────────────────────────────────

/**
 * Find a path between two points on a pad-only mesh.
 */
export function findPath(
  layer: string,
  start: Point,
  goal: Point,
  board: BoardData,
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
  routedTraces: Map<string, RoutedTrace>,
  excludeConnectionId?: string,
  excludePadIds?: string[],
): Point[] | null {
  const { mesh } = buildPadOnlyMesh(layer, board, components, placements)
  if (!mesh) return null

  try {
    const si = new SearchInstance(mesh)
    const s = resolveOrSnap(mesh, start)
    const g = resolveOrSnap(mesh, goal)
    if (!s || !g) return null

    si.setStartGoal(s, g)
    const found = si.search()
    if (!found) return null

    const path = si.getPathPoints()
    if (s !== start || g !== goal) {
      const result: Point[] = []
      if (s !== start) result.push(start)
      result.push(...path)
      if (g !== goal) result.push(goal)
      return result
    }
    return path
  } catch (e: any) {
    meshDebug.lastError = `exception: ${e.message?.slice(0, 80) || e}`
    return null
  }
}

/**
 * Route ALL connections on a single pad-only mesh.
 * Builds ONE CDT from all pad footprints, then runs Polyanya for every connection.
 * Points inside obstacles are snapped to the nearest mesh edge.
 */
export function routeAllTraces(
  board: BoardData,
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
  connections: ConnectionData[],
): { traces: Map<string, RoutedTrace>; unrouted: Set<string> } {
  const traces = new Map<string, RoutedTrace>()
  const unrouted = new Set<string>()
  meshDebug.lastError = ""
  meshDebug.lastObstaclePolygons = [] // reset so buildDebugMesh knows if we populated it
  meshDebug.frameCount++

  const t0 = performance.now()

  // Build ONE mesh per layer
  const meshCache = new Map<string, { mesh: any; obstacles: any[] }>()
  function getMesh(layer: string) {
    if (meshCache.has(layer)) return meshCache.get(layer)!
    const result = buildPadOnlyMesh(layer, board, components, placements)
    meshCache.set(layer, result)
    // Populate debug data from the first mesh we build (usually "top")
    if (result.mesh) updateDebugData(result.mesh, result.obstacles)
    return result
  }

  const tMesh = performance.now()

  let attempts = 0
  let successes = 0
  let failNoMesh = 0
  let failNoSnap = 0
  let failNoPath = 0
  let failDiffIsland = 0
  let failException = 0

  for (const conn of connections) {
    if (conn.endpoints.length < 2) {
      unrouted.add(conn.id)
      continue
    }

    attempts++

    const ep1 = conn.endpoints[0]!
    const ep2 = conn.endpoints[conn.endpoints.length - 1]!

    const startRaw = getWorldPadPosition(components, placements, ep1.componentId, ep1.padId)
    const goalRaw = getWorldPadPosition(components, placements, ep2.componentId, ep2.padId)
    if (!startRaw || !goalRaw) {
      unrouted.add(conn.id)
      continue
    }

    const layer = ep1.layer || "top"
    const { mesh } = getMesh(layer)

    if (!mesh) {
      failNoMesh++
      unrouted.add(conn.id)
      continue
    }

    const start = resolveOrSnap(mesh, startRaw)
    const goal = resolveOrSnap(mesh, goalRaw)
    if (!start || !goal) {
      failNoSnap++
      unrouted.add(conn.id)
      continue
    }

    try {
      const startLoc = mesh.getPointLocation(start)
      const goalLoc = mesh.getPointLocation(goal)
      if (startLoc.poly1 >= 0 && goalLoc.poly1 >= 0 &&
          !mesh.sameIsland(startLoc.poly1, goalLoc.poly1)) {
        failDiffIsland++
        unrouted.add(conn.id)
        continue
      }

      const si = new SearchInstance(mesh)
      si.setStartGoal(start, goal)
      const found = si.search()

      if (found) {
        const pathCore = si.getPathPoints()
        if (pathCore && pathCore.length >= 2) {
          const path: Point[] = []
          if (start !== startRaw) path.push(startRaw)
          path.push(...pathCore)
          if (goal !== goalRaw) path.push(goalRaw)

          successes++
          traces.set(conn.id, {
            connectionId: conn.id,
            segments: [{
              points: path,
              layer,
              width: 0.15,
            }],
            vias: [],
          })
          continue
        }
      }
      failNoPath++
    } catch (e: any) {
      failException++
      meshDebug.lastError = `route ${conn.id}: ${e.message?.slice(0, 60) || e}`
    }

    unrouted.add(conn.id)
  }

  const tDone = performance.now()

  meshDebug.lastRerouteAttempts = attempts
  meshDebug.lastRerouteSuccesses = successes

  if (meshDebug.frameCount <= 2 || meshDebug.frameCount % 60 === 0) {
    const meshMs = (tMesh - t0).toFixed(1)
    const searchMs = (tDone - tMesh).toFixed(1)
    const totalMs = (tDone - t0).toFixed(1)
    const layers = [...meshCache.keys()]
    const polyCount = layers.map(l => meshCache.get(l)?.mesh?.polygons?.length ?? 0)
    console.log(
      `[meshManager] ${successes}/${attempts} routed | ` +
      `mesh: ${meshMs}ms (${meshDebug.lastCdtRegions} CDT→${meshDebug.lastRawMeshPolygons} raw→${polyCount.join("/")} merged) | ` +
      `search: ${searchMs}ms | total: ${totalMs}ms | ` +
      `fail: noMesh=${failNoMesh} noSnap=${failNoSnap} island=${failDiffIsland} noPath=${failNoPath} exc=${failException}`
    )
  }

  return { traces, unrouted }
}

/**
 * Legacy compat — reroute traces for a specific component.
 * Now just routes all traces (simplified approach).
 */
export function rerouteComponentTraces(
  _componentId: string,
  board: BoardData,
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
  connections: ConnectionData[],
  _routedTraces: Map<string, RoutedTrace>,
): Map<string, RoutedTrace> | null {
  const { traces } = routeAllTraces(board, components, placements, connections)
  return traces.size > 0 ? traces : null
}
