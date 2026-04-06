import {
  EPSILON,
  PointLocationType,
  PolyContainmentType,
  type PointLocation,
  type Point,
  type PolyContainment,
  type Polygon,
  type Vertex,
} from "./types.ts"
import { pointsEqual } from "./geometry.ts"

/**
 * Navigation mesh for Polyanya pathfinding.
 * Contains vertices and convex polygons with adjacency information.
 */
export class Mesh {
  vertices: Vertex[] = []
  polygons: Polygon[] = []
  maxPolySides = 0

  private slabs: Map<number, number[]> = new Map()
  private sortedSlabKeys: number[] = []
  private islands: number[] = []
  private minX = 0
  private maxX = 0
  private minY = 0
  private maxY = 0

  constructor() {}

  /**
   * Parse a .mesh file (version 2 format).
   *
   * Format:
   * ```
   * mesh
   * 2
   * V P
   * (for each vertex): x y numNeighbors poly0 poly1 ...
   * (for each polygon): numVertices v0 v1 ... adjPoly0 adjPoly1 ...
   * ```
   */
  static fromString(input: string): Mesh {
    const mesh = new Mesh()
    mesh.read(input)
    mesh.precalcPointLocation()
    return mesh
  }

  /**
   * Build a Mesh directly from arrays of vertices and polygons.
   * Use this when constructing a mesh programmatically (e.g. from convex regions).
   */
  static fromData(vertices: Vertex[], polygons: Polygon[]): Mesh {
    const mesh = new Mesh()
    mesh.vertices = vertices
    mesh.polygons = polygons
    mesh.maxPolySides = 0

    for (let i = 0; i < polygons.length; i++) {
      const p = polygons[i]!
      if (p.vertices.length > mesh.maxPolySides) {
        mesh.maxPolySides = p.vertices.length
      }
      if (i === 0) {
        mesh.minX = p.minX
        mesh.minY = p.minY
        mesh.maxX = p.maxX
        mesh.maxY = p.maxY
      } else {
        mesh.minX = Math.min(mesh.minX, p.minX)
        mesh.minY = Math.min(mesh.minY, p.minY)
        mesh.maxX = Math.max(mesh.maxX, p.maxX)
        mesh.maxY = Math.max(mesh.maxY, p.maxY)
      }
    }

    mesh.precalcPointLocation()
    return mesh
  }

