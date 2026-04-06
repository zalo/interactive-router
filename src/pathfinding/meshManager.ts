/**
 * Per-layer navigation mesh manager for interactive routing.
 * Uses CDT mesh EXCLUSION (not obstacle toggling) — rebuilds the mesh
 * for each query, excluding the start/end pad obstacles so the pathfinder
 * can reach them. Other routed traces remain as obstacles.
 */

import type { ComponentData, PlacementState, RoutedTrace, BoardData, Point, ConnectionData } from "../types"
import { cdtTriangulate, rectToPolygon } from "../lib/polyanya/index"
import { buildMeshFromRegions } from "../lib/polyanya/index"
import { mergeMesh } from "../lib/polyanya/index"
import { SearchInstance } from "../lib/polyanya/index"

const PAD_CLEARANCE = 0.15 // mm clearance around pads

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
}

export function invalidateAllMeshes() {}
export function invalidateLayerMesh(layer: string) {}

/** Force build a mesh for debug viewing */
export function buildDebugMesh(
  layer: string,
  board: BoardData,
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
  routedTraces: Map<string, RoutedTrace>,
) {
  const { mesh, obstacles } = buildMeshForLayer(layer, board, components, placements, routedTraces, new Set())
  if (mesh) {
    meshDebug.lastObstaclePolygons = obstacles
    meshDebug.lastMeshPolygons = mesh.polygons.map((poly: any) => ({
      vertices: poly.vertices.map((vi: number) => ({
        x: mesh.vertices[vi].p.x,
        y: mesh.vertices[vi].p.y,
      })),
      blocked: poly.blocked,
      obstacleIndex: poly.obstacleIndex,
    }))
  }
}

/**
 * Build a navigation mesh for a layer, excluding specific pad IDs.
 * Returns both the mesh and the obstacle list (for debug rendering).
 */
function buildMeshForLayer(
  layer: string,
  board: BoardData,
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
  routedTraces: Map<string, RoutedTrace>,
  excludePadIds: Set<string>,
  excludeConnectionId?: string,
): { mesh: any; obstacles: Array<{ x: number; y: number }[]> } {
  const halfW = board.width / 2
  const halfH = board.height / 2
  const bounds = { minX: -halfW - 1, maxX: halfW + 1, minY: -halfH - 1, maxY: halfH + 1 }

  const obstacles: Array<{ x: number; y: number }[]> = []

  // Add pad obstacles on this layer (excluding specified pads)
  for (const [compId, comp] of components) {
    const placement = placements.get(compId)
    if (!placement) continue

    const rad = (placement.rotation * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)

    for (const pad of comp.pads) {
      if (excludePadIds.has(pad.id)) continue

      const padLayers = pad.layers || [pad.layer]
      if (!padLayers.includes(layer)) continue

      const wx = placement.x + pad.localX * cos - pad.localY * sin
      const wy = placement.y + pad.localX * sin + pad.localY * cos

      obstacles.push(rectToPolygon(wx, wy, pad.width, pad.height, PAD_CLEARANCE))
    }
  }

  // Add routed trace segments as obstacles (excluding the connection being rerouted).
  // Use proper oriented polygons (not bounding boxes).
  for (const [connId, trace] of routedTraces) {
    if (connId === excludeConnectionId) continue

    for (const seg of trace.segments) {
      if (seg.layer !== layer) continue
      if (seg.points.length < 2) continue

      const tracePolys = pathToObstaclePolygons(seg.points, seg.width / 2 + PAD_CLEARANCE)
      obstacles.push(...tracePolys)
    }
  }

  try {
    meshDebug.lastMeshObstacles = obstacles.length
    const cdtResult = cdtTriangulate({ bounds, obstacles })
    const rawMesh = buildMeshFromRegions(cdtResult)
    const mesh = mergeMesh(rawMesh)
    return { mesh, obstacles }
  } catch (e) {
    meshDebug.lastError = `mesh build failed: ${e}`
    return { mesh: null, obstacles }
  }
}

/**
 * Convert a polyline path into oriented obstacle polygons (proper corridors).
 * Same approach as the autorouter's pathToObstaclePolygons.
 */
function pathToObstaclePolygons(path: Point[], clearance: number): Array<{ x: number; y: number }[]> {
  if (path.length < 2) return []

  // Deduplicate
  const pts: Point[] = [path[0]!]
  for (let i = 1; i < path.length; i++) {
    const prev = pts[pts.length - 1]!
    const cur = path[i]!
    if (Math.abs(cur.x - prev.x) > 1e-9 || Math.abs(cur.y - prev.y) > 1e-9) {
      pts.push(cur)
    }
  }
  if (pts.length < 2) return []

  // For each segment, create an oriented rectangle (corridor)
  const polys: Array<{ x: number; y: number }[]> = []
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!
    const b = pts[i + 1]!
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    if (len < 1e-9) continue

    const nx = -dy / len * clearance
    const ny = dx / len * clearance

    polys.push([
      { x: a.x + nx, y: a.y + ny },
      { x: b.x + nx, y: b.y + ny },
      { x: b.x - nx, y: b.y - ny },
      { x: a.x - nx, y: a.y - ny },
    ])
  }
  return polys
}

/**
 * Find a path between two points, building a fresh CDT mesh with
 * the start/end pads excluded from obstacles.
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
  const { mesh } = buildMeshForLayer(
    layer, board, components, placements, routedTraces,
    new Set(excludePadIds || []),
    excludeConnectionId,
  )
  if (!mesh) return null

  try {
    const si = new SearchInstance(mesh)
    si.setStartGoal(start, goal)
    const found = si.search()
    if (!found) {
      meshDebug.lastError = `search failed: (${start.x.toFixed(1)},${start.y.toFixed(1)})->(${goal.x.toFixed(1)},${goal.y.toFixed(1)})`
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
 * For each trace, builds a fresh CDT mesh excluding:
 * - The start/end pads of that connection
 * - The connection's own trace (but keeps all other traces as obstacles)
 */
export function rerouteComponentTraces(
  componentId: string,
  board: BoardData,
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
  connections: ConnectionData[],
  routedTraces: Map<string, RoutedTrace>,
): Map<string, RoutedTrace> | null {
  let updatedTraces: Map<string, RoutedTrace> | null = null
  let rerouteCount = 0
  let successCount = 0
  meshDebug.lastError = ""
  meshDebug.frameCount++

  for (const conn of connections) {
    const touchesComponent = conn.endpoints.some((ep: any) => ep.componentId === componentId)
    if (!touchesComponent) continue

    const existingTrace = routedTraces.get(conn.id)
    if (!existingTrace) continue
    rerouteCount++

    if (conn.endpoints.length < 2) continue
    const ep1 = conn.endpoints[0]!
    const ep2 = conn.endpoints[conn.endpoints.length - 1]!

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

    const layer = existingTrace.segments[0]?.layer || ep1.layer || "top"

    // Build fresh mesh excluding start/end pads AND this connection's traces,
    // but keeping all other traces as obstacles
    const path = findPath(
      layer, start, goal, board, components, placements,
      updatedTraces ?? routedTraces,
      conn.id, // exclude this connection's trace obstacles
      [ep1.padId, ep2.padId], // exclude start/end pads
    )

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
  }

  meshDebug.lastRerouteAttempts = rerouteCount
  meshDebug.lastRerouteSuccesses = successCount

  return updatedTraces
}
