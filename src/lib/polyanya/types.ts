/** Floating point comparison epsilon */
export const EPSILON = 1e-8

/** A 2D point */
export interface Point {
  x: number
  y: number
}

/** A mesh vertex with adjacency information */
export interface Vertex {
  p: Point
  /** Adjacent polygon indices (CCW order). -1 means obstacle/boundary. */
  polygons: number[]
  /** True if this vertex touches an obstacle or mesh boundary */
  isCorner: boolean
  /** True if multiple non-traversable neighbors (ambiguous corner) */
  isAmbig: boolean
}

/** A convex polygon in the navigation mesh */
export interface Polygon {
  /** Vertex indices (CCW order) */
  vertices: number[]
  /** Adjacent polygon indices. polygons[i] is adjacent to edge (vertices[(i-1+N) mod N], vertices[i]). -1 = obstacle. */
  polygons: number[]
  /** True if only one traversable neighbor */
  isOneWay: boolean
  minX: number
  maxX: number
  minY: number
  maxY: number
  /** Distance cost multiplier (default 1.0) */
  weight: number
  /** Additive entry cost (default 0.0) */
  penalty: number
}

/** A weighted region that the pathfinder prefers to avoid but can traverse */
export interface WeightedRegion {
  polygon: Point[]
  weight: number
  penalty: number
}

/** Result of testing whether a polygon contains a point */
export enum PolyContainmentType {
  OUTSIDE = "OUTSIDE",
  INSIDE = "INSIDE",
  ON_EDGE = "ON_EDGE",
  ON_VERTEX = "ON_VERTEX",
}

export interface PolyContainment {
  type: PolyContainmentType
  adjacentPoly: number
  vertex1: number
  vertex2: number
}

/** How a point is located on the mesh */
export enum PointLocationType {
  NOT_ON_MESH = "NOT_ON_MESH",
  IN_POLYGON = "IN_POLYGON",
  ON_MESH_BORDER = "ON_MESH_BORDER",
  ON_EDGE = "ON_EDGE",
  ON_CORNER_VERTEX_AMBIG = "ON_CORNER_VERTEX_AMBIG",
  ON_CORNER_VERTEX_UNAMBIG = "ON_CORNER_VERTEX_UNAMBIG",
  ON_NON_CORNER_VERTEX = "ON_NON_CORNER_VERTEX",
}

export interface PointLocation {
  type: PointLocationType
  poly1: number
  poly2: number
  vertex1: number
  vertex2: number
}

/** Successor interval types during expansion */
export enum SuccessorType {
  RIGHT_NON_OBSERVABLE = "RIGHT_NON_OBSERVABLE",
  OBSERVABLE = "OBSERVABLE",
  LEFT_NON_OBSERVABLE = "LEFT_NON_OBSERVABLE",
}

/** A successor interval generated during node expansion */
export interface Successor {
  type: SuccessorType
  left: Point
  right: Point
  /** Index into polygon's vertex/polygon arrays for the left edge endpoint */
  polyLeftInd: number
}

/** A search node in the Polyanya algorithm */
export interface SearchNode {
  parent: SearchNode | null
  /** Root vertex index. -1 means start point is the root. */
  root: number
  /** Left endpoint of the interval (looking from root, right is on the right side) */
  left: Point
  /** Right endpoint of the interval */
  right: Point
  /** Left vertex index of the edge the interval lies on */
  leftVertex: number
  /** Right vertex index of the edge the interval lies on */
  rightVertex: number
  /** Index of the polygon to expand into next */
  nextPolygon: number
  /** f = g + h (total estimated cost) */
  f: number
  /** g = cost from start to this node's root */
  g: number
}

/** Orientation of three points */
export enum Orientation {
  CCW = "CCW",
  COLLINEAR = "COLLINEAR",
  CW = "CW",
}

/** Position of a line intersection parameter in [0, 1] */
export enum ZeroOnePos {
  LT_ZERO = "LT_ZERO",
  EQ_ZERO = "EQ_ZERO",
  IN_RANGE = "IN_RANGE",
  EQ_ONE = "EQ_ONE",
  GT_ONE = "GT_ONE",
}

/** An event emitted during search stepping for visualization */
export enum StepEventType {
  INIT = "INIT",
  NODE_POPPED = "NODE_POPPED",
  NODE_EXPANDED = "NODE_EXPANDED",
  NODE_PUSHED = "NODE_PUSHED",
  NODE_PRUNED = "NODE_PRUNED",
  GOAL_REACHED = "GOAL_REACHED",
  SEARCH_EXHAUSTED = "SEARCH_EXHAUSTED",
}

export interface StepEvent {
  type: StepEventType
  node?: SearchNode
  successors?: Successor[]
  nodesInOpenList?: number
  message?: string
}
