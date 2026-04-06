import {
  BooleanOperations,
  Polygon as FlattenPolygon,
  point,
} from "@flatten-js/core"
import type { Point } from "./types.ts"

/** Convert a ring of Points to a flatten-js Polygon. */
function ringToFlattenPoly(ring: Point[]): FlattenPolygon {
  return new FlattenPolygon(ring.map((p) => point(p.x, p.y)))
}

/** Extract all face rings from a flatten-js Polygon as Point[][]. */
function extractFaces(poly: FlattenPolygon): Point[][] {
  const result: Point[][] = []
  for (const face of (poly as any).faces) {
    const ring: Point[] = []
    for (const v of face.vertices) {
      ring.push({ x: v.x, y: v.y })
    }
    if (ring.length >= 3) {
      result.push(ring)
    }
  }
  return result
}

/**
 * Merge all overlapping polygons (arbitrary shapes) into non-overlapping
 * union polygons using flatten-js boolean operations.
 *
 * Takes an array of closed rings (Point[][]) and merges any that overlap.
 * Returns an array of merged rings. Falls back to original polygons on error.
 */
export function mergeAllPolygons(polygons: Point[][]): Point[][] {
  if (polygons.length <= 1) return polygons

  try {
    let polys: FlattenPolygon[] = polygons.map(ringToFlattenPoly)

    // Iterative merge: two passes to catch transitive overlaps (A↔B, B↔C)
    for (let pass = 0; pass < 2; pass++) {
      const merged: FlattenPolygon[] = []
      const used = new Set<number>()

      for (let i = 0; i < polys.length; i++) {
        if (used.has(i)) continue
        let current = polys[i]!

        for (let j = i + 1; j < polys.length; j++) {
          if (used.has(j)) continue

          // Quick bbox pre-check
          const boxA = current.box
          const boxB = polys[j]!.box
          if (
            boxA.xmin > boxB.xmax + 1e-6 ||
            boxA.xmax < boxB.xmin - 1e-6 ||
            boxA.ymin > boxB.ymax + 1e-6 ||
            boxA.ymax < boxB.ymin - 1e-6
          ) {
            continue
          }

          try {
            const unified = BooleanOperations.unify(current, polys[j]!)
            if ((unified as any).faces.size > 0) {
              current = unified
              used.add(j)
            }
          } catch {
            // If unify fails for this pair, skip and keep both separate
          }
        }

        merged.push(current)
        used.add(i)
      }

      polys = merged
    }

    const result: Point[][] = []
    for (const poly of polys) {
      const faces = extractFaces(poly)
      result.push(...faces)
    }

    return result.length > 0 ? result : polygons
  } catch {
    return polygons
  }
}
