import {
  EPSILON,
  PointLocationType,
  StepEventType,
  SuccessorType,
  type Point,
  type PointLocation,
  type SearchNode,
  type StepEvent,
  type Successor,
} from "./types.ts"
import type { Mesh } from "./mesh.ts"
import { getHValue, getSuccessors } from "./expansion.ts"
import { cross, distance, pointsEqual, sub } from "./geometry.ts"

/** Priority queue (min-heap) for search nodes, ordered by f-value */
class MinHeap {
  private data: SearchNode[] = []

  get size(): number {
    return this.data.length
  }

  push(node: SearchNode): void {
    this.data.push(node)
    this.bubbleUp(this.data.length - 1)
  }

  pop(): SearchNode | undefined {
    if (this.data.length === 0) return undefined
    const top = this.data[0]!
    const last = this.data.pop()!
    if (this.data.length > 0) {
      this.data[0] = last
      this.sinkDown(0)
    }
    return top
  }

  peek(): SearchNode | undefined {
    return this.data[0]
  }

  clear(): void {
    this.data = []
  }

  toArray(): SearchNode[] {
    return [...this.data]
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2)
      if (this.compare(i, parent) < 0) {
        this.swap(i, parent)
        i = parent
      } else {
        break
      }
    }
  }

  private sinkDown(i: number): void {
    const n = this.data.length
    while (true) {
      let smallest = i
      const left = 2 * i + 1
      const right = 2 * i + 2
      if (left < n && this.compare(left, smallest) < 0) smallest = left
      if (right < n && this.compare(right, smallest) < 0) smallest = right
      if (smallest === i) break
      this.swap(i, smallest)
      i = smallest
    }
  }

  private compare(i: number, j: number): number {
    const a = this.data[i]!
    const b = this.data[j]!
    if (a.f === b.f) {
      // Higher g is "better" (closer to goal via shorter remaining path)
      return b.g - a.g
    }
    return a.f - b.f
  }

  private swap(i: number, j: number): void {
    const tmp = this.data[i]!
    this.data[i] = this.data[j]!
    this.data[j] = tmp
  }
}

/**
 * Polyanya search instance.
 * Performs compromise-free any-angle pathfinding on a navigation mesh.
 */
export class SearchInstance {
  mesh: Mesh
  start: Point = { x: 0, y: 0 }
  goal: Point = { x: 0, y: 0 }

  finalNode: SearchNode | null = null
  private startPolygon = -1
  private endPolygon = -1
  private openList = new MinHeap()

  private rootGValues: number[] = []
  private rootSearchIds: number[] = []
  private searchId = 0

  // Statistics
  nodesGenerated = 0
  nodesPushed = 0
  nodesPopped = 0
  nodesPrunedPostPop = 0
  successorCalls = 0
  verbose = false

  private goalless = false

  // Step-through support
  private stepEvents: StepEvent[] = []
  private stepMode = false

  constructor(mesh: Mesh) {
    this.mesh = mesh
    this.rootGValues = new Array(mesh.vertices.length).fill(0)
    this.rootSearchIds = new Array(mesh.vertices.length).fill(0)
  }

  /** Set start and goal points for the next search */
  setStartGoal(start: Point, goal: Point): void {
    this.start = start
    this.goal = goal
    this.finalNode = null
  }

  private resolvePointLocation(p: Point): PointLocation {
    let out = this.mesh.getPointLocation(p)

    if (out.type === PointLocationType.ON_CORNER_VERTEX_AMBIG) {
      // Nudge the point slightly and try again
      const corrected: Point = { x: p.x + EPSILON * 10, y: p.y + EPSILON * 10 }
      const correctedLoc = this.mesh.getPointLocation(corrected)

      switch (correctedLoc.type) {
        case PointLocationType.IN_POLYGON:
        case PointLocationType.ON_MESH_BORDER:
        case PointLocationType.ON_EDGE:
          out = { ...out, poly1: correctedLoc.poly1 }
          break
        default:
          break
      }
    }

    return out
  }

  private setEndPolygon(): void {
    this.endPolygon = this.resolvePointLocation(this.goal).poly1
  }

