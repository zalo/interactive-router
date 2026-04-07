// Polygon obstacle merging using @flatten-js/core
import Flatten from '@flatten-js/core';

export interface BoxObstacle {
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxToPolygon(box: BoxObstacle): Flatten.Polygon {
  const { x, y, w, h } = box;
  return new Flatten.Polygon([
    Flatten.point(x, y),
    Flatten.point(x + w, y),
    Flatten.point(x + w, y + h),
    Flatten.point(x, y + h),
  ]);
}

/**
 * Merge overlapping boxes into polygons using boolean union.
 * Returns an array of polygons, each defined as an array of {x,y} vertices.
 */
/**
 * Check if a point is inside any of the given polygons.
 * If so, project it to the nearest point on the polygon boundary.
 * Returns the original point if outside all polygons, or the projected point.
 */
export function projectPointOutOfPolygons(
  px: number, py: number,
  polygons: { x: number; y: number }[][]
): { x: number; y: number } {
  for (const poly of polygons) {
    if (!pointInPoly(px, py, poly)) continue;

    // Point is inside this polygon — find nearest boundary point
    let bestDist = Infinity;
    let bestX = px, bestY = py;

    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const { x, y, dist } = nearestPointOnSegment(px, py, a.x, a.y, b.x, b.y);
      if (dist < bestDist) {
        bestDist = dist;
        bestX = x;
        bestY = y;
      }
    }

    // Push slightly outside (1 unit along the normal away from polygon center)
    const cx = poly.reduce((s, v) => s + v.x, 0) / poly.length;
    const cy = poly.reduce((s, v) => s + v.y, 0) / poly.length;
    const dx = bestX - cx, dy = bestY - cy;
    const d = Math.hypot(dx, dy);
    if (d > 0) {
      bestX += (dx / d) * 100;
      bestY += (dy / d) * 100;
    }
    return { x: bestX, y: bestY };
  }
  return { x: px, y: py };
}

function pointInPoly(px: number, py: number, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (((yi <= py && py < yj) || (yj <= py && py < yi)) &&
      px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function nearestPointOnSegment(
  px: number, py: number,
  ax: number, ay: number, bx: number, by: number
): { x: number; y: number; dist: number } {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { x: ax, y: ay, dist: Math.hypot(px - ax, py - ay) };
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const nx = ax + t * dx, ny = ay + t * dy;
  return { x: nx, y: ny, dist: Math.hypot(px - nx, py - ny) };
}

export function mergeBoxes(boxes: BoxObstacle[]): { x: number; y: number }[][] {
  if (boxes.length === 0) return [];

  // Build a union of all boxes
  let merged = boxToPolygon(boxes[0]);
  for (let i = 1; i < boxes.length; i++) {
    merged = Flatten.BooleanOperations.unify(merged, boxToPolygon(boxes[i]));
  }

  // Extract face vertices from the merged polygon
  const result: { x: number; y: number }[][] = [];
  for (const face of merged.faces) {
    const faceObj = face as Flatten.Face;
    const verts: { x: number; y: number }[] = [];
    for (const edge of faceObj.edges) {
      const edgeObj = edge as Flatten.PolygonEdge;
      const pt = edgeObj.shape.start;
      verts.push({ x: pt.x, y: pt.y });
    }
    if (verts.length >= 3) {
      result.push(verts);
    }
  }
  return result;
}
