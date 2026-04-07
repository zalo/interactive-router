// Rubberband Topological Router
// Vendored from rubberband-router (Stefan Salewski's algorithm, TS port)

export { Router, type RouteResult, type DrawnSegment } from './router-ts.ts'
export {
  Vertex, Region, Step, NetDesc, Cut, Tex,
  SymmetricMap, MBD, AVD, ATW,
  DEFAULT_PIN_RADIUS, DEFAULT_TRACE_WIDTH, DEFAULT_CLEARANCE, DEFAULT_MIN_CUT_SIZE,
} from './types.ts'
export {
  booleanCrossProduct2D,
  getTangents,
  distanceLinePoint,
  distanceLinePointSquared,
  normalDistanceLineSegmentPointSquared,
  distanceLineSegmentPointSquared,
  lineLineIntersection,
  pointInPolygon,
  pointInTriangle,
  segmentIntersects,
  verticesInPolygon,
  apolloniusConvexHull,
} from './geometry.ts'
export { CDT } from './cdt.ts'
export { PriorityQueue } from './priority-queue.ts'
export { DebugManager, type DebugSnapshot } from './debug.ts'
export {
  mergeBoxes,
  projectPointOutOfPolygons,
  type BoxObstacle,
} from './obstacles.ts'