  private read(input: string): void {
    const tokens = input.trim().split(/\s+/)
    let idx = 0
    const next = (): string => {
      const t = tokens[idx++]
      if (t === undefined) throw new Error("Unexpected end of mesh data")
      return t
    }

    const header = next()
    if (header !== "mesh") throw new Error(`Invalid header: '${header}'`)

    const version = Number.parseInt(next())
    if (version !== 2) throw new Error(`Invalid version: ${version}`)

    const V = Number.parseInt(next())
    const P = Number.parseInt(next())
    if (V < 1) throw new Error(`Invalid vertex count: ${V}`)
    if (P < 1) throw new Error(`Invalid polygon count: ${P}`)

    this.vertices = new Array(V)
    this.polygons = new Array(P)

    // Read vertices
    for (let i = 0; i < V; i++) {
      const x = Number.parseFloat(next())
      const y = Number.parseFloat(next())
      const numNeighbors = Number.parseInt(next())
      if (numNeighbors < 2)
        throw new Error(`Invalid neighbor count at vertex ${i}: ${numNeighbors}`)

      const polys: number[] = new Array(numNeighbors)
      let isCorner = false
      let isAmbig = false

      for (let j = 0; j < numNeighbors; j++) {
        const polyIndex = Number.parseInt(next())
        if (polyIndex >= P)
          throw new Error(`Invalid polygon index ${polyIndex} at vertex ${i}`)
        polys[j] = polyIndex
        if (polyIndex === -1) {
          if (isCorner) {
            isAmbig = true
          } else {
            isCorner = true
          }
        }
      }

      this.vertices[i] = { p: { x, y }, polygons: polys, isCorner, isAmbig }
    }

    // Read polygons
    this.maxPolySides = 0
    for (let i = 0; i < P; i++) {
      const n = Number.parseInt(next())
      if (n < 3) throw new Error(`Invalid vertex count in polygon ${i}: ${n}`)

      if (n > this.maxPolySides) this.maxPolySides = n

      const verts: number[] = new Array(n)
      let pMinX = 0
      let pMinY = 0
      let pMaxX = 0
      let pMaxY = 0

      for (let j = 0; j < n; j++) {
        const vi = Number.parseInt(next())
        if (vi >= V)
          throw new Error(`Invalid vertex index ${vi} in polygon ${i}`)
        verts[j] = vi
        const vp = this.vertices[vi]!.p
        if (j === 0) {
          pMinX = vp.x
          pMinY = vp.y
          pMaxX = vp.x
          pMaxY = vp.y
        } else {
          pMinX = Math.min(pMinX, vp.x)
          pMinY = Math.min(pMinY, vp.y)
          pMaxX = Math.max(pMaxX, vp.x)
          pMaxY = Math.max(pMaxY, vp.y)
        }
      }

      if (i === 0) {
        this.minX = pMinX
        this.minY = pMinY
        this.maxX = pMaxX
        this.maxY = pMaxY
      } else {
        this.minX = Math.min(this.minX, pMinX)
        this.minY = Math.min(this.minY, pMinY)
        this.maxX = Math.max(this.maxX, pMaxX)
        this.maxY = Math.max(this.maxY, pMaxY)
      }

      const adjPolys: number[] = new Array(n)
      let foundTrav = false
      let isOneWay = true

      for (let j = 0; j < n; j++) {
        const pi = Number.parseInt(next())
        if (pi >= P)
          throw new Error(`Invalid polygon index ${pi} in polygon ${i}`)
        adjPolys[j] = pi
        if (pi !== -1) {
          if (foundTrav) {
            isOneWay = false
          } else {
            foundTrav = true
          }
        }
      }

      this.polygons[i] = {
        vertices: verts,
        polygons: adjPolys,
        isOneWay,
        minX: pMinX,
        maxX: pMaxX,
        minY: pMinY,
        maxY: pMaxY,
        weight: 1.0,
        penalty: 0.0,
      }
    }
  }

  /** Build slab-based spatial index for fast point location */
  private precalcPointLocation(): void {
    this.slabs.clear()
    for (const v of this.vertices) {
      if (!this.slabs.has(v.p.x)) {
        this.slabs.set(v.p.x, [])
      }
    }

    for (let i = 0; i < this.polygons.length; i++) {
      const p = this.polygons[i]!
      for (const [key, arr] of this.slabs) {
        if (key >= p.minX && key < p.maxX + EPSILON) {
          arr.push(i)
        }
      }
    }

    // Sort each slab by polygon midpoint y
    for (const [, arr] of this.slabs) {
      arr.sort((a, b) => {
        const ap = this.polygons[a]!
        const bp = this.polygons[b]!
        const as = ap.minY + ap.maxY
        const bs = bp.minY + bp.maxY
        if (as === bs) {
          return (bp.maxY - bp.minY) - (ap.maxY - ap.minY)
        }
        return as - bs
      })
    }

    this.sortedSlabKeys = Array.from(this.slabs.keys()).sort((a, b) => a - b)
    this.computeIslands()
  }

  /** BFS flood-fill to assign connected component IDs to each polygon */
  private computeIslands(): void {
    const n = this.polygons.length
    this.islands = new Array(n).fill(-1)
    let islandId = 0

    for (let start = 0; start < n; start++) {
      if (this.islands[start] !== -1) continue

      // BFS from this polygon
      const queue: number[] = [start]
      this.islands[start] = islandId
      let head = 0

      while (head < queue.length) {
        const polyIdx = queue[head++]!
        const adj = this.polygons[polyIdx]!.polygons
        for (let j = 0; j < adj.length; j++) {
          const neighbor = adj[j]!
          if (neighbor !== -1 && this.islands[neighbor] === -1) {
            this.islands[neighbor] = islandId
            queue.push(neighbor)
          }
        }
      }

      islandId++
    }
  }

