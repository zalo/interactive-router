// Geometry primitives ported from geometry.rb and router.rb
// Stefan Salewski's Rubberband Router

import { orient2d } from 'robust-predicates';

/**
 * 2D cross product with offset (exact arithmetic via robust-predicates):
 *       b
 *      ^
 *     /
 *   o/--------> a
 *
 * Returns true if cross product > 0 (b is to the left of a relative to o)
 * For collinear points, returns an arbitrary but consistent result.
 *
 * Ruby: boolean_really_smart_cross_product_2d_with_offset(a, b, o)
 * Uses orient2d for exact arithmetic matching Ruby's integer exactness.
 */
export function booleanCrossProduct2D(
  ax: number, ay: number,
  bx: number, by: number,
  ox: number, oy: number
): boolean {
  // Ruby: (ax-ox)*(by-oy) - (ay-oy)*(bx-ox) > 0
  // orient2d returns the NEGATIVE of this (opposite sign convention)
  // So we check p < 0 to match Ruby's p > 0
  const p = orient2d(ox, oy, ax, ay, bx, by);
  if (p !== 0) return p < 0;
  // Collinear: arbitrary but well-defined result (matches Ruby tiebreaker)
  const dax = ax - ox, dbx = bx - ox;
  const day = ay - oy, dby = by - oy;
  return dax !== dbx ? dax < dbx : day < dby;
}

/**
 * Cross product for region vertices with offsets (rx, ry).
 * Corresponds to Ruby xboolean_really_smart_cross_product_2d_with_offset(a, b, o):
 *   ax = a.vertex.x + a.ox (= a.rx), ay = a.vertex.y + a.oy (= a.ry)
 *   bx = b.vertex.x + b.ox (= b.rx), by = b.vertex.y + b.oy (= b.ry)
 *   ox = o.vertex.x, oy = o.vertex.y
 * NOTE: Ruby line 113 has a bug (b.vertex.y + b.ox instead of b.oy); we use b.ry which is correct.
 */
export function booleanCrossProductRegion(
  arx: number, ary: number,
  brx: number, bry: number,
  ox: number, oy: number
): boolean {
  return booleanCrossProduct2D(arx, ary, brx, bry, ox, oy);
}

/**
 * Get tangent line between two circles
 * http://en.wikipedia.org/wiki/Tangent_lines_to_circles
 * l1, l2: true for right tangent, false for left
 * Returns [x1, y1, x2, y2] endpoints of the tangent line
 */
export function getTangents(
  x1: number, y1: number, r1: number, l1: boolean,
  x2: number, y2: number, r2: number, l2: boolean
): [number, number, number, number] {
  const d = Math.hypot(x1 - x2, y1 - y2);
  if (d === 0) return [x1, y1, x2, y2];
  const vx = (x2 - x1) / d;
  const vy = (y2 - y1) / d;
  const r2m = r2 * (l1 === l2 ? 1 : -1);
  const c = (r1 - r2m) / d;
  let h = 1 - c * c;
  if (h < 0) h = 0;
  h = Math.sqrt(h) * (l1 ? -1 : 1);
  const nx = vx * c - h * vy;
  const ny = vy * c + h * vx;
  return [
    x1 + r1 * nx, y1 + r1 * ny,
    x2 + r2m * nx, y2 + r2m * ny
  ];
}

/**
 * Distance from a point to a line (not segment)
 * http://mathworld.wolfram.com/Point-LineDistance2-Dimensional.html
 */
export function distanceLinePoint(
  x1: number, y1: number,
  x2: number, y2: number,
  x0: number, y0: number
): number {
  const x12 = x2 - x1;
  const y12 = y2 - y1;
  return Math.abs(x12 * (y1 - y0) - (x1 - x0) * y12) / Math.hypot(x12, y12);
}

export function distanceLinePointSquared(
  x1: number, y1: number,
  x2: number, y2: number,
  x0: number, y0: number
): number {
  const x12 = x2 - x1;
  const y12 = y2 - y1;
  const num = x12 * (y1 - y0) - (x1 - x0) * y12;
  return (num * num) / (x12 * x12 + y12 * y12);
}

/**
 * Normal distance from line segment to point (squared).
 * Returns MBD if projection falls outside segment.
 */
export function normalDistanceLineSegmentPointSquared(
  bx: number, by: number,
  cx: number, cy: number,
  px: number, py: number,
  MBD: number
): number {
  const mx = cx - bx;
  const my = cy - by;
  const hx = px - bx;
  const hy = py - by;
  const t0 = (mx * hx + my * hy) / (mx * mx + my * my);
  if (t0 > 0 && t0 < 1) {
    const dx = hx - t0 * mx;
    const dy = hy - t0 * my;
    return dx * dx + dy * dy;
  }
  return MBD;
}

