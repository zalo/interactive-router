import type { Point, WeightedRegion } from "./types.ts"
import { EPSILON } from "./types.ts"
import { buildSegmentBVH, queryAABB, type BVHNode, type Segment } from "./bvh.ts"
import { lineIntersectTime } from "./geometry.ts"

/** Precomputed structure for BVH-accelerated weighted edge cost queries */
export interface WeightedEdgeContext {
  segments: Segment[]
  segmentRegionIdx: number[]
  bvh: BVHNode
  regions: WeightedRegion[]
}

/**
 * Build a WeightedEdgeContext from weighted regions.
 * Flattens all region boundary edges into segments and builds a BVH.
 */
export function buildWeightedEdgeContext(regions: WeightedRegion[]): WeightedEdgeContext {
  const segments: Segment[] = []
  const segmentRegionIdx: number[] = []

  for (let i = 0; i < regions.length; i++) {
    const poly = regions[i]!.polygon
    const N = poly.length
    for (let j = 0; j < N; j++) {
      const a = poly[j]!
      const b = poly[(j + 1) % N]!
      segments.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y })
      segmentRegionIdx.push(i)
    }
  }

  const bvh = buildSegmentBVH(segments)
  return { segments, segmentRegionIdx, bvh, regions }
}

/**
 * Test if a point is inside a convex polygon (CCW winding).
 * Uses half-plane test: point must be on the left side of every edge.
 */
export function pointInConvexPolygon(p: Point, polygon: Point[]): boolean {
  const N = polygon.length
  for (let i = 0; i < N; i++) {
    const a = polygon[i]!
    const b = polygon[(i + 1) % N]!
    // Cross product of edge vector (a→b) and point vector (a→p)
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    if (cross < -EPSILON) return false // point is on the right side
  }
  return true
}

/**
 * Compute the weighted traversal cost of a line segment a→b.
 * Intersects the segment with all weighted region boundaries,
 * splits into sub-segments, and weights each by the region it falls in.
 */
export function computeWeightedEdgeCost(
  a: Point,
  b: Point,
  ctx: WeightedEdgeContext,
): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const totalLen = Math.sqrt(dx * dx + dy * dy)
  if (totalLen < EPSILON) return 0

  // Compute AABB of the edge
  const qMinX = Math.min(a.x, b.x) - EPSILON
  const qMinY = Math.min(a.y, b.y) - EPSILON
  const qMaxX = Math.max(a.x, b.x) + EPSILON
  const qMaxY = Math.max(a.y, b.y) + EPSILON

  // Query BVH for candidate boundary segments
  const candidates: number[] = []
  queryAABB(ctx.bvh, qMinX, qMinY, qMaxX, qMaxY, ctx.segments, candidates)

  // Collect t-values where the edge crosses region boundaries
  const tValues: number[] = [0, 1]

  for (const segIdx of candidates) {
    const seg = ctx.segments[segIdx]!
    const c: Point = { x: seg.ax, y: seg.ay }
    const d: Point = { x: seg.bx, y: seg.by }

    const { abNum, cdNum, denom } = lineIntersectTime(a, b, c, d)
    if (Math.abs(denom) < EPSILON) continue // parallel

    const tAB = abNum / denom
    const tCD = cdNum / denom

    // Only keep crossings strictly inside both segments
    if (tAB > EPSILON && tAB < 1 - EPSILON && tCD > -EPSILON && tCD < 1 + EPSILON) {
      tValues.push(tAB)
    }
  }

  // Sort and deduplicate
  tValues.sort((x, y) => x - y)
  const unique: number[] = [tValues[0]!]
  for (let i = 1; i < tValues.length; i++) {
    if (tValues[i]! - unique[unique.length - 1]! > EPSILON) {
      unique.push(tValues[i]!)
    }
  }

  // For each sub-segment, test midpoint against regions
  let cost = 0
  let prevRegion = -1

  for (let i = 0; i < unique.length - 1; i++) {
    const t0 = unique[i]!
    const t1 = unique[i + 1]!
    const segLen = (t1 - t0) * totalLen

    // Midpoint of sub-segment
    const tMid = (t0 + t1) / 2
    const mid: Point = {
      x: a.x + dx * tMid,
      y: a.y + dy * tMid,
    }

    // Find which region (if any) the midpoint is in
    let regionIdx = -1
    for (let r = 0; r < ctx.regions.length; r++) {
      if (pointInConvexPolygon(mid, ctx.regions[r]!.polygon)) {
        regionIdx = r
        break
      }
    }

    if (regionIdx >= 0) {
      const region = ctx.regions[regionIdx]!
      cost += segLen * region.weight

      // Add penalty once on transition into a new region
      if (regionIdx !== prevRegion) {
        cost += region.penalty
      }
    } else {
      cost += segLen // weight = 1 for open space
    }

    prevRegion = regionIdx
  }

  return cost
}
