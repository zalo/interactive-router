// Core types
export {
  EPSILON,
  Orientation,
  PointLocationType,
  PolyContainmentType,
  StepEventType,
  SuccessorType,
  ZeroOnePos,
  type Point,
  type PointLocation,
  type PolyContainment,
  type Polygon,
  type SearchNode,
  type StepEvent,
  type Successor,
  type Vertex,
  type WeightedRegion,
} from "./types.ts"

// Geometry utilities
export {
  add,
  cross,
  distance,
  distanceSq,
  getOrientation,
  getPointOnLine,
  isCollinear,
  lineIntersect,
  lineIntersectBoundCheck,
  lineIntersectTime,
  pointsEqual,
  reflectPoint,
  scale,
  sub,
} from "./geometry.ts"

// Mesh
export { Mesh } from "./mesh.ts"

// Expansion (successor generation)
export { getHValue, getSuccessors } from "./expansion.ts"

// Search
export { SearchInstance } from "./search.ts"

// Mesh builder
export { buildMeshFromRegions, type MeshBuilderInput } from "./mesh-builder.ts"

// CDT builder (obstacle → triangulation → regions)
export { cdtTriangulate, rectToPolygon, type CdtResult } from "./cdt-builder.ts"

// Constraint crossing resolution (for overlapping obstacles)
export { resolveConstraintCrossings } from "./resolve-constraint-crossings.ts"

// Mesh merger (Polyanya meshmerger algorithm)
export { mergeMesh } from "./mesh-merger.ts"

// Graph search (dual connectivity A*)
export { graphSearch, type GraphSearchResult } from "./graph-search.ts"

// Visibility graph search
export {
  VisibilityGraph,
  visibilityGraphSearch,
  type VisibilityGraphOptions,
  type VisibilityGraphResult,
} from "./visibility-graph.ts"

// Polygon merging (boolean union of overlapping obstacles)
export { mergeAllPolygons } from "./merge-polygons.ts"

// Weighted edge cost computation
export {
  buildWeightedEdgeContext,
  computeWeightedEdgeCost,
  pointInConvexPolygon,
  type WeightedEdgeContext,
} from "./weighted-edges.ts"
