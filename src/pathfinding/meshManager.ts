/**
 * Per-layer navigation mesh manager for interactive routing.
 * Builds CDT meshes from pad obstacles, caches them, and provides
 * fast polyanya pathfinding queries.
 */

import type { ComponentData, PlacementState, RoutedTrace, BoardData, Point } from "../types"
import { cdtTriangulate, rectToPolygon } from "polyanya"
import { buildMeshFromRegions } from "polyanya"
import { mergeMesh } from "polyanya"
import { SearchInstance } from "polyanya"

interface LayerMesh {
  mesh: any // Mesh from polyanya
  dirty: boolean
}

const layerMeshes = new Map<string, LayerMesh>()
const TRACE_CLEARANCE = 0.15 // mm clearance around routed traces
const PAD_CLEARANCE = 0.15   // mm clearance around pads (must be >= trace half-width)

/** Debug status visible on the overlay */
export const meshDebug = {
  lastMeshObstacles: 0,
  lastRerouteAttempts: 0,
  lastRerouteSuccesses: 0,
  lastError: "",
  frameCount: 0,
}

export function invalidateAllMeshes() {
  for (const lm of layerMeshes.values()) lm.dirty = true
}

export function invalidateLayerMesh(layer: string) {
  const lm = layerMeshes.get(layer)
  if (lm) lm.dirty = true
}

/**
 * Build or rebuild the navigation mesh for a given layer.
 * Obstacles = pads on this layer + routed trace segments on this layer.
 * The mesh is cached and only rebuilt when marked dirty.
 */
export function ensureMesh(
  layer: string,
  board: BoardData,
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
  routedTraces: Map<string, RoutedTrace>,
  excludeConnectionId?: string,
): any {
  const existing = layerMeshes.get(layer)
  if (existing && !existing.dirty) return existing.mesh

  const halfW = board.width / 2
  const halfH = board.height / 2
  const bounds = { minX: -halfW - 1, maxX: halfW + 1, minY: -halfH - 1, maxY: halfH + 1 }

  const obstacles: Array<{ x: number; y: number }[]> = []

  // Add pad obstacles on this layer
  for (const [compId, comp] of components) {
    const placement = placements.get(compId)
    if (!placement) continue

    const rad = (placement.rotation * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)

    for (const pad of comp.pads) {
      const padLayers = pad.layers || [pad.layer]
      if (!padLayers.includes(layer)) continue

      const wx = placement.x + pad.localX * cos - pad.localY * sin
      const wy = placement.y + pad.localX * sin + pad.localY * cos

      obstacles.push(rectToPolygon(wx, wy, pad.width, pad.height, PAD_CLEARANCE))
    }
  }

  // Add routed trace segments as obstacles on this layer
  for (const [connId, trace] of routedTraces) {
    if (connId === excludeConnectionId) continue

    for (const seg of trace.segments) {
      if (seg.layer !== layer) continue
      // Expand each segment of the polyline into a rectangle obstacle
      for (let i = 0; i < seg.points.length - 1; i++) {
        const p1 = seg.points[i]
        const p2 = seg.points[i + 1]
        const cx = (p1.x + p2.x) / 2
        const cy = (p1.y + p2.y) / 2
        const dx = p2.x - p1.x
        const dy = p2.y - p1.y
        const len = Math.sqrt(dx * dx + dy * dy)
        if (len < 0.01) continue
        // Approximate as axis-aligned rect (conservative)
        const w = Math.abs(dx) + seg.width
        const h = Math.abs(dy) + seg.width
        obstacles.push(rectToPolygon(cx, cy, w, h, TRACE_CLEARANCE))
      }
    }
  }

  try {
    meshDebug.lastMeshObstacles = obstacles.length
    const cdtResult = cdtTriangulate({ bounds, obstacles })
    const rawMesh = buildMeshFromRegions(cdtResult)
    const mesh = mergeMesh(rawMesh)

    layerMeshes.set(layer, { mesh, dirty: false })
    return mesh
  } catch (e) {
    console.warn(`[mesh] Failed to build mesh for layer ${layer}:`, e)
    return null
  }
}