  /** Convert successors to search nodes with root-level pruning */
  private succToNode(
    parent: SearchNode,
    successors: Successor[],
  ): SearchNode[] {
    const polygon = this.mesh.polygons[parent.nextPolygon]!
    const V = polygon.vertices
    const P = polygon.polygons

    let rightG = -1
    let leftG = -1
    const nodes: SearchNode[] = []

    for (const succ of successors) {
      const nextPolygon = P[succ.polyLeftInd]!
      if (nextPolygon === -1) {
        // In goalless mode, non-observable successors at boundary edges still have
        // their turning corner directly visible from source — record its g-value.
        if (this.goalless &&
          (succ.type === SuccessorType.RIGHT_NON_OBSERVABLE ||
           succ.type === SuccessorType.LEFT_NON_OBSERVABLE)
        ) {
          const pRoot: Point = parent.root === -1 ? this.start : this.mesh.vertices[parent.root]!.p
          const recordCorner = (vertIdx: number, g: number) => {
            if (vertIdx === -1) return
            if (this.rootSearchIds[vertIdx] !== this.searchId) {
              this.rootSearchIds[vertIdx] = this.searchId
              this.rootGValues[vertIdx] = g
            } else if (this.rootGValues[vertIdx]! + EPSILON >= g) {
              this.rootGValues[vertIdx] = g
            }
          }
          if (succ.type === SuccessorType.RIGHT_NON_OBSERVABLE) {
            if (rightG === -1) rightG = parent.g + distance(pRoot, parent.right)
            recordCorner(parent.rightVertex, rightG)
          } else {
            if (leftG === -1) leftG = parent.g + distance(pRoot, parent.left)
            recordCorner(parent.leftVertex, leftG)
          }
        }
        continue
      }

      // Skip one-way polygons that aren't the end (but never in goalless mode)
      if (
        !this.goalless &&
        this.mesh.polygons[nextPolygon]!.isOneWay &&
        nextPolygon !== this.endPolygon
      ) {
        continue
      }

      const leftVertex = V[succ.polyLeftInd]!
      const rightVertex =
        succ.polyLeftInd > 0 ? V[succ.polyLeftInd - 1]! : V[V.length - 1]!

      const parentRoot: Point =
        parent.root === -1
          ? this.start
          : this.mesh.vertices[parent.root]!.p

      const pushNode = (root: number, g: number) => {
        if (root !== -1) {
          if (this.rootSearchIds[root] !== this.searchId) {
            this.rootSearchIds[root] = this.searchId
            this.rootGValues[root] = g
          } else {
            if (this.rootGValues[root]! + EPSILON < g) {
              return // pruned
            }
            this.rootGValues[root] = g
          }
        }

        nodes.push({
          parent: null,
          root,
          left: succ.left,
          right: succ.right,
          leftVertex,
          rightVertex,
          nextPolygon,
          f: g,
          g,
        })
      }

      switch (succ.type) {
        case SuccessorType.RIGHT_NON_OBSERVABLE:
          if (rightG === -1) {
            rightG = parent.g + distance(parentRoot, parent.right)
          }
          pushNode(parent.rightVertex, rightG)
          break

        case SuccessorType.OBSERVABLE:
          pushNode(parent.root, parent.g)
          break

        case SuccessorType.LEFT_NON_OBSERVABLE:
          if (leftG === -1) {
            leftG = parent.g + distance(parentRoot, parent.left)
          }
          pushNode(parent.leftVertex, leftG)
          break
      }
    }

    return nodes
  }

