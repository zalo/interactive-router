import {
  EPSILON,
  Orientation,
  SuccessorType,
  ZeroOnePos,
  type Point,
  type SearchNode,
  type Successor,
} from "./types.ts"
import type { Mesh } from "./mesh.ts"
import {
  cross,
  distance,
  distanceSq,
  getOrientation,
  isCollinear,
  lineIntersect,
  lineIntersectBoundCheck,
  pointsEqual,
  reflectPoint,
  sub,
} from "./geometry.ts"

/**
 * Compute the heuristic value for a search node.
 * Uses line intersection + reflection for an admissible estimate.
 */
export function getHValue(
  root: Point,
  goal: Point,
  l: Point,
  r: Point,
): number {
  if (pointsEqual(root, l) || pointsEqual(root, r)) {
    return distance(root, goal)
  }

  // Check whether goal and root are on the same side of the interval
  const lr = sub(r, l)
  const lroot = sub(root, l)
  let lgoal = sub(goal, l)
  let currentGoal = goal

  if ((cross(lroot, lr) > 0) === (cross(lgoal, lr) > 0)) {
    // Need to reflect
    currentGoal = reflectPoint(goal, l, r)
    lgoal = sub(currentGoal, l)
  }

  // Line intersection test
  const denom = cross(sub(currentGoal, root), lr)
  if (Math.abs(denom) < EPSILON) {
    // All collinear — take closest endpoint
    const rootL = distanceSq(root, l)
    const rootR = distanceSq(root, r)
    if (rootL < rootR) {
      return Math.sqrt(rootL) + distance(l, currentGoal)
    }
    return Math.sqrt(rootR) + distance(r, currentGoal)
  }

  const lrNum = cross(lgoal, lroot)
  const lrPos = lineIntersectBoundCheck(lrNum, denom)

  switch (lrPos) {
    case ZeroOnePos.LT_ZERO:
      return distance(root, l) + distance(l, currentGoal)
    case ZeroOnePos.EQ_ZERO:
    case ZeroOnePos.IN_RANGE:
    case ZeroOnePos.EQ_ONE:
      return distance(root, currentGoal)
    case ZeroOnePos.GT_ONE:
      return distance(root, r) + distance(r, currentGoal)
  }
}

