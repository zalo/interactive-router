/**
 * Adapter: runs the vendored rubberband topological router and returns
 * RoutedTrace objects compatible with the app's store.
 *
 * The rubberband router works in integer units (0.01 mil = 254 nm).
 * Our board is in mm, so we scale: 1 mm = 39370.079 units (1 mil = 25.4 µm).
 */

import { Router, Vertex, NetDesc, DEFAULT_CLEARANCE } from "../lib/rubberband/index.ts"
import type { BoardData, ComponentData, PlacementState, ConnectionData, RoutedTrace, Point } from "../types"
import { getWorldPadPosition } from "../state/store"
import { meshDebug } from "./meshManager"

const MM_TO_UNITS = 39370.079  // 1 mm in router units (0.01 mil)
const UNITS_TO_MM = 1 / MM_TO_UNITS

// Default trace parameters in router units
const TRACE_WIDTH = 1200    // ~0.03 mm
const PIN_RADIUS = 1000     // ~0.025 mm
const CLEARANCE = 800       // ~0.02 mm

/**
 * Route all connections using the rubberband topological router.
 * Builds a CDT from pad positions, runs Dijkstra + rubberband for each net,
 * then converts the drawn segments back to mm-space RoutedTraces.
 */
export async function routeAllTracesRubberband(
  board: BoardData,
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
  connections: ConnectionData[],
): Promise<{ traces: Map<string, RoutedTrace>; unrouted: Set<string> }> {
  const traces = new Map<string, RoutedTrace>()
  const unrouted = new Set<string>()

  if (connections.length === 0) return { traces, unrouted }

  const t0 = performance.now()

  const halfW = board.width / 2
  const halfH = board.height / 2
  const b1x = (-halfW) * MM_TO_UNITS
  const b1y = (-halfH) * MM_TO_UNITS
  const b2x = halfW * MM_TO_UNITS
  const b2y = halfH * MM_TO_UNITS

  // Reset static counters for fresh router
  Vertex.resetIds()
  NetDesc.resetIds()

  const router = new Router(b1x, b1y, b2x, b2y)

  // Insert border vertices
  router.insertBorder()

  // Insert pad vertices with their bounding boxes as CDT obstacles.
  // Each pad gets a pin vertex at its center (for routing to/from) and a
  // rectangular polygon obstacle so Dijkstra can't cut through pad copper.
  // The obstacle uses edgesInCluster to block interior CDT edges while
  // still allowing routes to reach the pin vertex itself.
  const padVertexMap = new Map<string, Vertex>()  // padId -> Vertex

  for (const [compId, comp] of components) {
    const placement = placements.get(compId)
    if (!placement) continue

    const rad = (placement.rotation * Math.PI) / 180
    const cosR = Math.cos(rad)
    const sinR = Math.sin(rad)

    for (const pad of comp.pads) {
      const worldPos = getWorldPadPosition(components, placements, compId, pad.id)
      if (!worldPos) continue

      const ux = worldPos.x * MM_TO_UNITS
      const uy = worldPos.y * MM_TO_UNITS
      const name = `${compId}:${pad.id}`

      // Pin radius = half the smaller pad dimension (conservative)
      const pw = (pad.width || 0.5) * MM_TO_UNITS
      const ph = (pad.height || 0.5) * MM_TO_UNITS
      const padRadius = Math.min(pw, ph) / 2

      const v = router.insertVertex(name, ux, uy, padRadius, CLEARANCE)
      padVertexMap.set(pad.id, v)

      // Insert pad bounding box as a polygon obstacle in the CDT.
      // The pin vertex sits at the center; Dijkstra can reach it but
      // can't traverse through the pad's interior edges.
      const hw = pw / 2
      const hh = ph / 2
      const corners = [
        { x: -hw, y: -hh }, { x: hw, y: -hh },
        { x: hw, y: hh }, { x: -hw, y: hh },
      ]
      // Rotate corners by component rotation and translate to world pos
      const worldCorners = corners.map(c => ({
        x: ux + c.x * cosR - c.y * sinR,
        y: uy + c.x * sinR + c.y * cosR,
      }))
      router.insertPadObstacle(worldCorners)
    }
  }

  console.log(`[rubberband] ${padVertexMap.size} pads inserted (with obstacle boxes)`)

  // Build netlist from connections (expand multi-endpoint via MST pairs)
  const connNetIds = new Map<string, number[]>()  // connectionId -> netlist indices
  const netConnMap: { connId: string; ep1Key: string; ep2Key: string }[] = []

  for (const conn of connections) {
    if (conn.endpoints.length < 2) {
      unrouted.add(conn.id)
      continue
    }

    const epPairs = expandToPointPairs(conn, components, placements)
    const netIndices: number[] = []

    for (const pair of epPairs) {
      const v1 = padVertexMap.get(pair.ep1.padId)
      const v2 = padVertexMap.get(pair.ep2.padId)
      if (!v1 || !v2) {
        console.warn(`[rubberband] missing vertex for pair ${pair.connId}: ep1=${pair.ep1.padId}(${!!v1}) ep2=${pair.ep2.padId}(${!!v2})`)
        continue
      }

      const idx = netConnMap.length
      netConnMap.push({
        connId: pair.connId,
        ep1Key: v1.name,
        ep2Key: v2.name,
      })
      netIndices.push(idx)
    }

    connNetIds.set(conn.id, netIndices)
  }

  console.log(`[rubberband] ${netConnMap.length} net pairs from ${connections.length} connections`)

  // Generate the netlist
  router.generateNetlist(
    netConnMap.map(nc => ({
      from: nc.ep1Key,
      to: nc.ep2Key,
      traceWidth: TRACE_WIDTH,
      traceClearance: CLEARANCE,
    }))
  )
  router.sortNetlist()

  // Triangulate and initialize
  await router.finishInit()

  // Export CDT edges to meshDebug for debug visualization
  exportRubberbandDebug(router)

  console.log(`[rubberband] CDT: ${router.getVertices().length} vertices, ${router.getRegions().length} regions`)

  // Route each net, tracking which pathId maps to which netlist index.
  // router.route() increments an internal pathId only on success, and
  // DrawnSegment.netId is set to Step.id which equals that pathId.
  const pathIdToNetIdx = new Map<number, number>()
  let nextPathId = 0
  for (let i = 0; i < router.netlist.length; i++) {
    const success = router.route(i)
    if (success) {
      pathIdToNetIdx.set(nextPathId, i)
      nextPathId++
    }
  }

  console.log(`[rubberband] routing: ${nextPathId}/${router.netlist.length} succeeded`)

  // Rubberband optimization passes
  router.sortAttachedNets()
  router.prepareSteps()
  router.nubly(false)  // radius adjustment
  router.nubly(true)   // collapse concave bends
  router.prepareSteps()
  router.fixCrossingPairs()
  router.generateDrawnSegments()

  console.log(`[rubberband] ${router.drawnSegments.length} drawn segments`)

  // Convert drawn segments to RoutedTraces.
  // seg.netId is a pathId (0-based, success-only counter), NOT NetDesc.id.
  // Use pathIdToNetIdx to map back to the netlist index.
  const segsByPathId = new Map<number, typeof router.drawnSegments>()
  for (const seg of router.drawnSegments) {
    let arr = segsByPathId.get(seg.netId)
    if (!arr) {
      arr = []
      segsByPathId.set(seg.netId, arr)
    }
    arr.push(seg)
  }

  console.log(`[rubberband] segments grouped into ${segsByPathId.size} pathIds, mapping ${pathIdToNetIdx.size} pathIds to netlist`)

  // Map pathId → netlist index → netConnMap entry → RoutedTrace
  for (const [pathId, ni] of pathIdToNetIdx) {
    const net = router.netlist[ni]
    // Find the netConnMap entry matching this net's terminals
    const ncIdx = netConnMap.findIndex(nc => nc.ep1Key === net.t1Name && nc.ep2Key === net.t2Name)
    if (ncIdx < 0) {
      console.warn(`[rubberband] no netConnMap match for pathId=${pathId} ni=${ni} t1="${net.t1Name}" t2="${net.t2Name}"`)
      continue
    }

    const nc = netConnMap[ncIdx]
    const segs = segsByPathId.get(pathId)

    if (!segs || segs.length === 0) {
      unrouted.add(nc.connId)
      continue
    }

    // Convert line segments to point arrays (skip arcs for now — use endpoints)
    const points: Point[] = []
    for (const seg of segs) {
      if (seg.type === 'line') {
        if (points.length === 0) {
          points.push({ x: seg.x1 * UNITS_TO_MM, y: seg.y1 * UNITS_TO_MM })
        }
        points.push({ x: seg.x2 * UNITS_TO_MM, y: seg.y2 * UNITS_TO_MM })
      }
    }

    if (points.length >= 2) {
      traces.set(nc.connId, {
        connectionId: nc.connId,
        segments: [{
          points,
          layer: "top",
          width: TRACE_WIDTH * UNITS_TO_MM,
        }],
        vias: [],
      })
    } else {
      unrouted.add(nc.connId)
    }
  }

  // Mark any connections with no routed nets as unrouted
  for (const conn of connections) {
    const netIndices = connNetIds.get(conn.id)
    if (!netIndices || netIndices.length === 0) {
      unrouted.add(conn.id)
      continue
    }
    // Check if any sub-net was routed
    let anyRouted = false
    for (const ni of netIndices) {
      const nc = netConnMap[ni]
      if (nc && traces.has(nc.connId)) {
        anyRouted = true
        break
      }
    }
    if (!anyRouted) unrouted.add(conn.id)
  }

  console.log(`[rubberband] final: ${traces.size} traces, ${unrouted.size} unrouted, ${(performance.now() - t0).toFixed(0)}ms`)
  return { traces, unrouted }
}