  /** Generate initial search nodes from the start point */
  private genInitialNodes(): void {
    const pl = this.resolvePointLocation(this.start)
    const h = distance(this.start, this.goal)

    const makeLazy = (
      nextPoly: number,
      leftV: number,
      rightV: number,
    ): SearchNode => ({
      parent: null,
      root: -1,
      left: this.start,
      right: this.start,
      leftVertex: leftV,
      rightVertex: rightV,
      nextPolygon: nextPoly,
      f: h,
      g: 0,
    })

    const pushLazy = (lazy: SearchNode) => {
      const poly = lazy.nextPolygon
      if (poly === -1) return

      if (poly === this.endPolygon) {
        this.finalNode = lazy
        return
      }

      const vertices = this.mesh.polygons[poly]!.vertices
      const tempSuccessors: Successor[] = []
      let lastVertex = vertices[vertices.length - 1]!

      for (let i = 0; i < vertices.length; i++) {
        const vertex = vertices[i]!
        if (
          vertex === lazy.rightVertex ||
          lastVertex === lazy.leftVertex
        ) {
          lastVertex = vertex
          continue
        }
        tempSuccessors.push({
          type: SuccessorType.OBSERVABLE,
          left: this.mesh.vertices[vertex]!.p,
          right: this.mesh.vertices[lastVertex]!.p,
          polyLeftInd: i,
        })
        lastVertex = vertex
      }

      const nodes = this.succToNode(lazy, tempSuccessors)

      for (const n of nodes) {
        const nRoot: Point =
          n.root === -1 ? this.start : this.mesh.vertices[n.root]!.p
        if (!this.goalless) n.f += getHValue(nRoot, this.goal, n.left, n.right)
        n.parent = lazy

        if (this.stepMode) {
          this.stepEvents.push({
            type: StepEventType.NODE_PUSHED,
            node: { ...n },
            nodesInOpenList: this.openList.size + 1,
          })
        }

        this.openList.push(n)
      }

      this.nodesGenerated += nodes.length
      this.nodesPushed += nodes.length
    }

    switch (pl.type) {
      case PointLocationType.NOT_ON_MESH:
        break

      case PointLocationType.ON_CORNER_VERTEX_AMBIG: {
        if (this.goalless && pl.vertex1 !== -1) {
          // Goalless: expand from all adjacent polygons so the full visible
          // region is covered, not just the single polygon poly1 points to.
          for (const poly of this.mesh.vertices[pl.vertex1]!.polygons) {
            const lazy = makeLazy(poly, pl.vertex1, pl.vertex1)
            pushLazy(lazy)
            this.nodesGenerated++
          }
        } else if (pl.poly1 !== -1) {
          const lazy = makeLazy(pl.poly1, -1, -1)
          pushLazy(lazy)
          this.nodesGenerated++
        }
        break
      }

      case PointLocationType.ON_CORNER_VERTEX_UNAMBIG: {
        if (this.goalless) {
          // Goalless: expand from all adjacent polygons (same as
          // ON_NON_CORNER_VERTEX) so corners visible in every angular
          // sector around this vertex are found.
          for (const poly of this.mesh.vertices[pl.vertex1]!.polygons) {
            const lazy = makeLazy(poly, pl.vertex1, pl.vertex1)
            pushLazy(lazy)
            this.nodesGenerated++
          }
        } else {
          const lazy = makeLazy(pl.poly1, -1, -1)
          pushLazy(lazy)
          this.nodesGenerated++
        }
        break
      }

      case PointLocationType.IN_POLYGON:
      case PointLocationType.ON_MESH_BORDER: {
        const lazy = makeLazy(pl.poly1, -1, -1)
        pushLazy(lazy)
        this.nodesGenerated++
        break
      }

      case PointLocationType.ON_EDGE: {
        const lazy1 = makeLazy(pl.poly2, pl.vertex1, pl.vertex2)
        const lazy2 = makeLazy(pl.poly1, pl.vertex2, pl.vertex1)
        pushLazy(lazy1)
        this.nodesGenerated++
        if (this.finalNode) return
        pushLazy(lazy2)
        this.nodesGenerated++
        break
      }

      case PointLocationType.ON_NON_CORNER_VERTEX: {
        for (const poly of this.mesh.vertices[pl.vertex1]!.polygons) {
          const lazy = makeLazy(poly, pl.vertex1, pl.vertex1)
          pushLazy(lazy)
          this.nodesGenerated++
          if (this.finalNode) return
        }
        break
      }
    }
  }

  private initSearch(): void {
    this.searchId++
    this.openList.clear()
    this.finalNode = null
    this.nodesGenerated = 0
    this.nodesPushed = 0
    this.nodesPopped = 0
    this.nodesPrunedPostPop = 0
    this.successorCalls = 0
    this.stepEvents = []
    this.setEndPolygon()
    this.startPolygon = this.resolvePointLocation(this.start).poly1

    // Skip search if start and goal are on disconnected islands
    if (!this.mesh.sameIsland(this.startPolygon, this.endPolygon)) return

    this.genInitialNodes()
  }

