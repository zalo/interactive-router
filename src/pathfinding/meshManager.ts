/**
 * Simplified mesh manager: builds ONE navigation mesh from pad obstacles,
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
import { PointLocationType } from "../lib/polyanya/types"

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
  const { mesh, obstacles } = buildPadOnlyMesh(layer, board, components, placements)
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
 * Build a single navigation mesh from ALL pad obstacles.
 * No per-connection exclusion — one mesh for everything.
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

    for (const pad of comp.pads) {
      const padLayers = pad.layers || [pad.layer]
      if (!padLayers.includes(layer)) continue

      const wx = placement.x + pad.localX * cos - pad.localY * sin
      const wy = placement.y + pad.localX * sin + pad.localY * cos

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
 * Snap a point that's inside an obstacle (off-mesh) to the nearest
 * navigable point on the mesh boundary.
 * Scans all mesh polygon edges and finds the closest projection.
 */
function snapToMesh(mesh: any, p: Point): Point | null {
  let bestDist = Infinity
  let bestPoint: Point | null = null

  for (const poly of mesh.polygons) {
    const verts: number[] = poly.vertices
    for (let i = 0; i < verts.length; i++) {
      const adjPoly = poly.polygons[i]
      // Only consider boundary edges (adjacent to -1) or any edge really —
      // we just need the nearest point on any traversable polygon edge
      const ai = verts[i]!
      const bi = verts[(i + 1) % verts.length]!
      const a = mesh.vertices[ai].p
      const b = mesh.vertices[bi].p

      // Project p onto segment a-b
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
    // Prepend/append original points if we snapped
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
 * If the point is on the mesh, return it as-is.
 * If it's off-mesh (inside an obstacle), snap to nearest mesh edge.
 */
function resolveOrSnap(mesh: any, p: Point): Point | null {
  const loc = mesh.getPointLocation(p)
  if (loc.type !== PointLocationType.NOT_ON_MESH) return p // it's on the mesh
  return snapToMesh(mesh, p)
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
  meshDebug.frameCount++

  const t0 = performance.now()

  // Build ONE mesh for each layer (most boards: just "top")
  const meshCache = new Map<string, { mesh: any; obstacles: any[] }>()
  function getMesh(layer: string) {
    if (meshCache.has(layer)) return meshCache.get(layer)!
    const result = buildPadOnlyMesh(layer, board, components, placements)
    meshCache.set(layer, result)
    return result
  }

  const tMesh = performance.now()

  let attempts = 0
  let successes = 0
  let failNoMesh = 0
  let failNoSnap = 0
  let failNoPath = 0
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

    // Snap start/goal to mesh if they're inside obstacles
    const start = resolveOrSnap(mesh, startRaw)
    const goal = resolveOrSnap(mesh, goalRaw)
    if (!start || !goal) {
      failNoSnap++
      unrouted.add(conn.id)
      continue
    }

    try {
      const si = new SearchInstance(mesh)
      si.setStartGoal(start, goal)
      const found = si.search()

      if (found) {
        const pathCore = si.getPathPoints()
        if (pathCore && pathCore.length >= 2) {
          // Prepend/append original pad positions if we snapped
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

  // Log diagnostics (only on first call or when not dragging to avoid spam)
  if (meshDebug.frameCount <= 2 || meshDebug.frameCount % 60 === 0) {
    const meshMs = (tMesh - t0).toFixed(1)
    const searchMs = (tDone - tMesh).toFixed(1)
    const totalMs = (tDone - t0).toFixed(1)
    const layers = [...meshCache.keys()]
    const polyCount = layers.map(l => meshCache.get(l)?.mesh?.polygons?.length ?? 0)
    console.log(
      `[meshManager] ${successes}/${attempts} routed | ` +
      `mesh: ${meshMs}ms (${polyCount.join("/")} polys) | search: ${searchMs}ms | total: ${totalMs}ms | ` +
      `fail: noMesh=${failNoMesh} noSnap=${failNoSnap} noPath=${failNoPath} exception=${failException}`
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