/** Expand a multi-endpoint connection into point pairs via MST */
function expandToPointPairs(
  conn: ConnectionData,
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
): { connId: string; ep1: { componentId: string; padId: string }; ep2: { componentId: string; padId: string } }[] {
  const pairs: { connId: string; ep1: { componentId: string; padId: string }; ep2: { componentId: string; padId: string } }[] = []

  if (conn.endpoints.length === 2) {
    pairs.push({
      connId: conn.id,
      ep1: conn.endpoints[0]!,
      ep2: conn.endpoints[1]!,
    })
    return pairs
  }

  // Multi-endpoint: MST
  const epPos: { ep: typeof conn.endpoints[0]; pos: Point }[] = []
  for (const ep of conn.endpoints) {
    const pos = getWorldPadPosition(components, placements, ep.componentId, ep.padId)
    if (pos) epPos.push({ ep, pos })
  }
  if (epPos.length < 2) return pairs

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
    })
  }
  return pairs
}

/**
 * Export rubberband CDT edges and obstacle polygons into meshDebug
 * so the existing debug overlay renders them.
 */
function exportRubberbandDebug(router: Router) {
  const verts = router.getVertices()

  // Build CDT edges as triangles for meshDebug.lastMeshPolygons
  // Each CDT edge becomes a thin "polygon" (line) for the mesh overlay
  const edgePolys: Array<{ vertices: { x: number; y: number }[]; blocked: boolean; obstacleIndex: number }> = []
  const seen = new Set<string>()

  for (const v of verts) {
    if (v.name === 'border') continue
    for (const nb of v.neighbors) {
      if (nb.name === 'border') continue
      const key = v.id < nb.id ? `${v.id}_${nb.id}` : `${nb.id}_${v.id}`
      if (seen.has(key)) continue
      seen.add(key)

      const x1 = v.x * UNITS_TO_MM
      const y1 = v.y * UNITS_TO_MM
      const x2 = nb.x * UNITS_TO_MM
      const y2 = nb.y * UNITS_TO_MM

      // Check if this is a blocked edge (both vertices in same obstacle cluster)
      const blocked = v.cid >= 0 && v.cid === nb.cid

      // Create a thin triangle so the mesh renderer can draw it
      const dx = x2 - x1, dy = y2 - y1
      const len = Math.hypot(dx, dy)
      if (len < 1e-9) continue
      const nx = -dy / len * 0.01, ny = dx / len * 0.01
      edgePolys.push({
        vertices: [
          { x: x1, y: y1 },
          { x: x2, y: y2 },
          { x: (x1 + x2) / 2 + nx, y: (y1 + y2) / 2 + ny },
        ],
        blocked,
        obstacleIndex: blocked ? 1 : -1,
      })
    }
  }

  // Build obstacle polygons for the obstacle debug overlay:
  // Show pin vertices as small octagons and pad boundary rectangles
  const obstaclePolys: Array<{ x: number; y: number }[]> = []

  // Pin vertex octagons
  for (const v of verts) {
    if (v.name === 'border' || v.name === 'obstacle_boundary' || v.name === 'pad_boundary') continue
    if (v.core <= 0) continue
    const r = v.core * UNITS_TO_MM
    const cx = v.x * UNITS_TO_MM
    const cy = v.y * UNITS_TO_MM
    const pts: { x: number; y: number }[] = []
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
    }
    obstaclePolys.push(pts)
  }

  // Pad boundary rectangles — reconstruct from boundary vertices grouped by cid
  const cidGroups = new Map<number, { x: number; y: number }[]>()
  for (const v of verts) {
    if (v.name !== 'pad_boundary' || v.cid < 0) continue
    let group = cidGroups.get(v.cid)
    if (!group) { group = []; cidGroups.set(v.cid, group) }
    group.push({ x: v.x * UNITS_TO_MM, y: v.y * UNITS_TO_MM })
  }
  for (const pts of cidGroups.values()) {
    if (pts.length >= 3) obstaclePolys.push(pts)
  }

  meshDebug.lastMeshPolygons = edgePolys
  meshDebug.lastObstaclePolygons = obstaclePolys
}
