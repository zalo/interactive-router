import {
  EPSILON,
  Orientation,
  ZeroOnePos,
  type Point,
} from "./types.ts"

/** Euclidean distance squared between two points */
export function distanceSq(a: Point, b: Point): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

/** Euclidean distance between two points */
export function distance(a: Point, b: Point): number {
  return Math.sqrt(distanceSq(a, b))
}

/** 2D cross product (z-component): (b-a) x (c-b) */
export function cross(a: Point, b: Point): number {
  return a.x * b.y - a.y * b.x
}

/** Subtract two points */
export function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y }
}

/** Add two points */
export function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y }
}

/** Scale a point by a scalar */
export function scale(p: Point, s: number): Point {
  return { x: p.x * s, y: p.y * s }
}

/** Check if two points are approximately equal */
export function pointsEqual(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < EPSILON && Math.abs(a.y - b.y) < EPSILON
}

/** Get orientation of three points: CCW, COLLINEAR, or CW */
export function getOrientation(a: Point, b: Point, c: Point): Orientation {
  const val = cross(sub(b, a), sub(c, b))
  if (Math.abs(val) < EPSILON) return Orientation.COLLINEAR
  return val > 0 ? Orientation.CCW : Orientation.CW
}

/** Check if three points are collinear */
export function isCollinear(a: Point, b: Point, c: Point): boolean {
  return Math.abs(cross(sub(b, a), sub(c, b))) < EPSILON
}

/**
 * Line intersection between segments ab and cd.
 * Returns the intersection point using parameterization on ab.
 * ASSUMES NO COLLINEARITY.
 */
export function lineIntersect(a: Point, b: Point, c: Point, d: Point): Point {
  const ab = sub(b, a)
  const ca = sub(c, a)
  const da = sub(d, a)
  const dc = sub(d, c)
  const t = cross(ca, da) / cross(ab, dc)
  return add(a, scale(ab, t))
}

/**
 * Compute parameterized intersection times for lines ab and cd.
 * Returns { abNum, cdNum, denom } such that:
 *   ab(abNum/denom) = cd(cdNum/denom)
 */
export function lineIntersectTime(
  a: Point,
  b: Point,
  c: Point,
  d: Point,
): { abNum: number; cdNum: number; denom: number } {
  const ba = sub(b, a)
  const dc = sub(d, c)
  let denom = cross(ba, dc)

  if (Math.abs(denom) < EPSILON) {
    return { abNum: 1, cdNum: 1, denom: 0 }
  }

  const ac = sub(c, a)
  const da = sub(d, a)
  const bc = sub(b, c)
  const abNum = cross(ac, da)
  const cdNum = cross(ac, bc)

  return { abNum, cdNum, denom }
}

/**
 * Check where num/denom falls in [0, 1].
 */
export function lineIntersectBoundCheck(
  num: number,
  denom: number,
): ZeroOnePos {
  if (Math.abs(num) < EPSILON) return ZeroOnePos.EQ_ZERO
  if (Math.abs(num - denom) < EPSILON) return ZeroOnePos.EQ_ONE

  if (denom > 0) {
    if (num < 0) return ZeroOnePos.LT_ZERO
    if (num > denom) return ZeroOnePos.GT_ONE
  } else {
    if (num > 0) return ZeroOnePos.LT_ZERO
    if (num < denom) return ZeroOnePos.GT_ONE
  }

  return ZeroOnePos.IN_RANGE
}

/** Get a point on line ab at parameter t: a + (b-a)*t */
export function getPointOnLine(a: Point, b: Point, t: number): Point {
  return add(a, scale(sub(b, a), t))
}

/** Reflect a point across the line lr */
export function reflectPoint(p: Point, l: Point, r: Point): Point {
  const denom = distanceSq(r, l)
  if (Math.abs(denom) < EPSILON) {
    // Trivial reflection: 2*l - p
    return { x: 2 * l.x - p.x, y: 2 * l.y - p.y }
  }
  const rp = sub(r, p)
  const lp = sub(l, p)
  const numer = cross(rp, lp)
  // Vector r-l rotated 90 degrees CCW
  const deltaRotated: Point = { x: l.y - r.y, y: r.x - l.x }
  const factor = (2.0 * numer) / denom
  return add(p, scale(deltaRotated, factor))
}
