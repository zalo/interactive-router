import type { Mesh } from "./mesh.ts"
import { Mesh as MeshClass } from "./mesh.ts"
import type { Point, Polygon, Vertex } from "./types.ts"

/**
 * Input for building a navigation mesh from convex regions.
 * Regions are convex polygons (arrays of points in CCW order)
 * that share edges to form a navigation mesh.
 */
export interface MeshBuilderInput {
  regions: Point[][]
  regionWeights?: { weight: number; penalty: number }[]
}

/**
 * Build a Polyanya navigation mesh from an array of convex regions.
 *
 * The regions should be convex polygons sharing edges. Two regions that
 * share an edge will be considered adjacent (traversable between).
 *
 * Use `cdtTriangulate()` to decompose a 2D space with obstacles into
 * triangle regions suitable for this function.
 */
export function buildMeshFromRegions(input: MeshBuilderInput): Mesh {
  const { regions } = input

  // Step 1: Deduplicate vertices
  // Use fixed decimal rounding to avoid floating-point hash collisions
  const SNAP_DIGITS = 4
  const vertexMap: Map<string, number> = new Map()
  const vertices: { x: number; y: number }[] = []

  const getVertexIndex = (p: Point): number => {
    const sx = p.x.toFixed(SNAP_DIGITS)
    const sy = p.y.toFixed(SNAP_DIGITS)
    const key = `${sx},${sy}`
    const existing = vertexMap.get(key)
    if (existing !== undefined) return existing
    const idx = vertices.length
    vertices.push({ x: p.x, y: p.y })
    vertexMap.set(key, idx)
    return idx
  }

  // Convert regions to vertex indices
  const regionIndices: number[][] = regions.map((region) =>
    region.map((p) => getVertexIndex(p)),
  )

  // Step 2: Build edge-to-polygon adjacency
  // An edge is identified by its two vertex indices (sorted)
  const edgeToPolys: Map<string, number[]> = new Map()

  const edgeKey = (a: number, b: number): string => {
    return a < b ? `${a},${b}` : `${b},${a}`
  }

  for (let pi = 0; pi < regionIndices.length; pi++) {
    const verts = regionIndices[pi]!
    for (let j = 0; j < verts.length; j++) {
      const a = verts[j]!
      const b = verts[(j + 1) % verts.length]!
      const key = edgeKey(a, b)
      if (!edgeToPolys.has(key)) {
        edgeToPolys.set(key, [])
      }
      edgeToPolys.get(key)!.push(pi)
    }
  }

  // Step 3: Build polygon adjacency arrays
  const polygons: Polygon[] = regionIndices.map((verts, pi) => {
    const adjPolys: number[] = new Array(verts.length)
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity

    for (let j = 0; j < verts.length; j++) {
      const a = verts[j]!
      const b = verts[(j + 1) % verts.length]!
      const key = edgeKey(a, b)
      const neighbors = edgeToPolys.get(key)!
      // Polyanya convention: polygons[i] is adjacent to edge (V[i-1], V[i])
      // Edge (a, b) = edge from V[j] to V[(j+1)%N], so it maps to adjPolys[(j+1)%N]
      const adjIdx = (j + 1) % verts.length
      adjPolys[adjIdx] = neighbors.length === 2
        ? neighbors[0] === pi
          ? neighbors[1]!
          : neighbors[0]!
        : -1 // boundary edge

      const vp = vertices[a]!
      minX = Math.min(minX, vp.x)
      maxX = Math.max(maxX, vp.x)
      minY = Math.min(minY, vp.y)
      maxY = Math.max(maxY, vp.y)
    }

    let foundTrav = false
    let isOneWay = true
    for (const adj of adjPolys) {
      if (adj !== -1) {
        if (foundTrav) isOneWay = false
        else foundTrav = true
      }
    }

    const rw = input.regionWeights?.[pi]
    return {
      vertices: verts,
      polygons: adjPolys,
      isOneWay,
      minX,
      maxX,
      minY,
      maxY,
      weight: rw?.weight ?? 1.0,
      penalty: rw?.penalty ?? 0.0,
    }
  })

  // Step 4: Build vertex objects with adjacency
  const vertexPolygons: number[][] = new Array(vertices.length)
    .fill(null)
    .map(() => [])

  for (let pi = 0; pi < polygons.length; pi++) {
    for (const vi of polygons[pi]!.vertices) {
      vertexPolygons[vi]!.push(pi)
    }
  }

  // Order vertex polygons CCW around each vertex
  const meshVertices: Vertex[] = vertices.map((v, vi) => {
    const polys = vertexPolygons[vi]!

    // Sort polygons CCW around vertex
    polys.sort((a, b) => {
      const polyA = polygons[a]!
      const polyB = polygons[b]!
      const centerA = polygonCenter(polyA, vertices)
      const centerB = polygonCenter(polyB, vertices)
      const angleA = Math.atan2(centerA.y - v.y, centerA.x - v.x)
      const angleB = Math.atan2(centerB.y - v.y, centerB.x - v.x)
      return angleA - angleB
    })

    // Determine corner status by checking if any adjacent edge is a boundary
    let isCorner = false
    let isAmbig = false

    // Check edges incident to this vertex
    for (let pi of polys) {
      const poly = polygons[pi]!
      const idx = poly.vertices.indexOf(vi)
      if (idx === -1) continue
      // Check the edge before and after this vertex
      const prevEdgeAdj = poly.polygons[(idx + poly.vertices.length - 1) % poly.vertices.length]!
      const nextEdgeAdj = poly.polygons[idx]!
      if (prevEdgeAdj === -1 || nextEdgeAdj === -1) {
        if (isCorner) isAmbig = true
        else isCorner = true
      }
    }

    return {
      p: { x: v.x, y: v.y },
      polygons: polys,
      isCorner,
      isAmbig,
    }
  })

  return MeshClass.fromData(meshVertices, polygons)
}

function polygonCenter(
  poly: Polygon,
  vertices: { x: number; y: number }[],
): Point {
  let cx = 0
  let cy = 0
  for (const vi of poly.vertices) {
    cx += vertices[vi]!.x
    cy += vertices[vi]!.y
  }
  return { x: cx / poly.vertices.length, y: cy / poly.vertices.length }
}