/** Internal binary search helper. Indices in [0, 2*N-1] for wraparound. */
function binarySearch<T>(
  arr: number[],
  N: number,
  objects: T[],
  lower: number,
  upper: number,
  pred: (obj: T) => boolean,
  isUpperBound: boolean,
): number {
  const normalise = (index: number) => (index >= N ? index - N : index)
  if (lower === upper) return lower

  let bestSoFar = -1
  let lo = lower
  let hi = upper

  while (lo <= hi) {
    const mid = lo + Math.floor((hi - lo) / 2)
    const matchesPred = pred(objects[arr[normalise(mid)]!]!)

    if (matchesPred) {
      bestSoFar = mid
    }

    if (matchesPred === isUpperBound) {
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }

  return bestSoFar
}

/**
 * Generate successors for a search node within a polygon.
 * This is the core of the Polyanya algorithm.
 *
 * Returns an array of Successor objects representing visible and non-observable
 * intervals on the polygon edges.
 */
export function getSuccessors(
  node: SearchNode,
  start: Point,
  mesh: Mesh,
): Successor[] {
  const polygon = mesh.polygons[node.nextPolygon]!
  const V = polygon.vertices
  const N = V.length
  const root: Point =
    node.root === -1 ? start : mesh.vertices[node.root]!.p

  const successors: Successor[] = []

  const normalise = (index: number) => (index >= N ? index - N : index)

  // Check collinearity
  const rootL = sub(node.left, root)
  const rootR = sub(node.right, root)
  const rootEqL =
    Math.abs(rootL.x) < EPSILON && Math.abs(rootL.y) < EPSILON
  const rootEqR =
    Math.abs(rootR.x) < EPSILON && Math.abs(rootR.y) < EPSILON

  if (rootEqL || rootEqR || isCollinear(root, node.right, node.left)) {
    // Collinear case — find which endpoint is closer and turn there
    let succType: SuccessorType

    if (
      rootEqL ||
      (!rootEqR &&
        (Math.abs(rootL.x - rootR.x) < EPSILON
          ? Math.abs(rootL.y) < Math.abs(rootR.y)
          : Math.abs(rootL.x) < Math.abs(rootR.x)))
    ) {
      // Turn at left
      if (!mesh.vertices[node.leftVertex]!.isCorner) return []
      succType = SuccessorType.LEFT_NON_OBSERVABLE
    } else {
      // Turn at right
      if (!mesh.vertices[node.rightVertex]!.isCorner) return []
      succType = SuccessorType.RIGHT_NON_OBSERVABLE
    }

    let lastVertex = V[V.length - 1]!
    for (let i = 0; i < N; i++) {
      const thisVertex = V[i]!
      if (thisVertex === node.rightVertex) {
        lastVertex = thisVertex
        continue
      }
      successors.push({
        type: succType,
        left: mesh.vertices[thisVertex]!.p,
        right: mesh.vertices[lastVertex]!.p,
        polyLeftInd: i,
      })
      lastVertex = thisVertex
    }
    return successors
  }

  // Triangle special case (N === 3)
  if (N === 3) {
    return getTriangleSuccessors(node, root, mesh, V)
  }

  // General polygon case (N >= 4)
  return getGeneralSuccessors(node, root, mesh, V, N)
}

/** Optimized successor generation for triangles */
function getTriangleSuccessors(
  node: SearchNode,
  root: Point,
  mesh: Mesh,
  V: number[],
): Successor[] {
  const successors: Successor[] = []

  let p1: number // V[p1] = t2
  let p2: number // V[p2] = t3
  let t2: Point

  // The right point of the triangle
  const t1 = mesh.vertices[node.rightVertex]!.p

  if (V[0] === node.rightVertex) {
    p1 = 1
    p2 = 2
    t2 = mesh.vertices[V[1]!]!.p
  } else if (V[0] === node.leftVertex) {
    p1 = 2
    p2 = 0
    t2 = mesh.vertices[V[2]!]!.p
  } else {
    p1 = 0
    p2 = 1
    t2 = mesh.vertices[V[0]!]!.p
  }

  // The left point of the triangle
  const t3 = mesh.vertices[node.leftVertex]!.p
  const L = node.left
  const R = node.right

  const orient = getOrientation(root, L, t2)

  if (orient === Orientation.CCW) {
    const LI = lineIntersect(t1, t2, root, L)
    const RI = pointsEqual(R, t1) ? t1 : lineIntersect(t1, t2, root, R)

    successors.push({
      type: SuccessorType.OBSERVABLE,
      left: LI,
      right: RI,
      polyLeftInd: p1,
    })

    if (
      mesh.vertices[node.leftVertex]!.isCorner &&
      pointsEqual(L, t3)
    ) {
      successors.push({
        type: SuccessorType.LEFT_NON_OBSERVABLE,
        left: t2,
        right: LI,
        polyLeftInd: p1,
      })
      successors.push({
        type: SuccessorType.LEFT_NON_OBSERVABLE,
        left: t3,
        right: t2,
        polyLeftInd: p2,
      })
    }

    return successors
  }

  if (orient === Orientation.COLLINEAR) {
    const RI = pointsEqual(R, t1) ? t1 : lineIntersect(t1, t2, root, R)

    successors.push({
      type: SuccessorType.OBSERVABLE,
      left: t2,
      right: RI,
      polyLeftInd: p1,
    })

    if (
      mesh.vertices[node.leftVertex]!.isCorner &&
      pointsEqual(L, t3)
    ) {
      successors.push({
        type: SuccessorType.LEFT_NON_OBSERVABLE,
        left: t3,
        right: t2,
        polyLeftInd: p2,
      })
    }

    return successors
  }

  // CW case: LI in (t2, t3]
  const LI = pointsEqual(L, t3) ? t3 : lineIntersect(t2, t3, root, L)

  const orientR = getOrientation(root, R, t2)

  if (orientR === Orientation.CW) {
    const RI = lineIntersect(t2, t3, root, R)

    if (
      mesh.vertices[node.rightVertex]!.isCorner &&
      pointsEqual(R, t1)
    ) {
      successors.push({
        type: SuccessorType.RIGHT_NON_OBSERVABLE,
        left: t2,
        right: t1,
        polyLeftInd: p1,
      })
      successors.push({
        type: SuccessorType.RIGHT_NON_OBSERVABLE,
        left: RI,
        right: t2,
        polyLeftInd: p2,
      })
      successors.push({
        type: SuccessorType.OBSERVABLE,
        left: LI,
        right: RI,
        polyLeftInd: p2,
      })
      return successors
    }

    successors.push({
      type: SuccessorType.OBSERVABLE,
      left: LI,
      right: RI,
      polyLeftInd: p2,
    })
    return successors
  }

  if (orientR === Orientation.COLLINEAR) {
    if (
      mesh.vertices[node.rightVertex]!.isCorner &&
      pointsEqual(R, t1)
    ) {
      successors.push({
        type: SuccessorType.RIGHT_NON_OBSERVABLE,
        left: t2,
        right: t1,
        polyLeftInd: p1,
      })
      successors.push({
        type: SuccessorType.OBSERVABLE,
        left: LI,
        right: t2,
        polyLeftInd: p2,
      })
      return successors
    }

    successors.push({
      type: SuccessorType.OBSERVABLE,
      left: LI,
      right: t2,
      polyLeftInd: p2,
    })
    return successors
  }

  // CCW
  const RI = pointsEqual(R, t1) ? t1 : lineIntersect(t1, t2, root, R)

  successors.push({
    type: SuccessorType.OBSERVABLE,
    left: t2,
    right: RI,
    polyLeftInd: p1,
  })
  successors.push({
    type: SuccessorType.OBSERVABLE,
    left: LI,
    right: t2,
    polyLeftInd: p2,
  })

  return successors
}

/** Successor generation for general polygons (N >= 4) using binary search */
function getGeneralSuccessors(
  node: SearchNode,
  root: Point,
  mesh: Mesh,
  V: number[],
  N: number,
): Successor[] {
  const successors: Successor[] = []
  const normalise = (index: number) => {
    let i = index % N
    if (i < 0) i += N
    return i
  }
  const index2point = (index: number) => {
    const vi = V[index]
    if (vi === undefined) {
      throw new Error(
        `index2point: V[${index}] is undefined (N=${N}, V.length=${V.length})`,
      )
    }
    return mesh.vertices[vi]!.p
  }

  // Find right_ind: position of right_vertex in V
  let rightInd = 0
  while (rightInd < N && V[rightInd] !== node.rightVertex) {
    rightInd++
  }
  if (rightInd >= N) {
    // rightVertex not found in polygon — this shouldn't happen with a valid mesh
    // but can occur with degenerate adjacency. Return empty.
    return []
  }
  const leftInd = N + rightInd - 1

  const rightVertexObj = mesh.vertices[node.rightVertex]!
  const leftVertexObj = mesh.vertices[V[normalise(leftInd)]!]!

  const rightP = rightVertexObj.p
  const leftP = leftVertexObj.p
  const rightLiesVertex = pointsEqual(rightP, node.right)
  const leftLiesVertex = pointsEqual(leftP, node.left)

  // Find transition A: "first P such that root-right-p is strictly CCW"
  const rootRight = sub(node.right, root)

  const A = (() => {
    if (rightLiesVertex) {
      const nextP = index2point(normalise(rightInd + 1))
      if (cross(rootRight, sub(nextP, node.right)) > -EPSILON) {
        return rightInd + 1
      }
    }
    return binarySearch(
      V,
      N,
      mesh.vertices,
      rightInd + 1,
      leftInd,
      (v) => cross(rootRight, sub(v.p, node.right)) > EPSILON,
      false,
    )
  })()

  const normA = normalise(A)
  const normAm1 = normalise(A - 1)
  const Ap = index2point(normA)
  const Am1p = index2point(normAm1)

  const rightIntersect =
    rightLiesVertex && A === rightInd + 1
      ? node.right
      : lineIntersect(Ap, Am1p, root, node.right)

  // Find transition B: "first P such that root-left-p is strictly CW"
  const rootLeft = sub(node.left, root)

  const B = (() => {
    if (leftLiesVertex) {
      const prevP = index2point(normalise(leftInd - 1))
      if (cross(rootLeft, sub(prevP, node.left)) < EPSILON) {
        return leftInd - 1
      }
    }
    return binarySearch(
      V,
      N,
      mesh.vertices,
      A - 1,
      leftInd - 1,
      (v) => cross(rootLeft, sub(v.p, node.left)) < -EPSILON,
      true,
    )
  })()

  const normB = normalise(B)
  const normBp1 = normalise(B + 1)
  const Bp = index2point(normB)
  const Bp1p = index2point(normBp1)

  const leftIntersect =
    leftLiesVertex && B === leftInd - 1
      ? node.left
      : lineIntersect(Bp, Bp1p, root, node.left)

  // Generate RIGHT_NON_OBSERVABLE successors
  if (rightLiesVertex && rightVertexObj.isCorner) {
    let lastI = rightInd
    let curI = normalise(rightInd + 1)

    while (lastI !== normAm1) {
      successors.push({
        type: SuccessorType.RIGHT_NON_OBSERVABLE,
        left: index2point(curI),
        right: index2point(lastI),
        polyLeftInd: curI,
      })
      lastI = curI
      curI = curI + 1 >= N ? 0 : curI + 1
    }

    if (!pointsEqual(rightIntersect, Am1p)) {
      successors.push({
        type: SuccessorType.RIGHT_NON_OBSERVABLE,
        left: rightIntersect,
        right: Am1p,
        polyLeftInd: normA,
      })
    }
  }

  // Generate OBSERVABLE successors
  if (A === B + 2) {
    // No observable successors
  } else if (A === B + 1) {
    // Single observable successor
    successors.push({
      type: SuccessorType.OBSERVABLE,
      left: leftIntersect,
      right: rightIntersect,
      polyLeftInd: normA,
    })
  } else {
    // First (possibly non-maximal) observable
    successors.push({
      type: SuccessorType.OBSERVABLE,
      left: Ap,
      right: rightIntersect,
      polyLeftInd: normA,
    })

    // All guaranteed-maximal observables
    let lastI = normA
    let curI = normalise(A + 1)

    while (lastI !== normB) {
      successors.push({
        type: SuccessorType.OBSERVABLE,
        left: index2point(curI),
        right: index2point(lastI),
        polyLeftInd: curI,
      })
      lastI = curI
      curI = curI + 1 >= N ? 0 : curI + 1
    }

    // Last (possibly non-maximal) observable
    successors.push({
      type: SuccessorType.OBSERVABLE,
      left: leftIntersect,
      right: Bp,
      polyLeftInd: normBp1,
    })
  }

  // Generate LEFT_NON_OBSERVABLE successors
  if (leftLiesVertex && leftVertexObj.isCorner) {
    if (!pointsEqual(leftIntersect, Bp1p)) {
      successors.push({
        type: SuccessorType.LEFT_NON_OBSERVABLE,
        left: Bp1p,
        right: leftIntersect,
        polyLeftInd: normBp1,
      })
    }

    let lastI = normBp1
    let curI = normalise(B + 2)
    const normLeftInd = normalise(leftInd)

    while (lastI !== normLeftInd) {
      successors.push({
        type: SuccessorType.LEFT_NON_OBSERVABLE,
        left: index2point(curI),
        right: index2point(lastI),
        polyLeftInd: curI,
      })
      lastI = curI
      curI = curI + 1 >= N ? 0 : curI + 1
    }
  }

  return successors
}
