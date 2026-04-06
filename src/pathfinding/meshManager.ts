/**
 * Simplified mesh manager: builds ONE navigation mesh from pad obstacles only,
 * then routes all connections via Polyanya with no regard for trace overlap.
 *
 * On component move → rebake CDT from pad footprints → merge convex regions → route all traces.
 */

import type { ComponentData, PlacementState, RoutedTrace, BoardData, Point, ConnectionData } from "../types"
import { cdtTriangulate } from "../lib/polyanya/index"
import { buildMeshFromRegions } from "../lib/polyanya/index"
import { mergeMesh } from "../lib/polyanya/index"
import { SearchInstance } from "../lib/polyanya/index"
import { getWorldPadPosition } from "../state/store"

const PAD_CLEARANCE = 0.15 // mm clearance around pads

/** Create a rotated rectangle polygon (4 corners CCW) */
function rotatedRectPolygon(
  cx: number, cy: number, w: number, h: number,
  rotation: number, clearance: number,
): { x: number; y: number }[] {
  const hw = w / 2 + clearance
  const hh = h / 2 + clearance
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  // Local corners, then rotate + translate
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
export function invalidateLayerMesh(_layer: string) {}

/** Force build a mesh for debug viewing */
export function buildDebugMesh(
  layer: string,
  board: BoardData,
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
  _routedTraces: Map<string, RoutedTrace>,
) {
  const { mesh, obstacles } = buildPadOnlyMesh(layer, board, components, placements, new Set())
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
 * Build a navigation mesh from pad obstacles only — no trace corridors.
 * Excludes specific pad IDs so the pathfinder can reach start/end points.
 */
function buildPadOnlyMesh(
  layer: string,
  board: BoardData,
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
  excludePadIds: Set<string>,
): { mesh: any; obstacles: Array<{ x: number; y: number }[]> } {
  const halfW = board.width / 2
  const halfH = board.height / 2
  const bounds = { minX: -halfW - 1, maxX: halfW + 1, minY: -halfH - 1, maxY: halfH + 1 }

  const obstacles: Array<{ x: number; y: number }[]> = []

  // Only pad obstacles — no trace corridors, with proper rotation
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

      // World position of pad center (rotated by component rotation)
      const wx = placement.x + pad.localX * cos - pad.localY * sin
      const wy = placement.y + pad.localX * sin + pad.localY * cos

      // Rotated pad obstacle — inherits component rotation
      obstacles.push(rotatedRectPolygon(wx, wy, pad.width, pad.height, rad, PAD_CLEARANCE))
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
  const { mesh } = buildPadOnlyMesh(
    layer, board, components, placements,
    new Set(excludePadIds || []),
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
 * Route ALL connections on a single pad-only mesh.
 * Builds one CDT per layer from pad footprints, then runs Polyanya for every connection.
 * No trace obstacles, no incremental rebuilds — just pure shortest paths.
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
  meshDebug.frameCount++

  // Cache meshes per layer so we only build once per layer
  const meshCache = new Map<string, any>()

  function getMesh(layer: string, excludePadIds: Set<string>): any {
    // Build a mesh excluding the connection's own pads so pathfinder can reach them
    // Cache key includes excluded pads since different connections exclude different pads
    const cacheKey = `${layer}:${[...excludePadIds].sort().join(",")}`
    if (meshCache.has(cacheKey)) return meshCache.get(cacheKey)

    const { mesh } = buildPadOnlyMesh(layer, board, components, placements, excludePadIds)
    meshCache.set(cacheKey, mesh)
    return mesh
  }

  let attempts = 0
  let successes = 0

  for (const conn of connections) {
    if (conn.endpoints.length < 2) {
      unrouted.add(conn.id)
      continue
    }

    attempts++

    const ep1 = conn.endpoints[0]!
    const ep2 = conn.endpoints[conn.endpoints.length - 1]!

    const start = getWorldPadPosition(components, placements, ep1.componentId, ep1.padId)
    const goal = getWorldPadPosition(components, placements, ep2.componentId, ep2.padId)
    if (!start || !goal) {
      unrouted.add(conn.id)
      continue
    }

    const layer = ep1.layer || "top"
    const excludePads = new Set([ep1.padId, ep2.padId])
    const mesh = getMesh(layer, excludePads)

    if (!mesh) {
      unrouted.add(conn.id)
      continue
    }

    try {
      const si = new SearchInstance(mesh)
      si.setStartGoal(start, goal)
      const found = si.search()

      if (found) {
        const path = si.getPathPoints()
        if (path && path.length >= 2) {
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
    } catch (e: any) {
      meshDebug.lastError = `route ${conn.id}: ${e.message?.slice(0, 60) || e}`
    }

    unrouted.add(conn.id)
  }

  meshDebug.lastRerouteAttempts = attempts
  meshDebug.lastRerouteSuccesses = successes

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
