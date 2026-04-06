import type { Point, WeightedRegion } from "./types.ts"
import type { Mesh } from "./mesh.ts"
import { EPSILON } from "./types.ts"
import { distance, pointsEqual } from "./geometry.ts"
import { SearchInstance } from "./search.ts"
import {
  buildWeightedEdgeContext,
  computeWeightedEdgeCost,
  type WeightedEdgeContext,
} from "./weighted-edges.ts"

export interface VisibilityGraphOptions {
  convexityThreshold?: number
  weightedRegions?: WeightedRegion[]
}

export interface VisibilityGraphResult {
  path: Point[]
  cost: number
  nodesExpanded: number
  edgeCount: number
  /** Time for this search query in ms (graph construction is precomputed) */
  buildTimeMs: number
  edges: { ax: number; ay: number; bx: number; by: number }[]
}

/**
 * Visibility graph for a navigation mesh.
 *
 * Construction is cheap — only convex (reflex) corners are extracted.
 * The expensive corner-corner adjacency is built lazily on the first search()
 * call so that switching to this algorithm incurs no upfront cost.
 *
 * Only convex (reflex) corners are included — vertices where the obstacle
 * subtends < 180°, i.e. where a shortest path might wrap around.
 * Near-flat corners are filtered by `convexityThreshold` (minimum |sin| of
 * the CW turn angle; default 0.02 ≈ 1.1°).
 *
 * When weighted regions are provided, region polygon vertices become
 * additional graph nodes (potential turning points around/through regions),
 * and edge costs are computed via segment-region intersection.
 *
 * Corner-corner adjacency is computed using goalless Polyanya expansion,
 * which uses mesh topology directly (no BVH, no K-nearest cutoff).
 */
export class VisibilityGraph {
  private readonly mesh: Mesh
  /** Reused search instance for visibility queries */
  private readonly si: SearchInstance
  /** Mesh vertex indices for mesh corner nodes */
  private readonly cornerIndices: number[]
  /** All graph node points (mesh corners + region vertices) */
  private readonly cornerPoints: Point[]
  /** How many nodes are mesh corners (the rest are region vertices) */
  private readonly numMeshCorners: number
  /** Maps mesh vertex index → index in cornerIndices/cornerPoints */
  private readonly vertexToCorner: Map<number, number>
  /** Static corner-corner adjacency — null until first search() call */
  private adj: { to: number; dist: number }[][] | null = null
  private readonly weightedRegions: WeightedRegion[] | null
  private weightedCtx: WeightedEdgeContext | null = null

  /** Time taken to build the static adjacency graph (ms). 0 until first search(). */
  buildTimeMs = 0
  /** Number of static corner-corner edges. 0 until first search(). */
  edgeCount = 0
  /** Static corner-corner edges for visualization. Empty until first search(). */
  edges: { ax: number; ay: number; bx: number; by: number }[] = []

  constructor(mesh: Mesh, options?: number | VisibilityGraphOptions) {
    let convexityThreshold = 0.02
    let weightedRegions: WeightedRegion[] | null = null

    if (typeof options === "number") {
      convexityThreshold = options
    } else if (options) {
      if (options.convexityThreshold !== undefined)
        convexityThreshold = options.convexityThreshold
      if (options.weightedRegions && options.weightedRegions.length > 0)
        weightedRegions = options.weightedRegions
    }

    this.mesh = mesh
    this.si = new SearchInstance(mesh)
    this.weightedRegions = weightedRegions

    // 1. Track directed boundary edge adjacency for convexity test
    const boundaryNext = new Map<number, number>()
    const boundaryPrev = new Map<number, number>()
    const seen = new Set<string>()
    for (const poly of mesh.polygons) {
      if (!poly) continue
      const V = poly.vertices
      const P = poly.polygons
      const N = V.length
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N
        if (P[j] !== -1) continue
        const a = V[i]!
        const b = V[j]!
        const key = a < b ? `${a},${b}` : `${b},${a}`
        if (seen.has(key)) continue
        seen.add(key)
        boundaryNext.set(a, b)
        boundaryPrev.set(b, a)
      }
    }

