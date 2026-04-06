import type { Point } from "./types.ts"
import type { Mesh } from "./mesh.ts"
import { distance } from "./geometry.ts"

export interface GraphSearchResult {
  path: Point[]
  cost: number
  nodesExpanded: number
}

function centroid(mesh: Mesh, polyIndex: number): Point {
  const verts = mesh.polygons[polyIndex]!.vertices
  let cx = 0,
    cy = 0
  for (const vi of verts) {
    const p = mesh.vertices[vi]!.p
    cx += p.x
    cy += p.y
  }
  return { x: cx / verts.length, y: cy / verts.length }
}

/**
 * A* search on the polygon dual connectivity graph.
 * Each polygon is a node; edges connect adjacent polygons.
 * Distances are measured between polygon centroids.
 */
export function graphSearch(
  mesh: Mesh,
  start: Point,
  goal: Point,
): GraphSearchResult {
  const empty: GraphSearchResult = { path: [], cost: -1, nodesExpanded: 0 }

  const startLoc = mesh.getPointLocation(start)
  const goalLoc = mesh.getPointLocation(goal)
  if (startLoc.poly1 < 0 || goalLoc.poly1 < 0) return empty
  if (!mesh.sameIsland(startLoc.poly1, goalLoc.poly1)) return empty

  const startPoly = startLoc.poly1
  const goalPoly = goalLoc.poly1

  // Same polygon — direct path
  if (startPoly === goalPoly) {
    const d = distance(start, goal)
    return { path: [start, goal], cost: d, nodesExpanded: 0 }
  }

  // Precompute centroids
  const centroids = new Array<Point>(mesh.polygons.length)
  for (let i = 0; i < mesh.polygons.length; i++) {
    centroids[i] = centroid(mesh, i)
  }

  const goalCentroid = centroids[goalPoly]!

  // A* min-heap (inline)
  interface HeapEntry {
    poly: number
    f: number
    g: number
  }

  const heap: HeapEntry[] = []
  const push = (e: HeapEntry) => {
    heap.push(e)
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
  const pop = (): HeapEntry => {
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

  const gBest = new Float64Array(mesh.polygons.length).fill(Infinity)
  const cameFrom = new Int32Array(mesh.polygons.length).fill(-1)

  const startG = distance(start, centroids[startPoly]!)
  gBest[startPoly] = startG
  push({
    poly: startPoly,
    g: startG,
    f: startG + distance(centroids[startPoly]!, goalCentroid),
  })

  let nodesExpanded = 0

  while (heap.length > 0) {
    const cur = pop()
    if (cur.g > gBest[cur.poly]!) continue

    if (cur.poly === goalPoly) {
      // Reconstruct path
      const polyPath: number[] = [goalPoly]
      let p = goalPoly
      while (cameFrom[p] !== -1) {
        p = cameFrom[p]!
        polyPath.push(p)
      }
      polyPath.reverse()

      const path: Point[] = [start]
      for (const pi of polyPath) {
        path.push(centroids[pi]!)
      }
      path.push(goal)

      const totalCost = cur.g + distance(centroids[goalPoly]!, goal)
      return { path, cost: totalCost, nodesExpanded }
    }

    nodesExpanded++
    const poly = mesh.polygons[cur.poly]!
    // Collect unique neighbor polygons
    const seen = new Set<number>()
    for (const adj of poly.polygons) {
      if (adj === -1 || seen.has(adj)) continue
      seen.add(adj)
      const adjPoly = mesh.polygons[adj]!
      const ng = cur.g + distance(centroids[cur.poly]!, centroids[adj]!) * adjPoly.weight + adjPoly.penalty
      if (ng < gBest[adj]!) {
        gBest[adj] = ng
        cameFrom[adj] = cur.poly
        push({ poly: adj, g: ng, f: ng + distance(centroids[adj]!, goalCentroid) })
      }
    }
  }

  return empty
}
