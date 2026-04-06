/** A segment defined by two endpoints */
export interface Segment {
  ax: number
  ay: number
  bx: number
  by: number
}

/** BVH node — leaf nodes store segment indices, internal nodes store children */
export interface BVHNode {
  minX: number
  minY: number
  maxX: number
  maxY: number
  left?: BVHNode
  right?: BVHNode
  /** Segment indices (only on leaf nodes) */
  segments?: number[]
}

const MAX_LEAF_SIZE = 8

/**
 * Build a 2D axis-aligned bounding box BVH from an array of segments.
 * Uses median split on the longest axis.
 */
export function buildSegmentBVH(segments: Segment[]): BVHNode {
  const indices = new Array<number>(segments.length)
  for (let i = 0; i < segments.length; i++) indices[i] = i
  return buildNode(segments, indices, 0, segments.length)
}

function buildNode(
  segments: Segment[],
  indices: number[],
  start: number,
  end: number,
): BVHNode {
  // Compute AABB for this subset
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (let i = start; i < end; i++) {
    const s = segments[indices[i]!]!
    minX = Math.min(minX, s.ax, s.bx)
    minY = Math.min(minY, s.ay, s.by)
    maxX = Math.max(maxX, s.ax, s.bx)
    maxY = Math.max(maxY, s.ay, s.by)
  }

  const count = end - start
  if (count <= MAX_LEAF_SIZE) {
    const segs: number[] = new Array(count)
    for (let i = 0; i < count; i++) segs[i] = indices[start + i]!
    return { minX, minY, maxX, maxY, segments: segs }
  }

  // Split on longest axis using median of segment midpoints
  const splitX = maxX - minX >= maxY - minY
  const mid = (start + end) >> 1

  // Partial sort: nth_element via partition around median
  nthElement(segments, indices, start, end, mid, splitX)

  return {
    minX,
    minY,
    maxX,
    maxY,
    left: buildNode(segments, indices, start, mid),
    right: buildNode(segments, indices, mid, end),
  }
}

/** In-place nth_element using introselect (quickselect with fallback) */
function nthElement(
  segments: Segment[],
  indices: number[],
  lo: number,
  hi: number,
  nth: number,
  splitX: boolean,
): void {
  while (hi - lo > 1) {
    // Median-of-three pivot
    const mid = (lo + hi - 1) >> 1
    const a = midpoint(segments, indices, lo, splitX)
    const b = midpoint(segments, indices, mid, splitX)
    const c = midpoint(segments, indices, hi - 1, splitX)
    let pivotIdx: number
    if ((a <= b && b <= c) || (c <= b && b <= a)) pivotIdx = mid
    else if ((b <= a && a <= c) || (c <= a && a <= b)) pivotIdx = lo
    else pivotIdx = hi - 1

    // Swap pivot to end
    swap(indices, pivotIdx, hi - 1)
    const pivotVal = midpoint(segments, indices, hi - 1, splitX)

    let store = lo
    for (let i = lo; i < hi - 1; i++) {
      if (midpoint(segments, indices, i, splitX) < pivotVal) {
        swap(indices, i, store)
        store++
      }
    }
    swap(indices, store, hi - 1)

    if (store === nth) return
    if (nth < store) hi = store
    else lo = store + 1
  }
}

function midpoint(
  segments: Segment[],
  indices: number[],
  i: number,
  splitX: boolean,
): number {
  const s = segments[indices[i]!]!
  return splitX ? (s.ax + s.bx) * 0.5 : (s.ay + s.by) * 0.5
}

function swap(arr: number[], i: number, j: number): void {
  const tmp = arr[i]!
  arr[i] = arr[j]!
  arr[j] = tmp
}

/**
 * Query the BVH for all segments whose AABBs overlap the given AABB.
 * Returns segment indices into the original segments array.
 */
export function queryAABB(
  node: BVHNode,
  qMinX: number,
  qMinY: number,
  qMaxX: number,
  qMaxY: number,
  segments: Segment[],
  out: number[],
): void {
  // AABB overlap test
  if (qMaxX < node.minX || qMinX > node.maxX || qMaxY < node.minY || qMinY > node.maxY) {
    return
  }

  if (node.segments) {
    // Leaf: test each segment's AABB
    for (const idx of node.segments) {
      const s = segments[idx]!
      const sMinX = Math.min(s.ax, s.bx)
      const sMaxX = Math.max(s.ax, s.bx)
      const sMinY = Math.min(s.ay, s.by)
      const sMaxY = Math.max(s.ay, s.by)
      if (qMaxX >= sMinX && qMinX <= sMaxX && qMaxY >= sMinY && qMinY <= sMaxY) {
        out.push(idx)
      }
    }
    return
  }

  if (node.left) queryAABB(node.left, qMinX, qMinY, qMaxX, qMaxY, segments, out)
  if (node.right) queryAABB(node.right, qMinX, qMinY, qMaxX, qMaxY, segments, out)
}