    // 2. Extract convex (reflex) corners only.
    const cornerIndices: number[] = []
    for (let i = 0; i < mesh.vertices.length; i++) {
      const v = mesh.vertices[i]!
      if (!v.isCorner) continue
      if (v.isAmbig) {
        cornerIndices.push(i)
        continue
      }
      const prevIdx = boundaryPrev.get(i)
      const nextIdx = boundaryNext.get(i)
      if (prevIdx === undefined || nextIdx === undefined) {
        cornerIndices.push(i)
        continue
      }
      const A = mesh.vertices[prevIdx]!.p
      const VP = v.p
      const B = mesh.vertices[nextIdx]!.p
      const dx1 = VP.x - A.x, dy1 = VP.y - A.y
      const dx2 = B.x - VP.x, dy2 = B.y - VP.y
      const len1Sq = dx1 * dx1 + dy1 * dy1
      const len2Sq = dx2 * dx2 + dy2 * dy2
      if (len1Sq < EPSILON || len2Sq < EPSILON) {
        cornerIndices.push(i)
        continue
      }
      const normalizedCross =
        (dx1 * dy2 - dy1 * dx2) / Math.sqrt(len1Sq * len2Sq)
      if (normalizedCross < -convexityThreshold) {
        cornerIndices.push(i)
      }
    }
    this.cornerIndices = cornerIndices

    const numMeshCorners = cornerIndices.length
    this.numMeshCorners = numMeshCorners

    const cornerPoints: Point[] = new Array(numMeshCorners)
    const vertexToCorner = new Map<number, number>()
    for (let k = 0; k < numMeshCorners; k++) {
      cornerPoints[k] = mesh.vertices[cornerIndices[k]!]!.p
      vertexToCorner.set(cornerIndices[k]!, k)
    }

    // 3. Add weighted region polygon vertices as additional graph nodes.
    // These are potential turning points for paths around/through regions.
    if (weightedRegions) {
      for (const wr of weightedRegions) {
        for (const v of wr.polygon) {
          const loc = mesh.getPointLocation(v)
          if (loc.poly1 < 0) continue
          let isDuplicate = false
          for (let k = 0; k < cornerPoints.length; k++) {
            if (pointsEqual(v, cornerPoints[k]!)) {
              isDuplicate = true
              break
            }
          }
          if (!isDuplicate) {
            cornerPoints.push(v)
          }
        }
      }
    }

