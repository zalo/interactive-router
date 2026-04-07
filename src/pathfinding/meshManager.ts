/**
 * Simplified mesh manager: builds ONE navigation mesh from pad obstacles,
 * then routes all connections via Polyanya with no regard for trace overlap.
 *
 * On component move → rebake CDT from pad footprints → merge convex regions → route all traces.
 */

import type { ComponentData, PlacementState, RoutedTrace, BoardData, Point, ConnectionData, ConnectionEndpoint, PadData } from "../types"
import { cdtTriangulate } from "../lib/polyanya/index"
import { buildMeshFromRegions } from "../lib/polyanya/index"
import { mergeMesh } from "../lib/polyanya/index"
import { SearchInstance } from "../lib/polyanya/index"
import { getWorldPadPosition } from "../state/store"

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
    blocked: poly.obstacleIndex >= 0,
    obstacleIndex: poly.obstacleIndex,
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

interface MeshResult {
  mesh: any
  obstacles: Array<{ x: number; y: number }[]>
  /** Maps padId → obstacle index in the CDT */
  padIdToObstacle: Map<string, number>
  /** Maps componentId → all obstacle indices for that component's pads */
  compIdToObstacles: Map<string, number[]>
}

/**
 * Build a single navigation mesh from ALL pad obstacles.
 * Obstacle interiors are triangulated and tagged with per-obstacle IDs.
 * Uses precomputed per-pad clearance (same-component edge-to-edge gaps).
 */
function buildPadOnlyMesh(
  layer: string,
  board: BoardData,
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
): MeshResult {
  const halfW = board.width / 2
  const halfH = board.height / 2
  const bounds = { minX: -halfW - 1, maxX: halfW + 1, minY: -halfH - 1, maxY: halfH + 1 }

  const obstacles: Array<{ x: number; y: number }[]> = []
  const padIdToObstacle = new Map<string, number>()
  const compIdToObstacles = new Map<string, number[]>()

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

      const obstacleIdx = obstacles.length
      padIdToObstacle.set(pad.id, obstacleIdx)

      if (!compIdToObstacles.has(compId)) compIdToObstacles.set(compId, [])
      compIdToObstacles.get(compId)!.push(obstacleIdx)

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
      return { mesh: null, obstacles, padIdToObstacle, compIdToObstacles }
    }

    const rawMesh = buildMeshFromRegions(cdtResult)
    meshDebug.lastRawMeshPolygons = rawMesh.polygons.length
    const mesh = mergeMesh(rawMesh)
    meshDebug.lastMergedPolygons = mesh.polygons.length

    return { mesh, obstacles, padIdToObstacle, compIdToObstacles }
  } catch (e) {
    meshDebug.lastError = `mesh build failed: ${e}`
    return { mesh: null, obstacles, padIdToObstacle }
  }
}

// ─── Point snapping ──────────────────────────────────────────────────

// ─── Pathfinding ─────────────────────────────────────────────────────

/**
 * Find a path between two points on a pad-only mesh.
 * excludePadIds are treated as traversable obstacles.
 */
