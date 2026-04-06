/**
 * Live pathfinding for cursor-following during interactive routing.
 * Uses CDT mesh exclusion — rebuilds mesh per query excluding start/end pads.
 */

import type { Point, BoardData, ComponentData, PlacementState, RoutedTrace } from "../types"
import { findPath } from "./meshManager"

export interface LivePathState {
  connectionId: string
  startPoint: Point
  startLayer: string
  targetEndpoint: Point
  targetLayer: string
  currentLayer: string
  anchorPoint: Point
  startPadId?: string
  endPadId?: string
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
  activeState = {
    connectionId,
    startPoint,
    startLayer,
    targetEndpoint,
    targetLayer,
    currentLayer: startLayer,
    anchorPoint: { ...startPoint },
    startPadId,
    endPadId,
    placedVias: [],
    committedSegments: [],
  }
}

export function getLiveState(): LivePathState | null {
  return activeState
}

export function queryLivePath(
  mousePos: Point,
  board: BoardData,
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
  routedTraces: Map<string, RoutedTrace>,
): Point[] | null {
  if (!activeState) return null

  // Exclude start/end pads from the mesh so pathfinder can reach them
  const excludePads = [activeState.startPadId, activeState.endPadId].filter(Boolean) as string[]

  return findPath(
    activeState.currentLayer,
    activeState.anchorPoint,
    mousePos,
    board,
    components,
    placements,
    routedTraces,
    activeState.connectionId,
    excludePads,
  )
}

export function queryCompletionPath(
  mousePos: Point,
  board: BoardData,
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
  routedTraces: Map<string, RoutedTrace>,
): Point[] | null {
  if (!activeState) return null

  const excludePads = [activeState.startPadId, activeState.endPadId].filter(Boolean) as string[]

  return findPath(
    activeState.currentLayer,
    mousePos,
    activeState.targetEndpoint,
    board,
    components,
    placements,
    routedTraces,
    activeState.connectionId,
    excludePads,
  )
}

export function placeVia(viaPos: Point, pathToVia: Point[]): void {
  if (!activeState) return

  const fromLayer = activeState.currentLayer
  const toLayer = fromLayer === "top" ? "bottom" : "top"

  if (pathToVia.length >= 2) {
    activeState.committedSegments.push({
      points: pathToVia,
      layer: fromLayer,
      width: 0.15,
    })
  }

  activeState.placedVias.push({ x: viaPos.x, y: viaPos.y, fromLayer, toLayer })
  activeState.currentLayer = toLayer
  activeState.anchorPoint = { ...viaPos }
}

export function completeRoute(
  pathToTarget: Point[],
): { segments: Array<{ points: Point[]; layer: string; width: number }>; vias: Array<{ x: number; y: number; fromLayer: string; toLayer: string; diameter: number }> } | null {
  if (!activeState) return null

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
  return result
}

export function cancelRoute() {
  activeState = null
}

export function isRouteActive(): boolean {
  return activeState !== null
}
