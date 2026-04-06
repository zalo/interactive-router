import { Mesh } from "./mesh.ts"
import { cross, sub } from "./geometry.ts"
import type { Point, Polygon, Vertex } from "./types.ts"

/**
 * Merge adjacent convex polygons in a navigation mesh using the Polyanya
 * meshmerger algorithm (dead-end elimination + max-area priority queue).
 *
 * Produces strictly convex, larger polygons that reduce search node expansions.
 * Does not mutate the input mesh.
 */
export function mergeMesh(mesh: Mesh): Mesh {
  const n = mesh.polygons.length
  const verts: number[][] = new Array(n)
  const nb: number[][] = new Array(n)
  const dead: boolean[] = new Array(n).fill(false)
  const area: number[] = new Array(n)
  const weights: number[] = new Array(n)
  const penalties: number[] = new Array(n)

  for (let i = 0; i < n; i++) {
    const p = mesh.polygons[i]!
    verts[i] = p.vertices.slice()
    nb[i] = p.polygons.slice()
    area[i] = polyArea(p.vertices, mesh)
    weights[i] = p.weight
    penalties[i] = p.penalty
  }

  // Union-find
  const ufParent: number[] = new Array(n)
  const ufRank: number[] = new Array(n).fill(0)
  for (let i = 0; i < n; i++) ufParent[i] = i

  function find(x: number): number {
    while (ufParent[x] !== x) {
      ufParent[x] = ufParent[ufParent[x]!]!
      x = ufParent[x]!
    }
    return x
  }

  function union(a: number, b: number): void {
    a = find(a); b = find(b)
    if (a === b) return
    if (ufRank[a]! < ufRank[b]!) { const t = a; a = b; b = t }
    ufParent[b] = a
    if (ufRank[a] === ufRank[b]) ufRank[a]!++
  }

  // Union that forces 'alive' to be the representative (used in doMerge)
  function unionForce(alive: number, deadIdx: number): void {
    alive = find(alive); deadIdx = find(deadIdx)
    if (alive === deadIdx) return
    ufParent[deadIdx] = alive
    if (ufRank[alive]! <= ufRank[deadIdx]!) ufRank[alive] = ufRank[deadIdx]! + 1
  }

  function resolve(idx: number): number {
    return idx === -1 ? -1 : find(idx)
  }

  // Resolve all stale neighbor references for a polygon
  function resolveAll(idx: number): void {
    const a = nb[idx]!
    for (let j = 0; j < a.length; j++) {
      if (a[j] !== -1) a[j] = resolve(a[j]!)
    }
  }

  // Find the full shared boundary between X and neighbor Y, starting from edgeK.
  // Returns { firstK, lastK } — the range of consecutive edges in X that all point to Y.
  // The shared boundary vertices in X are: V[firstK-1], V[firstK], ..., V[lastK]
  // (firstK is the first edge index, lastK is the last edge index)
  function findBoundary(xIdx: number, edgeK: number, yIdx: number): { firstK: number; lastK: number } {
    const xN = nb[xIdx]!
    const L = xN.length

    let firstK = edgeK
    while (true) {
      const prev = (firstK - 1 + L) % L
      if (prev === edgeK) break // full wrap
      if (resolve(xN[prev]!) !== yIdx) break
      firstK = prev
    }

    let lastK = edgeK
    while (true) {
      const next = (lastK + 1) % L
      if (next === firstK) break // full wrap
      if (resolve(xN[next]!) !== yIdx) break
      lastK = next
    }

    return { firstK, lastK }
  }

  // Convexity check for merging polygon X with Y across the full shared boundary.
  // edgeK is any edge in X that points to Y.
  function canMerge(xIdx: number, edgeK: number): boolean {
    const xV = verts[xIdx]!
    const xN = nb[xIdx]!
    const yRaw = xN[edgeK]!
    if (yRaw === -1) return false
    const yIdx = resolve(yRaw)
    if (yIdx === -1 || yIdx === xIdx || dead[yIdx]) return false

    // Block merging polygons with different weights
    if (weights[xIdx] !== weights[yIdx] || penalties[xIdx] !== penalties[yIdx]) return false

    const yV = verts[yIdx]!
    const N = xV.length
    const M = yV.length

    // Find full shared boundary
    const { firstK, lastK } = findBoundary(xIdx, edgeK, yIdx)

    // A = first vertex of shared boundary, B = last vertex
    const A = xV[(firstK - 1 + N) % N]!
    const B = xV[lastK]!

    // Find A in Y
    let mA = -1
    for (let i = 0; i < M; i++) {
      if (yV[i] === A) { mA = i; break }
    }
    if (mA === -1) return false

    // Count shared edges
    const sharedEdges = ((lastK - firstK + N) % N) + 1

    // Find B in Y — it should be at Y[(mA - sharedEdges + M) % M]
    const mB = (mA - sharedEdges + M) % M
    if (yV[mB] !== B) return false

    // Check convexity at A
    const prevX = mesh.vertices[xV[(firstK - 2 + N) % N]!]!.p
    const pA = mesh.vertices[A]!.p
    const nextY = mesh.vertices[yV[(mA + 1) % M]!]!.p
    if (cross(sub(pA, prevX), sub(nextY, pA)) < -1e-8) return false

    // Check convexity at B
    const prevY = mesh.vertices[yV[(mB - 1 + M) % M]!]!.p
    const pB = mesh.vertices[B]!.p
    const nextX = mesh.vertices[xV[(lastK + 1) % N]!]!.p
    if (cross(sub(pB, prevY), sub(nextX, pB)) < -1e-8) return false

    return true
  }

  // Merge Y into X across the full shared boundary (identified by any edge edgeK→Y)
  function doMerge(xIdx: number, edgeK: number, yIdx: number): void {
    const xV = verts[xIdx]!
    const xN = nb[xIdx]!
    const yV = verts[yIdx]!
    const yN = nb[yIdx]!
    const N = xV.length
    const M = yV.length

    const { firstK, lastK } = findBoundary(xIdx, edgeK, yIdx)
    const sharedEdges = ((lastK - firstK + N) % N) + 1

    const A = xV[(firstK - 1 + N) % N]! // first endpoint
    const B = xV[lastK]!                  // last endpoint

    // Find A in Y
    let mA = -1
    for (let i = 0; i < M; i++) {
      if (yV[i] === A) { mA = i; break }
    }
    const mB = (mA - sharedEdges + M) % M

    // Build merged polygon:
    // Walk X from A (inclusive), skip shared boundary, to B (exclusive),
    // then walk Y from B... to A...
    // Specifically: keep X's non-shared vertices + Y's non-shared vertices
    const newVerts: number[] = []
    const newNb: number[] = []

    // X's non-shared: from A to B going the "long way" (not through shared boundary)
    // A is at position (firstK-1+N)%N, B is at position lastK
    // Non-shared X vertices: positions (lastK+1)%N, (lastK+2)%N, ..., (firstK-1+N)%N
    // Plus A at the start
    // Number of non-shared X vertices: N - sharedEdges (includes A but not B... wait)
    // Actually: shared boundary uses positions firstK, firstK+1, ..., lastK for edges.
    // Shared vertices in X: V[firstK-1]=A, V[firstK], ..., V[lastK]=B
    // That's sharedEdges+1 vertices. But A and B are endpoints we keep.
    // Non-shared X portion: V[lastK+1], V[lastK+2], ..., V[firstK-2], V[firstK-1]=A
    // That's N - sharedEdges - 1 vertices (excluding B, excluding intermediate shared, including A)
    // Or equivalently: N - (sharedEdges+1) + 1 = N - sharedEdges non-shared + A = N - sharedEdges

    // Start with A
    newVerts.push(A)
    newNb.push(xN[(firstK - 1 + N) % N]!)

    // Y's non-shared: Y[(mA+1)%M], ..., Y[(mB-1+M)%M]
    // Number of Y non-shared: M - sharedEdges - 1
    const yNonShared = M - sharedEdges - 1
    for (let j = 1; j <= yNonShared; j++) {
      const yi = (mA + j) % M
      newVerts.push(yV[yi]!)
      newNb.push(yN[yi]!)
    }

    // B
    newVerts.push(B)
    newNb.push(yN[mB]!)

    // X's non-shared: X[(lastK+1)%N], ..., X[(firstK-2+N)%N]
    // Number: N - sharedEdges - 1
    const xNonShared = N - sharedEdges - 1
    for (let j = 1; j <= xNonShared; j++) {
      const xi = (lastK + j) % N
      newVerts.push(xV[xi]!)
      newNb.push(xN[xi]!)
    }

    verts[xIdx] = newVerts
    nb[xIdx] = newNb

    dead[yIdx] = true
    unionForce(xIdx, yIdx)

    // Resolve all neighbor references
    resolveAll(xIdx)

    area[xIdx] = polyArea(newVerts, mesh)
  }

  // Phase 1: Merge dead-ends
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < n; i++) {
      if (dead[i]) continue
      resolveAll(i)
      const nn = nb[i]!
      let travCount = 0, travEdge = -1
      for (let k = 0; k < nn.length; k++) {
        if (nn[k] !== -1 && nn[k] !== i) { travCount++; travEdge = k }
      }
      if (travCount === 1 && travEdge !== -1 && canMerge(i, travEdge)) {
        doMerge(i, travEdge, resolve(nn[travEdge]!))
        changed = true
      }
    }
  }

  // Phase 2: Smart merge (max-area PQ)
  const bestArea: number[] = new Array(n).fill(-1)

  function computeBest(idx: number): { area: number; edge: number } {
    if (dead[idx]) return { area: -1, edge: -1 }
    resolveAll(idx)
    const nn = nb[idx]!
    let best = -1, bestEdge = -1
    const seen = new Set<number>()
    for (let k = 0; k < nn.length; k++) {
      const r = nn[k]!
      if (r === -1 || r === idx || seen.has(r)) continue
      seen.add(r)
      if (!canMerge(idx, k)) continue
      const combined = area[idx]! + area[r]!
      if (combined > best) { best = combined; bestEdge = k }
    }
    return { area: best, edge: bestEdge }
  }

  // Max-heap
  interface HeapEntry { area: number; polyIndex: number }
  const heap: HeapEntry[] = []

  function heapPush(e: HeapEntry): void {
    heap.push(e)
    let i = heap.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (heap[p]!.area >= heap[i]!.area) break
      const t = heap[p]!; heap[p] = heap[i]!; heap[i] = t; i = p
    }
  }

  function heapPop(): HeapEntry | undefined {
    if (heap.length === 0) return undefined
    const top = heap[0]!
    const last = heap.pop()!
    if (heap.length > 0) {
      heap[0] = last
      let i = 0
      while (true) {
        let big = i
        const l = 2 * i + 1, r = 2 * i + 2
        if (l < heap.length && heap[l]!.area > heap[big]!.area) big = l
        if (r < heap.length && heap[r]!.area > heap[big]!.area) big = r
        if (big === i) break
        const t = heap[i]!; heap[i] = heap[big]!; heap[big] = t; i = big
      }
    }
    return top
  }

  for (let i = 0; i < n; i++) {
    if (dead[i]) continue
    const { area: a } = computeBest(i)
    bestArea[i] = a
    if (a > 0) heapPush({ area: a, polyIndex: i })
  }

  while (heap.length > 0) {
    const entry = heapPop()!
    const idx = find(entry.polyIndex)
    if (dead[idx] || entry.area !== bestArea[idx]) continue

    const { area: a, edge } = computeBest(idx)
    if (a <= 0 || edge === -1) { bestArea[idx] = -1; continue }
    if (Math.abs(a - entry.area) > 1e-10) {
      bestArea[idx] = a; heapPush({ area: a, polyIndex: idx }); continue
    }

    const yIdx = resolve(nb[idx]![edge]!)
    if (yIdx === -1 || dead[yIdx]) { bestArea[idx] = -1; continue }

    doMerge(idx, edge, yIdx)

    const { area: newA } = computeBest(idx)
    bestArea[idx] = newA
    if (newA > 0) heapPush({ area: newA, polyIndex: idx })

    const seen = new Set<number>()
    for (let k = 0; k < nb[idx]!.length; k++) {
      const nIdx = resolve(nb[idx]![k]!)
      if (nIdx === -1 || nIdx === idx || dead[nIdx] || seen.has(nIdx)) continue
      seen.add(nIdx)
      const { area: na } = computeBest(nIdx)
      bestArea[nIdx] = na
      if (na > 0) heapPush({ area: na, polyIndex: nIdx })
    }
  }

  // Final resolve pass
  for (let i = 0; i < n; i++) {
    if (dead[i]) continue
    const a = nb[i]!
    for (let j = 0; j < a.length; j++) {
      if (a[j] !== -1) {
        const r = find(a[j]!)
        a[j] = dead[r] ? -1 : r
      }
    }
  }

  return rebuildMesh(mesh, verts, nb, dead, weights, penalties)
}