export function findPath(
  layer: string,
  start: Point,
  goal: Point,
  board: BoardData,
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
  _routedTraces: Map<string, RoutedTrace>,
  _excludeConnectionId?: string,
  excludePadIds?: string[],
): Point[] | null {
  const { mesh, padIdToObstacle } = buildPadOnlyMesh(layer, board, components, placements)
  if (!mesh) return null

  const ignoreObstacles = new Set<number>()
  for (const padId of excludePadIds || []) {
    const oi = padIdToObstacle.get(padId)
    if (oi !== undefined) ignoreObstacles.add(oi)
  }

  try {
    const si = new SearchInstance(mesh)
    si.timeLimitMs = 50
    si.ignoreObstacles = ignoreObstacles
    si.setStartGoal(start, goal)
    const found = si.search()
    if (!found) return null
    return si.getPathPoints()
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
  const meshCache = new Map<string, MeshResult>()
  function getMesh(layer: string) {
    if (meshCache.has(layer)) return meshCache.get(layer)!
    const result = buildPadOnlyMesh(layer, board, components, placements)
    meshCache.set(layer, result)
    if (result.mesh) updateDebugData(result.mesh, result.obstacles)
    return result
  }

  const tMesh = performance.now()

  let attempts = 0
  let successes = 0
  let failNoMesh = 0
  let failNoPath = 0
  let failException = 0

  let tSearchTotal = 0
  let maxSearchMs = 0
  let maxSearchConn = ""
  let maxNodesPopped = 0

  // Expand multi-endpoint connections into point pairs via simple MST
  const pairs: { connId: string; ep1: ConnectionEndpoint; ep2: ConnectionEndpoint; layer: string }[] = []

  for (const conn of connections) {
    if (conn.endpoints.length < 2) {
      unrouted.add(conn.id)
      continue
    }

    if (conn.endpoints.length === 2) {
      // Simple pair
      pairs.push({
        connId: conn.id,
        ep1: conn.endpoints[0]!,
        ep2: conn.endpoints[1]!,
        layer: conn.endpoints[0]!.layer || "top",
      })
    } else {
      // Multi-endpoint net: build MST to get N-1 pairs
      // Resolve world positions
      const epPos: { ep: ConnectionEndpoint; pos: Point }[] = []
      for (const ep of conn.endpoints) {
        const pos = getWorldPadPosition(components, placements, ep.componentId, ep.padId)
        if (pos) epPos.push({ ep, pos })
      }
      if (epPos.length < 2) {
        unrouted.add(conn.id)
        continue
      }

      // Prim's MST — simple O(n²), fine for small endpoint counts
      const inMST = new Uint8Array(epPos.length)
      inMST[0] = 1
      let added = 1
      while (added < epPos.length) {
        let bestI = -1, bestJ = -1, bestDist = Infinity
        for (let i = 0; i < epPos.length; i++) {
          if (!inMST[i]) continue
          for (let j = 0; j < epPos.length; j++) {
            if (inMST[j]) continue
            const d = Math.hypot(epPos[i]!.pos.x - epPos[j]!.pos.x, epPos[i]!.pos.y - epPos[j]!.pos.y)
            if (d < bestDist) { bestDist = d; bestI = i; bestJ = j }
          }
        }
        if (bestJ === -1) break
        inMST[bestJ] = 1
        added++
        pairs.push({
          connId: `${conn.id}_mst${added - 1}`,
          ep1: epPos[bestI]!.ep,
          ep2: epPos[bestJ]!.ep,
          layer: epPos[bestI]!.ep.layer || "top",
        })
      }
    }
  }

  for (const pair of pairs) {
    attempts++
    const { connId, ep1, ep2, layer } = pair

    const startRaw = getWorldPadPosition(components, placements, ep1.componentId, ep1.padId)
    const goalRaw = getWorldPadPosition(components, placements, ep2.componentId, ep2.padId)
    if (!startRaw || !goalRaw) {
      unrouted.add(connId)
      continue
    }

    const { mesh, padIdToObstacle } = getMesh(layer)

    if (!mesh) {
      failNoMesh++
      unrouted.add(connId)
      continue
    }

    // Ignore only the start and end pad obstacles
    const ignoreObstacles = new Set<number>()
    const oi1 = padIdToObstacle.get(ep1.padId)
    const oi2 = padIdToObstacle.get(ep2.padId)
    if (oi1 !== undefined) ignoreObstacles.add(oi1)
    if (oi2 !== undefined) ignoreObstacles.add(oi2)

    try {
      const tSearch0 = performance.now()
      const si = new SearchInstance(mesh)
      si.timeLimitMs = 50
      si.ignoreObstacles = ignoreObstacles
      si.setStartGoal(startRaw, goalRaw)
      const found = si.search()
      const searchMs = performance.now() - tSearch0
      tSearchTotal += searchMs

      if (searchMs > maxSearchMs) {
        maxSearchMs = searchMs
        maxSearchConn = connId
        maxNodesPopped = si.nodesPopped
      }

      if (found) {
        const path = si.getPathPoints()
        if (path && path.length >= 2) {
          successes++
          traces.set(connId, {
            connectionId: connId,
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
      // Log first few failures for debugging
      if (failNoPath <= 3) {
        const startLoc = mesh.getPointLocation(startRaw)
        const goalLoc = mesh.getPointLocation(goalRaw)
        const startNaive = mesh.getPointLocationNaive(startRaw)
        const goalNaive = mesh.getPointLocationNaive(goalRaw)
        const startPoly = startLoc.poly1
        const goalPoly = goalLoc.poly1
        const startObs = startPoly >= 0 ? mesh.polygons[startPoly].obstacleIndex : "N/A"
        const goalObs = goalPoly >= 0 ? mesh.polygons[goalPoly].obstacleIndex : "N/A"
        console.warn(
          `[meshManager] FAIL "${connId}": start=(${startRaw.x.toFixed(1)},${startRaw.y.toFixed(1)}) slab=${startLoc.type} naive=${startNaive.type}(poly=${startNaive.poly1}) | ` +
          `goal=(${goalRaw.x.toFixed(1)},${goalRaw.y.toFixed(1)}) slab=${goalLoc.type} naive=${goalNaive.type}(poly=${goalNaive.poly1}) | ` +
          `polys=${mesh.polygons.length} verts=${mesh.vertices.length} | ` +
          `ignore=[${[...ignoreObstacles]}] nodes=${si.nodesPopped}/${si.nodesGenerated}`
        )
      }
    } catch (e: any) {
      failException++
      meshDebug.lastError = `route ${connId}: ${e.message?.slice(0, 60) || e}`
    }

    unrouted.add(connId)
  }

  const tDone = performance.now()

  meshDebug.lastRerouteAttempts = attempts
  meshDebug.lastRerouteSuccesses = successes

  const totalMs = tDone - t0
  // Log every call when slow (>10ms), otherwise every 60 frames
  if (totalMs > 10 || meshDebug.frameCount <= 2 || meshDebug.frameCount % 60 === 0) {
    const meshMs = (tMesh - t0).toFixed(1)
    const layers = [...meshCache.keys()]
    const polyCount = layers.map(l => meshCache.get(l)?.mesh?.polygons?.length ?? 0)
    console.log(
      `[meshManager] f${meshDebug.frameCount} ${successes}/${attempts} routed | ` +
      `mesh: ${meshMs}ms (${polyCount.join("/")} polys) | ` +
      `search: ${tSearchTotal.toFixed(1)}ms (worst: ${maxSearchMs.toFixed(1)}ms/${maxNodesPopped}nodes "${maxSearchConn}") | ` +
      `total: ${totalMs.toFixed(1)}ms | ` +
      `fail: noMesh=${failNoMesh} noPath=${failNoPath} exc=${failException}`
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