/**
 * Find a path between two points on a given layer using polyanya.
 * Returns the path points or null if no path found.
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
): Point[] | null {
  const mesh = ensureMesh(layer, board, components, placements, routedTraces, excludeConnectionId)
  if (!mesh) return null

  try {
    const si = new SearchInstance(mesh)
    si.setStartGoal(start, goal)
    const found = si.search()
    if (!found) {
      const startLoc = mesh.getPointLocation(start)
      const goalLoc = mesh.getPointLocation(goal)
      const startBlocked = startLoc.poly1 >= 0 ? mesh.polygons[startLoc.poly1]?.blocked : "N/A"
      const goalBlocked = goalLoc.poly1 >= 0 ? mesh.polygons[goalLoc.poly1]?.blocked : "N/A"
      const startObs = startLoc.poly1 >= 0 ? mesh.polygons[startLoc.poly1]?.obstacleIndex : -1
      const goalObs = goalLoc.poly1 >= 0 ? mesh.polygons[goalLoc.poly1]?.obstacleIndex : -1
      const polyanyaDebug = (si as any)._lastDebug || ""
      meshDebug.lastError = `FAIL s=(${start.x.toFixed(1)},${start.y.toFixed(1)}) p=${startLoc.poly1} b=${startBlocked} o=${startObs} | g=(${goal.x.toFixed(1)},${goal.y.toFixed(1)}) p=${goalLoc.poly1} b=${goalBlocked} o=${goalObs} | ${polyanyaDebug}`
      return null
    }
    return si.getPathPoints()
  } catch (e: any) {
    meshDebug.lastError = `exception: ${e.message?.slice(0, 80) || e}`
    return null
  }
}

/**
 * Reroute all traces connected to a specific component.
 * Used during component drag to update traces live.
 */
export function rerouteComponentTraces(
  componentId: string,
  board: BoardData,
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
  connections: any[],
  routedTraces: Map<string, RoutedTrace>,
): Map<string, RoutedTrace> | null {
  // Only create a new map if we actually change something
  let updatedTraces: Map<string, RoutedTrace> | null = null
  let rerouteCount = 0
  let successCount = 0
  meshDebug.lastError = ""
  meshDebug.frameCount++

  // Find all connections that touch this component
  for (const conn of connections) {
    const touchesComponent = conn.endpoints.some((ep: any) => ep.componentId === componentId)
    if (!touchesComponent) continue

    const existingTrace = routedTraces.get(conn.id)
    if (!existingTrace) continue
    rerouteCount++

    // Get the two endpoints of this connection in world space
    if (conn.endpoints.length < 2) continue
    const ep1 = conn.endpoints[0]
    const ep2 = conn.endpoints[conn.endpoints.length - 1]

    const comp1 = components.get(ep1.componentId)
    const comp2 = components.get(ep2.componentId)
    const pl1 = placements.get(ep1.componentId)
    const pl2 = placements.get(ep2.componentId)
    if (!comp1 || !comp2 || !pl1 || !pl2) continue

    const pad1 = comp1.pads.find((p) => p.id === ep1.padId)
    const pad2 = comp2.pads.find((p) => p.id === ep2.padId)
    if (!pad1 || !pad2) continue

    const rad1 = (pl1.rotation * Math.PI) / 180
    const rad2 = (pl2.rotation * Math.PI) / 180
    const start: Point = {
      x: pl1.x + pad1.localX * Math.cos(rad1) - pad1.localY * Math.sin(rad1),
      y: pl1.y + pad1.localX * Math.sin(rad1) + pad1.localY * Math.cos(rad1),
    }
    const goal: Point = {
      x: pl2.x + pad2.localX * Math.cos(rad2) - pad2.localY * Math.sin(rad2),
      y: pl2.y + pad2.localX * Math.sin(rad2) + pad2.localY * Math.cos(rad2),
    }

    // Try to reroute on the same layer as the first segment
    // (straight-line fallback if polyanya fails)
    const layer = existingTrace.segments[0]?.layer || ep1.layer || "top"

    invalidateLayerMesh(layer)

    meshDebug.lastError = `trying ${conn.name}: (${start.x.toFixed(1)},${start.y.toFixed(1)})->(${goal.x.toFixed(1)},${goal.y.toFixed(1)}) layer=${layer}`

    const path = findPath(layer, start, goal, board, components, placements, updatedTraces ?? routedTraces, conn.id)

    if (path && path.length >= 2) {
      successCount++
      if (!updatedTraces) updatedTraces = new Map(routedTraces)
      updatedTraces.set(conn.id, {
        connectionId: conn.id,
        segments: [{
          points: path,
          layer,
          width: existingTrace.segments[0]?.width || 0.15,
        }],
        vias: [],
      })
    }
    // If polyanya fails, DON'T touch the trace — keep old route
  }

  meshDebug.lastRerouteAttempts = rerouteCount
  meshDebug.lastRerouteSuccesses = successCount

  // Return null if nothing changed (caller should NOT call setRoutedTraces)
  return updatedTraces
}