    this.cornerPoints = cornerPoints
    this.vertexToCorner = vertexToCorner
  }

  /** Compute edge cost: weighted if context exists, otherwise Euclidean */
  private edgeCost(a: Point, b: Point): number {
    return this.weightedCtx
      ? computeWeightedEdgeCost(a, b, this.weightedCtx)
      : distance(a, b)
  }

  /** Check direct visibility between two points via Polyanya search */
  private isDirectlyVisible(a: Point, b: Point): boolean {
    this.si.setStartGoal(a, b)
    if (!this.si.search()) return false
    return this.si.getPathPoints().length === 2
  }

  /**
   * Build the static corner-corner adjacency graph.
   * Called lazily on the first search() invocation.
   */
  private _build(): void {
    if (this.adj !== null) return
    const t0 = performance.now()
    const { cornerPoints, vertexToCorner, numMeshCorners } = this
    const numCorners = cornerPoints.length

    // Build weighted edge context if needed
    if (this.weightedRegions) {
      this.weightedCtx = buildWeightedEdgeContext(this.weightedRegions)
    }

    const adj: { to: number; dist: number }[][] = new Array(numCorners)
    for (let k = 0; k < numCorners; k++) adj[k] = []

    let edgeCount = 0
    const visEdges: { ax: number; ay: number; bx: number; by: number }[] = []
    const addedEdge = new Set<string>()

    const addEdge = (k: number, j: number, cost: number) => {
      const lo = Math.min(k, j)
      const hi = Math.max(k, j)
      const key = `${lo},${hi}`
      if (addedEdge.has(key)) return
      addedEdge.add(key)
      adj[k]!.push({ to: j, dist: cost })
      adj[j]!.push({ to: k, dist: cost })
      visEdges.push({
        ax: cornerPoints[k]!.x,
        ay: cornerPoints[k]!.y,
        bx: cornerPoints[j]!.x,
        by: cornerPoints[j]!.y,
      })
      edgeCount++
    }

    // Mesh corners → mesh corners: goalless Polyanya from both sides.
    // Running from both A and B mitigates directional dependence in the
    // cone filter — if A's expansion misses B, B's expansion may find A.
    for (let k = 0; k < numMeshCorners; k++) {
      const visible = this.si.computeVisibleCornersFromPoint(cornerPoints[k]!)
      for (const [vertexIdx] of visible) {
        const j = vertexToCorner.get(vertexIdx)
        if (j === undefined || j === k) continue
        const cost = this.edgeCost(cornerPoints[k]!, cornerPoints[j]!)
        addEdge(k, j, cost)
      }
    }

    // Region vertices → all other corners: direct Polyanya search.
    // Goalless expansion is unreliable from interior mesh points (region
    // vertices) and can only discover mesh corners, not other region
    // vertices. Direct search handles both region↔mesh and region↔region.
    for (let k = numMeshCorners; k < numCorners; k++) {
      for (let j = 0; j < numCorners; j++) {
        if (j === k) continue
        const lo = Math.min(k, j)
        const hi = Math.max(k, j)
        if (addedEdge.has(`${lo},${hi}`)) continue
        if (this.isDirectlyVisible(cornerPoints[k]!, cornerPoints[j]!)) {
          const cost = this.edgeCost(cornerPoints[k]!, cornerPoints[j]!)
          addEdge(k, j, cost)
        }
      }
    }

    this.adj = adj
    this.edgeCount = edgeCount
    this.edges = visEdges
    this.buildTimeMs = performance.now() - t0
  }

  /**
   * Find the shortest path from start to goal using the precomputed graph.
   * Connects start and goal to all visible corners via Polyanya expansion,
   * checks direct start→goal visibility, then runs A*.
   */
  search(start: Point, goal: Point): VisibilityGraphResult {
    this._build()
    const t0 = performance.now()
    const empty: VisibilityGraphResult = {
      path: [],
      cost: -1,
      nodesExpanded: 0,
      edgeCount: this.edgeCount,
      buildTimeMs: 0,
      edges: this.edges,
    }

    const startLoc = this.mesh.getPointLocation(start)
    const goalLoc = this.mesh.getPointLocation(goal)
    if (startLoc.poly1 < 0 || goalLoc.poly1 < 0) return empty
    if (!this.mesh.sameIsland(startLoc.poly1, goalLoc.poly1)) return empty

    const numCorners = this.cornerPoints.length
    const startIdx = numCorners
    const goalIdx = numCorners + 1
    const numNodes = numCorners + 2

    const nodePoints: Point[] = new Array(numNodes)
    for (let k = 0; k < numCorners; k++) nodePoints[k] = this.cornerPoints[k]!
    nodePoints[startIdx] = start
    nodePoints[goalIdx] = goal

    // Find mesh corners visible from start and goal via Polyanya expansion
    const startVisibleMap = this.si.computeVisibleCornersFromPoint(start)
    const goalVisibleMap = this.si.computeVisibleCornersFromPoint(goal)

    const cornerToStartDist = new Float64Array(numCorners).fill(-1)
    const cornerToGoalDist = new Float64Array(numCorners).fill(-1)
    const startAdj: { to: number; dist: number }[] = []
    const goalAdj: { to: number; dist: number }[] = []

    for (const [vertexIdx] of startVisibleMap) {
      const k = this.vertexToCorner.get(vertexIdx)
      if (k === undefined) continue
      const cost = this.edgeCost(start, this.cornerPoints[k]!)
      startAdj.push({ to: k, dist: cost })
      cornerToStartDist[k] = cost
    }
    for (const [vertexIdx] of goalVisibleMap) {
      const k = this.vertexToCorner.get(vertexIdx)
      if (k === undefined) continue
      const cost = this.edgeCost(goal, this.cornerPoints[k]!)
      goalAdj.push({ to: k, dist: cost })
      cornerToGoalDist[k] = cost
    }

    // Region vertex connections via Polyanya search + path-length-2 check
    for (let k = this.numMeshCorners; k < numCorners; k++) {
      if (this.isDirectlyVisible(start, this.cornerPoints[k]!)) {
        const cost = this.edgeCost(start, this.cornerPoints[k]!)
        startAdj.push({ to: k, dist: cost })
        cornerToStartDist[k] = cost
      }
      if (this.isDirectlyVisible(goal, this.cornerPoints[k]!)) {
        const cost = this.edgeCost(goal, this.cornerPoints[k]!)
        goalAdj.push({ to: k, dist: cost })
        cornerToGoalDist[k] = cost
      }
    }

    // Check direct start→goal visibility via Polyanya search
    this.si.setStartGoal(start, goal)
    if (this.si.search()) {
      const pathPts = this.si.getPathPoints()
      if (pathPts.length === 2) {
        const directCost = this.edgeCost(start, goal)
        startAdj.push({ to: goalIdx, dist: directCost })
        goalAdj.push({ to: startIdx, dist: directCost })
      }
    }

    // A* over static corner graph + dynamic start/goal edges
    const goalP = goal

    const heap: { node: number; f: number; g: number }[] = []
    const pushHeap = (node: number, g: number, f: number) => {
      heap.push({ node, f, g })
      let i = heap.length - 1
      while (i > 0) {
        const pi = (i - 1) >> 1
        if (heap[pi]!.f <= heap[i]!.f) break
        const tmp = heap[pi]!
        heap[pi] = heap[i]!
        heap[i] = tmp
        i = pi
      }
    }
    const popHeap = (): { node: number; f: number; g: number } => {
      const top = heap[0]!
      const last = heap.pop()!
      if (heap.length > 0) {
        heap[0] = last
        let i = 0
        while (true) {
          let s = i
          const l = 2 * i + 1,
            r = 2 * i + 2
          if (l < heap.length && heap[l]!.f < heap[s]!.f) s = l
          if (r < heap.length && heap[r]!.f < heap[s]!.f) s = r
          if (s === i) break
          const tmp = heap[i]!
          heap[i] = heap[s]!
          heap[s] = tmp
          i = s
        }
      }
      return top
    }

    const gBest = new Float64Array(numNodes).fill(Infinity)
    const cameFrom = new Int32Array(numNodes).fill(-1)

    gBest[startIdx] = 0
    pushHeap(startIdx, 0, distance(start, goalP))

    let nodesExpanded = 0

    while (heap.length > 0) {
      const cur = popHeap()
      if (cur.g > gBest[cur.node]! + EPSILON) continue

      if (cur.node === goalIdx) {
        const path: Point[] = []
        let n = goalIdx
        while (n !== -1) {
          path.push(nodePoints[n]!)
          n = cameFrom[n]!
        }
        path.reverse()
        return {
          path,
          cost: cur.g,
          nodesExpanded,
          edgeCount: this.edgeCount,
          buildTimeMs: performance.now() - t0,
          edges: this.edges,
        }
      }

      nodesExpanded++

      const relax = (to: number, ng: number) => {
        if (ng < gBest[to]! - EPSILON) {
          gBest[to] = ng
          cameFrom[to] = cur.node
          pushHeap(to, ng, ng + distance(nodePoints[to]!, goalP))
        }
      }

      if (cur.node === startIdx) {
        for (const e of startAdj) relax(e.to, cur.g + e.dist)
      } else if (cur.node === goalIdx) {
        for (const e of goalAdj) relax(e.to, cur.g + e.dist)
      } else {
        // Corner node: static edges + dynamic backlinks to start/goal
        for (const e of this.adj![cur.node]!) relax(e.to, cur.g + e.dist)
        const toStart = cornerToStartDist[cur.node]!
        if (toStart >= 0) relax(startIdx, cur.g + toStart)
        const toGoal = cornerToGoalDist[cur.node]!
        if (toGoal >= 0) relax(goalIdx, cur.g + toGoal)
      }
    }

    return empty
  }
}

/**
 * Convenience function: builds a VisibilityGraph and immediately runs a search.
 * For repeated queries on the same mesh, prefer constructing VisibilityGraph
 * once and calling search() directly.
 */
export function visibilityGraphSearch(
  mesh: Mesh,
  start: Point,
  goal: Point,
): VisibilityGraphResult {
  return new VisibilityGraph(mesh).search(start, goal)
}