  /** Check if two polygons are on the same connected island */
  sameIsland(polyA: number, polyB: number): boolean {
    if (polyA < 0 || polyB < 0) return false
    return this.islands[polyA] === this.islands[polyB]
  }

  /** Test if a polygon contains a point */
  polyContainsPoint(polyIndex: number, p: Point): PolyContainment {
    const poly = this.polygons[polyIndex]!
    const outside: PolyContainment = {
      type: PolyContainmentType.OUTSIDE,
      adjacentPoly: -1,
      vertex1: -1,
      vertex2: -1,
    }

    if (
      p.x < poly.minX - EPSILON ||
      p.x > poly.maxX + EPSILON ||
      p.y < poly.minY - EPSILON ||
      p.y > poly.maxY + EPSILON
    ) {
      return outside
    }

    const ZERO: Point = { x: 0, y: 0 }
    const lastVertexIdx = poly.vertices[poly.vertices.length - 1]!
    let last: Point = {
      x: this.vertices[lastVertexIdx]!.p.x - p.x,
      y: this.vertices[lastVertexIdx]!.p.y - p.y,
    }

    if (pointsEqual(last, ZERO)) {
      return {
        type: PolyContainmentType.ON_VERTEX,
        adjacentPoly: -1,
        vertex1: lastVertexIdx,
        vertex2: -1,
      }
    }

    let lastIndex = lastVertexIdx
    for (let i = 0; i < poly.vertices.length; i++) {
      const pointIndex = poly.vertices[i]!
      const cur: Point = {
        x: this.vertices[pointIndex]!.p.x - p.x,
        y: this.vertices[pointIndex]!.p.y - p.y,
      }

      if (pointsEqual(cur, ZERO)) {
        return {
          type: PolyContainmentType.ON_VERTEX,
          adjacentPoly: -1,
          vertex1: pointIndex,
          vertex2: -1,
        }
      }

      const curA = last.x * cur.y - last.y * cur.x
      if (Math.abs(curA) < EPSILON) {
        // Collinear — check if point is between last and cur
        if (cur.x) {
          if (!((cur.x > 0) !== (last.x > 0))) {
            last = cur
            lastIndex = pointIndex
            continue
          }
        } else {
          if (!((cur.y > 0) !== (last.y > 0))) {
            last = cur
            lastIndex = pointIndex
            continue
          }
        }
        return {
          type: PolyContainmentType.ON_EDGE,
          adjacentPoly: poly.polygons[i]!,
          vertex1: pointIndex,
          vertex2: lastIndex,
        }
      }

      if (curA < 0) {
        return outside
      }

      last = cur
      lastIndex = pointIndex
    }

    return {
      type: PolyContainmentType.INSIDE,
      adjacentPoly: -1,
      vertex1: -1,
      vertex2: -1,
    }
  }