  /** Maximum search time in milliseconds (0 = unlimited) */
  timeLimitMs = 3000

  /**
   * Run the full Polyanya search.
   * Returns true if a path was found, false otherwise.
   */
  search(): boolean {
    this.stepMode = false
    this.initSearch()

    if (this.endPolygon === -1) return false
    if (this.finalNode !== null) return true

    return this.runSearchLoop()
  }

  /**
   * Start a stepping search. Call `step()` repeatedly to advance.
   * Returns the initial step events.
   */
  searchInit(): StepEvent[] {
    this.stepMode = true
    this.initSearch()

    const events: StepEvent[] = [
      {
        type: StepEventType.INIT,
        nodesInOpenList: this.openList.size,
        message: `Initialized search from (${this.start.x}, ${this.start.y}) to (${this.goal.x}, ${this.goal.y}). End polygon: ${this.endPolygon}`,
      },
    ]

    if (this.endPolygon === -1) {
      events.push({
        type: StepEventType.SEARCH_EXHAUSTED,
        message: "Goal is not on the mesh",
      })
    } else if (!this.mesh.sameIsland(this.startPolygon, this.endPolygon)) {
      events.push({
        type: StepEventType.SEARCH_EXHAUSTED,
        message: "Start and goal are on different islands",
      })
    } else if (this.finalNode !== null) {
      events.push({
        type: StepEventType.GOAL_REACHED,
        node: { ...this.finalNode },
        message: "Trivial path: start can see goal directly",
      })
    }

    events.push(...this.stepEvents)
    this.stepEvents = []
    return events
  }

  /**
   * Execute one step of the search algorithm.
   * Returns an array of events that occurred during this step.
   */
  step(): StepEvent[] {
    this.stepMode = true
    this.stepEvents = []

    if (this.finalNode !== null) {
      return [
        {
          type: StepEventType.GOAL_REACHED,
          node: { ...this.finalNode },
          message: "Path already found",
        },
      ]
    }

    if (this.openList.size === 0) {
      return [
        {
          type: StepEventType.SEARCH_EXHAUSTED,
          message: "Open list is empty — no path exists",
        },
      ]
    }

    const node = this.openList.pop()!
    this.nodesPopped++

    this.stepEvents.push({
      type: StepEventType.NODE_POPPED,
      node: { ...node },
      nodesInOpenList: this.openList.size,
      message: `Popped node: root=${node.root}, f=${node.f.toFixed(4)}, g=${node.g.toFixed(4)}, poly=${node.nextPolygon}`,
    })

    // Check if we reached the goal polygon
    if (node.nextPolygon === this.endPolygon) {
      const finalNode = this.createFinalNode(node)
      this.finalNode = finalNode
      this.nodesGenerated++

      this.stepEvents.push({
        type: StepEventType.GOAL_REACHED,
        node: { ...finalNode },
        message: "Goal polygon reached!",
      })

      return this.stepEvents
    }

    // Root-level pruning
    if (node.root !== -1) {
      if (this.rootSearchIds[node.root] === this.searchId) {
        if (this.rootGValues[node.root]! + EPSILON < node.g) {
          this.nodesPrunedPostPop++
          this.stepEvents.push({
            type: StepEventType.NODE_PRUNED,
            node: { ...node },
            message: `Pruned: root ${node.root} already reached with better g (${this.rootGValues[node.root]!.toFixed(4)} < ${node.g.toFixed(4)})`,
          })
          return this.stepEvents
        }
      }
    }

    // Expand the node
    this.expandAndPush(node)

    return this.stepEvents
  }

  /** Check if the search is complete (either found or exhausted) */
  isSearchComplete(): boolean {
    return this.finalNode !== null || this.openList.size === 0
  }

  /** Get all nodes currently in the open list (for visualization) */
  getOpenListNodes(): SearchNode[] {
    return this.openList.toArray()
  }