function polyArea(vertexIndices: number[], mesh: Mesh): number {
  let a = 0
  const len = vertexIndices.length
  for (let i = 0; i < len; i++) {
    const p = mesh.vertices[vertexIndices[i]!]!.p
    const q = mesh.vertices[vertexIndices[(i + 1) % len]!]!.p
    a += p.x * q.y - q.x * p.y
  }
  return Math.abs(a) / 2
}

function rebuildMesh(
  original: Mesh,
  verts: number[][],
  neighbors: number[][],
  dead: boolean[],
  weights: number[],
  penalties: number[],
): Mesh {
  const aliveIndices: number[] = []
  const oldToNew: number[] = new Array(verts.length).fill(-1)
  for (let i = 0; i < verts.length; i++) {
    if (!dead[i]) { oldToNew[i] = aliveIndices.length; aliveIndices.push(i) }
  }

  const usedVerts = new Set<number>()
  for (const oldIdx of aliveIndices) {
    for (const vi of verts[oldIdx]!) usedVerts.add(vi)
  }

  const sortedUsedVerts = Array.from(usedVerts).sort((a, b) => a - b)
  const vertOldToNew = new Map<number, number>()
  for (let i = 0; i < sortedUsedVerts.length; i++) {
    vertOldToNew.set(sortedUsedVerts[i]!, i)
  }

  const polygons: Polygon[] = aliveIndices.map((oldIdx) => {
    const polyVerts = verts[oldIdx]!.map((vi) => vertOldToNew.get(vi)!)
    const polyNeigh = neighbors[oldIdx]!.map((ni) =>
      ni === -1 ? -1 : (oldToNew[ni] ?? -1),
    )

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const vi of verts[oldIdx]!) {
      const p = original.vertices[vi]!.p
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
    }

    let foundTrav = false, isOneWay = true
    for (const adj of polyNeigh) {
      if (adj !== -1) { if (foundTrav) isOneWay = false; else foundTrav = true }
    }

    return { vertices: polyVerts, polygons: polyNeigh, isOneWay, minX, maxX, minY, maxY, weight: weights[oldIdx]!, penalty: penalties[oldIdx]! }
  })

  const vertexPolygons: number[][] = new Array(sortedUsedVerts.length)
    .fill(null).map(() => [])
  for (let pi = 0; pi < polygons.length; pi++) {
    for (const vi of polygons[pi]!.vertices) vertexPolygons[vi]!.push(pi)
  }

  const vertices: Vertex[] = sortedUsedVerts.map((oldVi, newVi) => {
    const v = original.vertices[oldVi]!
    const polys = vertexPolygons[newVi]!

    polys.sort((a, b) => {
      const cA = polyCenter(polygons[a]!, sortedUsedVerts, original)
      const cB = polyCenter(polygons[b]!, sortedUsedVerts, original)
      return Math.atan2(cA.y - v.p.y, cA.x - v.p.x) - Math.atan2(cB.y - v.p.y, cB.x - v.p.x)
    })

    let isCorner = false, isAmbig = false
    for (const pi of polys) {
      const poly = polygons[pi]!
      const idx = poly.vertices.indexOf(newVi)
      if (idx === -1) continue
      const N = poly.vertices.length
      // Edges incident to this vertex
      const enterAdj = poly.polygons[idx]!
      const leaveAdj = poly.polygons[(idx + 1) % N]!
      if (enterAdj === -1 || leaveAdj === -1) {
        if (isCorner) isAmbig = true; else isCorner = true
      }
    }

    return { p: { x: v.p.x, y: v.p.y }, polygons: polys, isCorner, isAmbig }
  })

  return Mesh.fromData(vertices, polygons)
}

function polyCenter(poly: Polygon, sortedUsedVerts: number[], original: Mesh): Point {
  let cx = 0, cy = 0
  for (const vi of poly.vertices) {
    const p = original.vertices[sortedUsedVerts[vi]!]!.p
    cx += p.x; cy += p.y
  }
  return { x: cx / poly.vertices.length, y: cy / poly.vertices.length }
}