/**
 * Distance from line segment to point (squared)
 */
export function distanceLineSegmentPointSquared(
  bx: number, by: number,
  cx: number, cy: number,
  px: number, py: number
): number {
  const mx = cx - bx;
  const my = cy - by;
  let hx = px - bx;
  let hy = py - by;
  const t0 = (mx * hx + my * hy) / (mx * mx + my * my);
  if (t0 <= 0) {
    // closest to b
  } else if (t0 < 1) {
    hx -= t0 * mx;
    hy -= t0 * my;
  } else {
    hx -= mx;
    hy -= my;
  }
  return hx * hx + hy * hy;
}

/**
 * Intersection point of two lines
 * http://paulbourke.net/geometry/pointlineplane/
 * Returns [x, y, ua, ub] or null if parallel
 */
export function lineLineIntersection(
  x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number
): [number, number, number, number] | null {
  const x2x1 = x2 - x1;
  const y2y1 = y2 - y1;
  const d = (y4 - y3) * x2x1 - (x4 - x3) * y2y1;
  if (d === 0) return null;
  const ua = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / d;
  const ub = (x2x1 * (y1 - y3) - y2y1 * (x1 - x3)) / d;
  return [x1 + ua * x2x1, y1 + ua * y2y1, ua, ub];
}

/**
 * Point-in-polygon test (ray casting)
 * http://www.ecse.rpi.edu/Homepages/wrf/Research/Short_Notes/pnpoly.html
 */
export function pointInPolygon(
  polygon: { x: number; y: number }[],
  px: number, py: number
): boolean {
  let c = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const pi = polygon[i];
    const pj = polygon[j];
    if (((pi.y <= py && py < pj.y) || (pj.y <= py && py < pi.y)) &&
      px < (pj.x - pi.x) * (py - pi.y) / (pj.y - pi.y) + pi.x) {
      c = !c;
    }
  }
  return c;
}

/**
 * Point in triangle test using barycentric coordinates
 * Returns: 1 = inside, 0 = on border, -1 = outside, -2 = collinear
 */
export function pointInTriangle(
  x1: number, y1: number,
  x2: number, y2: number,
  x3: number, y3: number,
  x: number, y: number
): number {
  const d = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
  if (d === 0) return -2; // collinear
  const l1 = ((y2 - y3) * (x - x3) + (x3 - x2) * (y - y3)) / d;
  const l2 = ((y3 - y1) * (x - x3) + (x1 - x3) * (y - y3)) / d;
  const l3 = 1 - l1 - l2;
  const min = Math.min(l1, l2, l3);
  const max = Math.max(l1, l2, l3);
  if (min >= 0 && max <= 1) {
    return (min > 0 && max < 1) ? 1 : 0;
  }
  return -1;
}

/**
 * Segment-segment intersection test
 */
export function segmentIntersects(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number
): boolean {
  // Skip if endpoints match
  if ((cx === ax && cy === ay) || (dx === ax && dy === ay) ||
    (cx === bx && cy === by) || (dx === bx && dy === by)) {
    return false;
  }
  const cp = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    (px - rx) * (qy - ry) < (py - ry) * (qx - rx);

  return (cp(bx, by, cx, cy, ax, ay) !== cp(bx, by, dx, dy, ax, ay)) &&
    (cp(dx, dy, ax, ay, cx, cy) !== cp(dx, dy, bx, by, cx, cy));
}

/**
 * Vertices in polygon
 */
export function verticesInPolygon<T extends { x: number; y: number }>(
  polygon: { x: number; y: number }[],
  vertices: T[]
): T[] {
  return vertices.filter(v => pointInPolygon(polygon, v.x, v.y));
}

/**
 * Apollonius convex hull: convex hull of weighted circles.
 * Port of Ruby circles_touching_convex_hull (geometry.rb line 269).
 *
 * Each input element must have x, y, and tradius (the weighted radius).
 * Returns the subset of input vertices that touch the weighted convex hull,
 * sorted angularly and processed through a gift-wrapping pass using
 * tangent lines between circles.
 */