  private createFinalNode(node: SearchNode): SearchNode {
    const root: Point =
      node.root === -1 ? this.start : this.mesh.vertices[node.root]!.p
    const rootGoal = sub(this.goal, root)

    let finalRoot: number
    // If root-left-goal is not CW, use left
    if (cross(rootGoal, sub(node.left, root)) < -EPSILON) {
      finalRoot = node.leftVertex
    }
    // If root-right-goal is not CCW, use right
    else if (cross(sub(node.right, root), rootGoal) < -EPSILON) {
      finalRoot = node.rightVertex
    } else {
      finalRoot = node.root
    }

    let finalCost: number
    if (finalRoot === node.root) {
      finalCost = node.g + distance(root, this.goal)
    } else {
      const corner: Point = this.mesh.vertices[finalRoot]!.p
      finalCost = node.g + distance(root, corner) + distance(corner, this.goal)
    }

    return {
      parent: node,
      root: finalRoot,
      left: this.goal,
      right: this.goal,
      leftVertex: -1,
      rightVertex: -1,
      nextPolygon: this.endPolygon,
      f: finalCost,
      g: finalCost,
    }
  }

  private expandAndPush(node: SearchNode): void {
    let numNodes = 1
    let currentNodes: SearchNode[] = [{ ...node }]
    let currentParent: SearchNode = node

    // Collinear collapsing loop — collapse single-successor chains
    // Safety limit to prevent infinite loops on degenerate meshes
    let collapseLimit = this.mesh.polygons.length + 2
    do {
      const curNode = currentNodes[0]!
      if (curNode.nextPolygon === this.endPolygon) break
      // In goalless mode we only care about the direct visibility region (root=-1).
      // Once a non-observable successor fires (root ≠ -1), the corner's g-value is
      // already recorded in rootGValues by succToNode — stop collapsing here.
      if (this.goalless && curNode.root !== -1) break

      const succs = getSuccessors(curNode, this.start, this.mesh)
      this.successorCalls++

      if (this.stepMode) {
        this.stepEvents.push({
          type: StepEventType.NODE_EXPANDED,
          node: { ...curNode },
          successors: [...succs],
          message: `Expanded in polygon ${curNode.nextPolygon}: ${succs.length} successor(s)`,
        })
      }

      currentNodes = this.succToNode(curNode, succs)
      numNodes = currentNodes.length

      if (numNodes === 1) {
        // Check if we turned (g changed)
        if (curNode.g !== currentNodes[0]!.g) {
          currentNodes[0]!.parent = currentParent
          currentParent = { ...currentNodes[0]! }
          this.nodesGenerated++
        }
      }

      collapseLimit--
      if (collapseLimit <= 0) break
    } while (numNodes === 1)

    // Push all resulting nodes onto the open list
    for (let i = 0; i < numNodes; i++) {
      const curNode = currentNodes[i]!

      // In goalless mode, corners (root ≠ -1) have their g-value already written
      // by succToNode. We don't need to expand from them — only the direct
      // visibility region (root = -1) needs further expansion.
      if (this.goalless && curNode.root !== -1) continue

      // Allocate the node and set its parent
      const n: SearchNode = { ...curNode }
      if (curNode.parent) {
        // Already has a valid parent from collinear collapsing
      } else {
        n.parent = currentParent
      }

      const nRoot: Point =
        n.root === -1 ? this.start : this.mesh.vertices[n.root]!.p
      if (!this.goalless) n.f += getHValue(nRoot, this.goal, n.left, n.right)

      if (this.stepMode) {
        this.stepEvents.push({
          type: StepEventType.NODE_PUSHED,
          node: { ...n },
          nodesInOpenList: this.openList.size + 1,
        })
      }

      this.openList.push(n)
    }

    this.nodesGenerated += numNodes
    this.nodesPushed += numNodes
  }

  private runSearchLoop(): boolean {
    const deadline =
      this.timeLimitMs > 0 ? performance.now() + this.timeLimitMs : Infinity

    while (this.openList.size > 0) {
      if (this.nodesPopped % 1000 === 0 && performance.now() > deadline) {
        return false // timed out
      }

      const node = this.openList.pop()!
      this.nodesPopped++

      if (node.nextPolygon === this.endPolygon) {
        this.finalNode = this.createFinalNode(node)
        this.nodesGenerated++
        return true
      }

      // Root-level pruning
      if (node.root !== -1) {
        if (this.rootSearchIds[node.root] === this.searchId) {
          if (this.rootGValues[node.root]! + EPSILON < node.g) {
            this.nodesPrunedPostPop++
            continue
          }
        }
      }

      this.expandAndPush(node)
    }

    return false
  }

