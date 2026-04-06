import type { Point } from "./types.ts"

/**
 * Detect crossing constraint edges, insert intersection points,
 * and split the edges so cdt2d receives a valid (non-crossing) constraint set.
 *
 * Only checks edges from different rings — edges within the same ring
 * are sequential and never cross.
 *
 * Ported from find-convex-regions resolveConstraintCrossings.
 */
export function resolveConstraintCrossings(
  pts: [number, number][],
  constraintEdges: [number, number][],
  ringBoundaries: number[],
): {
  pts: [number, number][]
  constraintEdges: [number, number][]
  hadCrossings: boolean
} {
  // Determine which ring each edge belongs to
  const edgeRing: number[] = new Array(constraintEdges.length)
  for (let ei = 0; ei < constraintEdges.length; ei++) {
    for (let ri = ringBoundaries.length - 1; ri >= 0; ri--) {
      if (ei >= ringBoundaries[ri]!) {
        edgeRing[ei] = ri
        break
      }
    }
  }

  // Collect all intersection points per edge
  type Split = { t: number; idx: number }
  const edgeSplits = new Map<number, Split[]>()

  const outPts = pts.slice()

  for (let i = 0; i < constraintEdges.length; i++) {
    for (let j = i + 1; j < constraintEdges.length; j++) {
      if (edgeRing[i] === edgeRing[j]) continue

      const [a1, a2] = constraintEdges[i]!
      const [b1, b2] = constraintEdges[j]!
      const p1 = outPts[a1]!
      const p2 = outPts[a2]!
      const p3 = outPts[b1]!
      const p4 = outPts[b2]!

      const d1x = p2[0] - p1[0]
      const d1y = p2[1] - p1[1]
      const d2x = p4[0] - p3[0]
      const d2y = p4[1] - p3[1]
      const denom = d1x * d2y - d1y * d2x

      if (Math.abs(denom) < 1e-10) {
        // Collinear edges — check for overlap and insert split points
        // at the other edge's endpoints so overlapping segments share vertices.
        const len1sq = d1x * d1x + d1y * d1y
        if (len1sq < 1e-20) continue
        const len2sq = d2x * d2x + d2y * d2y
        if (len2sq < 1e-20) continue

        // Check that edges are actually on the same line (not just parallel)
        const perpDist =
          Math.abs((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) /
          Math.sqrt(len1sq)
        if (perpDist > 1e-6) continue

        // Project edge j's endpoints onto edge i's parameter space
        const t3 =
          ((p3[0] - p1[0]) * d1x + (p3[1] - p1[1]) * d1y) / len1sq
        const t4 =
          ((p4[0] - p1[0]) * d1x + (p4[1] - p1[1]) * d1y) / len1sq

        // Project edge i's endpoints onto edge j's parameter space
        const u1 =
          ((p1[0] - p3[0]) * d2x + (p1[1] - p3[1]) * d2y) / len2sq
        const u2 =
          ((p2[0] - p3[0]) * d2x + (p2[1] - p3[1]) * d2y) / len2sq

        const EPS = 1e-6

        // If edge j's start (p3, index b1) falls strictly inside edge i,
        // split edge i at b1's existing index (reuse vertex, don't duplicate)
        if (t3 > EPS && t3 < 1 - EPS) {
          if (!edgeSplits.has(i)) edgeSplits.set(i, [])
          edgeSplits.get(i)!.push({ t: t3, idx: b1 })
        }
        // If edge j's end (p4, index b2) falls strictly inside edge i
        if (t4 > EPS && t4 < 1 - EPS) {
          if (!edgeSplits.has(i)) edgeSplits.set(i, [])
          edgeSplits.get(i)!.push({ t: t4, idx: b2 })
        }
        // If edge i's start (p1, index a1) falls strictly inside edge j
        if (u1 > EPS && u1 < 1 - EPS) {
          if (!edgeSplits.has(j)) edgeSplits.set(j, [])
          edgeSplits.get(j)!.push({ t: u1, idx: a1 })
        }
        // If edge i's end (p2, index a2) falls strictly inside edge j
        if (u2 > EPS && u2 < 1 - EPS) {
          if (!edgeSplits.has(j)) edgeSplits.set(j, [])
          edgeSplits.get(j)!.push({ t: u2, idx: a2 })
        }

        continue
      }

      const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / denom
      const u = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / denom

      if (t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6) {
        const ix = p1[0] + t * d1x
        const iy = p1[1] + t * d1y
        const newIdx = outPts.length
        outPts.push([ix, iy])

        if (!edgeSplits.has(i)) edgeSplits.set(i, [])
        edgeSplits.get(i)!.push({ t, idx: newIdx })

        if (!edgeSplits.has(j)) edgeSplits.set(j, [])
        edgeSplits.get(j)!.push({ t: u, idx: newIdx })
      }
    }
  }

  if (edgeSplits.size === 0) {
    return { pts, constraintEdges, hadCrossings: false }
  }

  // Rebuild constraint edges, splitting any that have intersection points
  const outEdges: [number, number][] = []

  for (let ei = 0; ei < constraintEdges.length; ei++) {
    const splits = edgeSplits.get(ei)
    if (!splits || splits.length === 0) {
      outEdges.push(constraintEdges[ei]!)
      continue
    }

    // Sort by parameter t along the edge
    splits.sort((a, b) => a.t - b.t)

    const [startIdx, endIdx] = constraintEdges[ei]!
    let prev = startIdx
    for (const split of splits) {
      outEdges.push([prev, split.idx])
      prev = split.idx
    }
    outEdges.push([prev, endIdx])
  }

  return { pts: outPts, constraintEdges: outEdges, hadCrossings: true }
}
