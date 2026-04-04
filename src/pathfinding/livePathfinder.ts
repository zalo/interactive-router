/**
 * Live pathfinding for cursor-following during interactive routing.
 * Wraps meshManager for quick per-frame queries.
 */

import type { Point, BoardData, ComponentData, PlacementState, RoutedTrace } from "../types"
import { findPath, invalidateAllMeshes } from "./meshManager"

export interface LivePathState {
  connectionId: string
  startPoint: Point
  startLayer: string
  targetEndpoint: Point
  targetLayer: string
  currentLayer: string
  anchorPoint: Point
  placedVias: Array<{ x: number; y: number; fromLayer: string; toLayer: string }>
  committedSegments: Array<{ points: Point[]; layer: string; width: number }>
}

let activeState: LivePathState | null = null

export function startLiveRoute(
  connectionId: string,
  startPoint: Point,
  startLayer: string,
  targetEndpoint: Point,
  targetLayer: string,
  startPadId?: string,
  endPadId?: string,
) {
  invalidateAllMeshes()
  activeState = {
    connectionId,
    startPoint,
    startLayer,
    targetEndpoint,
    targetLayer,
    currentLayer: startLayer,
    anchorPoint: { ...startPoint },
    placedVias: [],
    committedSegments: [],
  }
}

export function getLiveState(): LivePathState | null {
  return activeState
}

/**
 * Query a path from the current anchor to the mouse position.
 * Called every frame during active routing.
 */
export function queryLivePath(
  mousePos: Point,
  board: BoardData,
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
  routedTraces: Map<string, RoutedTrace>,
): Point[] | null {
  if (!activeState) return null

  return findPath(
    activeState.currentLayer,
    activeState.anchorPoint,
    mousePos,
    board,
    components,
    placements,
    routedTraces,
    activeState.connectionId,
  )
}

/**
 * Also compute the completion path from mouse to the target endpoint.
 */
export function queryCompletionPath(
  mousePos: Point,
  board: BoardData,
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
  routedTraces: Map<string, RoutedTrace>,
): Point[] | null {
  if (!activeState) return null

  return findPath(
    activeState.currentLayer,
    mousePos,
    activeState.targetEndpoint,
    board,
    components,
    placements,
    routedTraces,
    activeState.connectionId,
  )
}

/**
 * Place a via at the current mouse position. Commits the segment from
 * anchor to via, toggles layer, sets new anchor.
 */
export function placeVia(
  viaPos: Point,
  pathToVia: Point[],
): void {
  if (!activeState) return

  const fromLayer = activeState.currentLayer
  const toLayer = fromLayer === "top" ? "bottom" : "top"

  // Commit segment from anchor to via
  if (pathToVia.length >= 2) {
    activeState.committedSegments.push({
      points: pathToVia,
      layer: fromLayer,
      width: 0.15,
    })
  }

  activeState.placedVias.push({
    x: viaPos.x,
    y: viaPos.y,
    fromLayer,
    toLayer,
  })

  activeState.currentLayer = toLayer
  activeState.anchorPoint = { ...viaPos }
}

/**
 * Complete the route — commit the final segment to the target endpoint.
 * Returns the finished trace data.
 */
export function completeRoute(
  pathToTarget: Point[],
): { segments: Array<{ points: Point[]; layer: string; width: number }>; vias: Array<{ x: number; y: number; fromLayer: string; toLayer: string; diameter: number }> } | null {
  if (!activeState) return null

  // Commit final segment
  if (pathToTarget.length >= 2) {
    activeState.committedSegments.push({
      points: pathToTarget,
      layer: activeState.currentLayer,
      width: 0.15,
    })
  }

  const result = {
    segments: [...activeState.committedSegments],
    vias: activeState.placedVias.map((v) => ({ ...v, diameter: 0.6 })),
  }

  activeState = null
  invalidateAllMeshes()
  return result
}

export function cancelRoute() {
  activeState = null
  invalidateAllMeshes()
}

export function isRouteActive(): boolean {
  return activeState !== null
}