  /** Get the path cost, or -1 if no path found */
  getCost(): number {
    if (this.finalNode === null) return -1
    return this.finalNode.f
  }

  /** Get the path as an array of waypoints from start to goal */
  getPathPoints(): Point[] {
    if (this.finalNode === null) return []

    const out: Point[] = [this.goal]
    let curNode: SearchNode | null = this.finalNode

    while (curNode !== null) {
      const rootPoint: Point =
        curNode.root === -1 ? this.start : this.mesh.vertices[curNode.root]!.p
      if (!pointsEqual(rootPoint, out[out.length - 1]!)) {
        out.push(rootPoint)
      }
      curNode = curNode.parent
    }

    out.reverse()
    return out
  }

  /**
   * Run a goalless Polyanya expansion from `from`.
   * Returns a map from vertex index → straight-line distance for every
   * corner vertex that is directly visible (no detour) from `from`.
   *
   * A corner v is directly visible iff g(v) ≈ distance(from, v): the
   * Polyanya g-value equals the Euclidean distance when no intermediate
   * turning point is needed.
   */
  computeVisibleCornersFromPoint(from: Point): Map<number, number> {
    const savedStart = this.start
    const savedGoal = this.goal
    const savedEndPolygon = this.endPolygon

    this.start = from
    this.goal = from  // h ≈ 0 → pure Dijkstra ordering
    this.endPolygon = -2  // never matches a polygon; prevents early termination
    this.goalless = true

    this.searchId++
    this.openList.clear()
    this.finalNode = null
    this.nodesGenerated = 0
    this.nodesPushed = 0
    this.nodesPopped = 0
    this.nodesPrunedPostPop = 0
    this.successorCalls = 0
    this.stepEvents = []

    this.startPolygon = this.resolvePointLocation(from).poly1
    if (this.startPolygon >= 0) {
      this.genInitialNodes()
      while (this.openList.size > 0) {
        const node = this.openList.pop()!
        this.nodesPopped++
        if (
          node.root !== -1 &&
          this.rootSearchIds[node.root] === this.searchId &&
          this.rootGValues[node.root]! + EPSILON < node.g
        ) {
          this.nodesPrunedPostPop++
          continue
        }
        this.expandAndPush(node)
      }
    }

    this.start = savedStart
    this.goal = savedGoal
    this.endPolygon = savedEndPolygon
    this.goalless = false

    // Collect all recorded corners that are directly visible from the source.
    // A corner is directly visible iff its recorded g ≈ Euclidean distance
    // (no intermediate turning point needed).
    const result = new Map<number, number>()
    for (let i = 0; i < this.mesh.vertices.length; i++) {
      if (this.rootSearchIds[i] !== this.searchId) continue
      const v = this.mesh.vertices[i]!
      if (!v.isCorner) continue
      const g = this.rootGValues[i]!
      const d = distance(from, v.p)
      if (g > d + 1e-4) continue // not directly visible (detour needed)
      result.set(i, d)
    }

    // Post-process: corners in adjacent polygons are always directly visible
    // (polygons in a Polyanya mesh are convex). This catches corners that are
    // only reachable via OBSERVABLE successors pointing to boundary edges —
    // those are skipped in succToNode so they never appear as non-observable roots.
    const pl = this.resolvePointLocation(from)
    if (pl.vertex1 >= 0) {
      for (const polyIdx of this.mesh.vertices[pl.vertex1]!.polygons) {
        if (polyIdx < 0) continue
        for (const vIdx of this.mesh.polygons[polyIdx]!.vertices) {
          if (vIdx === pl.vertex1) continue
          const v = this.mesh.vertices[vIdx]!
          if (!v.isCorner) continue
          const d = distance(from, v.p)
          if (!result.has(vIdx) || result.get(vIdx)! > d) {
            result.set(vIdx, d)
          }
        }
      }
    }

    return result
  }

  /**
   * Get the full search tree (all nodes from final back to start).
   * Useful for visualization.
   */
  getSearchTree(): SearchNode[] {
    if (this.finalNode === null) return []
    const tree: SearchNode[] = []
    let curNode: SearchNode | null = this.finalNode
    while (curNode !== null) {
      tree.push(curNode)
      curNode = curNode.parent
    }
    return tree
  }
}