  /** Find where a point is located on the mesh */
  getPointLocation(p: Point): PointLocation {
    const notOnMesh: PointLocation = {
      type: PointLocationType.NOT_ON_MESH,
      poly1: -1,
      poly2: -1,
      vertex1: -1,
      vertex2: -1,
    }

    if (
      p.x < this.minX - EPSILON ||
      p.x > this.maxX + EPSILON ||
      p.y < this.minY - EPSILON ||
      p.y > this.maxY + EPSILON
    ) {
      return notOnMesh
    }

    // Find the slab (largest key <= p.x + EPSILON) via binary search
    const target = p.x + EPSILON
    const keys = this.sortedSlabKeys
    let lo = 0
    let hi = keys.length - 1
    let slabIdx = -1
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      if (keys[mid]! <= target) {
        slabIdx = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    if (slabIdx === -1) return notOnMesh
    const slabKey = keys[slabIdx]!

    const polys = this.slabs.get(slabKey)!

    // Find closest polygon by y midpoint, then spiral outward
    let closeIndex = 0
    for (let i = 0; i < polys.length; i++) {
      const poly = this.polygons[polys[i]!]!
      if (poly.minY + poly.maxY >= p.y * 2) {
        closeIndex = i
        break
      }
      closeIndex = i
    }

    const ps = polys.length
    let i = closeIndex
    let nextDelta = 1
    let walkDelta = 0

    while (i >= 0 && i < ps) {
      const polygon = polys[i]!
      const result = this.polyContainsPoint(polygon, p)

      switch (result.type) {
        case PolyContainmentType.OUTSIDE:
          break

        case PolyContainmentType.INSIDE:
          return {
            type: PointLocationType.IN_POLYGON,
            poly1: polygon,
            poly2: -1,
            vertex1: -1,
            vertex2: -1,
          }

        case PolyContainmentType.ON_EDGE:
          return {
            type:
              result.adjacentPoly === -1
                ? PointLocationType.ON_MESH_BORDER
                : PointLocationType.ON_EDGE,
            poly1: polygon,
            poly2: result.adjacentPoly,
            vertex1: result.vertex1,
            vertex2: result.vertex2,
          }

        case PolyContainmentType.ON_VERTEX: {
          const v = this.vertices[result.vertex1]!
          if (v.isCorner) {
            if (v.isAmbig) {
              return {
                type: PointLocationType.ON_CORNER_VERTEX_AMBIG,
                poly1: -1,
                poly2: -1,
                vertex1: result.vertex1,
                vertex2: -1,
              }
            }
            return {
              type: PointLocationType.ON_CORNER_VERTEX_UNAMBIG,
              poly1: polygon,
              poly2: -1,
              vertex1: result.vertex1,
              vertex2: -1,
            }
          }
          return {
            type: PointLocationType.ON_NON_CORNER_VERTEX,
            poly1: polygon,
            poly2: -1,
            vertex1: result.vertex1,
            vertex2: -1,
          }
        }
      }

      // Spiral search pattern: +1, -2, +3, -4, ...
      if (walkDelta === 0) {
        const nextI =
          i + nextDelta * (2 * (nextDelta & 1) - 1)
        if (nextI < 0) {
          walkDelta = 1
        } else if (nextI >= ps) {
          walkDelta = -1
        } else {
          i = nextI
          nextDelta++
        }
      }
      if (walkDelta !== 0) {
        i += walkDelta
      }
    }

    return notOnMesh
  }

  /** Brute-force point location (for testing/validation) */
  getPointLocationNaive(p: Point): PointLocation {
    const notOnMesh: PointLocation = {
      type: PointLocationType.NOT_ON_MESH,
      poly1: -1,
      poly2: -1,
      vertex1: -1,
      vertex2: -1,
    }

    for (let polygon = 0; polygon < this.polygons.length; polygon++) {
      const result = this.polyContainsPoint(polygon, p)
      switch (result.type) {
        case PolyContainmentType.OUTSIDE:
          break
        case PolyContainmentType.INSIDE:
          return {
            type: PointLocationType.IN_POLYGON,
            poly1: polygon,
            poly2: -1,
            vertex1: -1,
            vertex2: -1,
          }
        case PolyContainmentType.ON_EDGE:
          return {
            type:
              result.adjacentPoly === -1
                ? PointLocationType.ON_MESH_BORDER
                : PointLocationType.ON_EDGE,
            poly1: polygon,
            poly2: result.adjacentPoly,
            vertex1: result.vertex1,
            vertex2: result.vertex2,
          }
        case PolyContainmentType.ON_VERTEX: {
          const v = this.vertices[result.vertex1]!
          if (v.isCorner) {
            if (v.isAmbig) {
              return {
                type: PointLocationType.ON_CORNER_VERTEX_AMBIG,
                poly1: -1,
                poly2: -1,
                vertex1: result.vertex1,
                vertex2: -1,
              }
            }
            return {
              type: PointLocationType.ON_CORNER_VERTEX_UNAMBIG,
              poly1: polygon,
              poly2: -1,
              vertex1: result.vertex1,
              vertex2: -1,
            }
          }
          return {
            type: PointLocationType.ON_NON_CORNER_VERTEX,
            poly1: polygon,
            poly2: -1,
            vertex1: result.vertex1,
            vertex2: -1,
          }
        }
      }
    }

    return notOnMesh
  }
}