export function apolloniusConvexHull<T extends { x: number; y: number; tradius: number; trgt: boolean }>(
  vertices: T[]
): T[] {
  if (vertices.length < 2) return [...vertices];

  // Step 1: Remove fully overlapping circles
  // If distance(a,b) + a.tradius < b.tradius, then a is inside b
  const inner = new Set<T>();
  for (let i = 0; i < vertices.length; i++) {
    for (let j = i + 1; j < vertices.length; j++) {
      const a = vertices[i];
      const b = vertices[j];
      const d2 = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
      const rDiff = b.tradius - a.tradius;
      if (d2 < rDiff * rDiff) {
        // d < |R - r|, so the smaller circle is inside the larger
        inner.add(a.tradius < b.tradius ? a : b);
      }
    }
  }

  let verts = vertices.filter(v => !inner.has(v));
  verts.sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);
  if (verts.length < 3) return [...verts];

  // Step 2: Andrew's monotone chain for hull of centers
  const upper: T[] = [];
  for (const v of verts) {
    while (upper.length > 1) {
      const x1 = upper[upper.length - 2].x, y1 = upper[upper.length - 2].y;
      const x2 = upper[upper.length - 1].x, y2 = upper[upper.length - 1].y;
      if ((x2 - x1) * (v.y - y2) < (y2 - y1) * (v.x - x2)) {
        upper.pop();
      } else {
        break;
      }
    }
    upper.push(v);
  }
  const lower: T[] = [];
  for (let i = verts.length - 1; i >= 0; i--) {
    const v = verts[i];
    while (lower.length > 1) {
      const x1 = lower[lower.length - 2].x, y1 = lower[lower.length - 2].y;
      const x2 = lower[lower.length - 1].x, y2 = lower[lower.length - 1].y;
      if ((x2 - x1) * (v.y - y2) < (y2 - y1) * (v.x - x2)) {
        lower.pop();
      } else {
        break;
      }
    }
    lower.push(v);
  }
  upper.pop();
  lower.pop();
  let hull = [...upper, ...lower];

  // Step 3: Check candidates not on center hull — do they "poke out"?
  const hullSet = new Set(hull);
  const candidates = verts.filter(v => !hullSet.has(v));
  const touching: T[] = [];
  // Append first to cycle around hull
  const hullCycle = [...hull, hull[0]];
  for (const v of candidates) {
    for (let i = 0; i < hullCycle.length - 1; i++) {
      const a = hullCycle[i];
      const b = hullCycle[i + 1];
      const minR = Math.min(a.tradius, b.tradius);
      // If (v.tradius - minR)^2 > distance_line_point_squared(a, b, v), circle pokes out
      const rDiff = v.tradius - minR;
      if (rDiff > 0) {
        const dlpSq = distanceLinePointSquared(a.x, a.y, b.x, b.y, v.x, v.y);
        if (rDiff * rDiff > dlpSq) {
          touching.push(v);
          break;
        }
      }
    }
  }

  hull = [...hull, ...touching];

  // Step 4: Sort angularly and gift-wrapping pass using tangent lines
  const cx = hull.reduce((s, v) => s + v.x, 0) / hull.length;
  const cy = hull.reduce((s, v) => s + v.y, 0) / hull.length;

  // Find min (leftmost-bottom by x-r, then y-r) and max (rightmost-top by x+r, then y+r)
  const min = hull.reduce((best, v) => {
    const cmp = (v.x - v.tradius) - (best.x - best.tradius);
    if (cmp < 0) return v;
    if (cmp > 0) return best;
    return (v.y - v.tradius) < (best.y - best.tradius) ? v : best;
  });
  const max = hull.reduce((best, v) => {
    const cmp = (v.x + v.tradius) - (best.x + best.tradius);
    if (cmp > 0) return v;
    if (cmp < 0) return best;
    return (v.y + v.tradius) > (best.y + best.tradius) ? v : best;
  });

  hull.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // Rotate so min is first
  const minIdx = hull.indexOf(min);
  if (minIdx > 0) {
    hull = [...hull.slice(minIdx), ...hull.slice(0, minIdx)];
  }
  // Append first for full cycle
  hull.push(hull[0]);

  // Gift-wrapping with tangent lines
  const result: T[] = [];
  const tangents: [number, number, number, number][] = [];

  for (const v of hull) {
    while (result.length > 0) {
      const h1 = result[result.length - 1];
      const tangent = getTangents(h1.x, h1.y, h1.tradius, true, v.x, v.y, v.tradius, true);
      if (result.length === 1) {
        tangents.push(tangent);
        break;
      }
      const [x1, y1, x2, y2] = tangents[tangents.length - 1];
      const [x3, y3, x4, y4] = tangent;
      // Check if we need to pop: cross product test
      // Pop if the turn is clockwise (and current isn't max)
      if (result[result.length - 1] !== max &&
          (x2 - x1) * (y4 - y3) < (y2 - y1) * (x4 - x3)) {
        result.pop();
        tangents.pop();
      } else {
        tangents.push(tangent);
        break;
      }
    }
    result.push(v);
  }
  result.pop(); // Remove the duplicate first element

  return result;
}
