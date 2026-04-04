/**
 * Interactive routing mode interaction handlers.
 * Handles: click pad to start route, live preview, via placement,
 * trace completion, right-click delete.
 */

import { useAppStore, getWorldPadPosition } from "../state/store"
import { screenToWorld, type CanvasContext } from "../canvas/renderer"
import type { Point, ConnectionData, ComponentData, PlacementState } from "../types"
import {
  startLiveRoute,
  getLiveState,
  queryLivePath,
  queryCompletionPath,
  placeVia,
  completeRoute,
  cancelRoute,
  isRouteActive,
} from "../pathfinding/livePathfinder"
import { invalidateAllMeshes } from "../pathfinding/meshManager"

const SNAP_DISTANCE = 1.5 // mm — snap to endpoint when within this distance

/** Find the nearest unrouted connection endpoint to a world point */
function findNearestUnroutedEndpoint(
  worldPos: Point,
  connections: ConnectionData[],
  unroutedIds: Set<string>,
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
): { connectionId: string; endpointIndex: number; worldPos: Point; layer: string; connection: ConnectionData } | null {
  let bestDist = Infinity
  let bestResult: any = null

  for (const conn of connections) {
    if (!unroutedIds.has(conn.id)) continue

    for (let i = 0; i < conn.endpoints.length; i++) {
      const ep = conn.endpoints[i]
      const pos = getWorldPadPosition(components, placements, ep.componentId, ep.padId)
      if (!pos) continue

      const dx = pos.x - worldPos.x
      const dy = pos.y - worldPos.y
      const dist = Math.sqrt(dx * dx + dy * dy)

      if (dist < bestDist && dist < SNAP_DISTANCE * 2) {
        bestDist = dist
        bestResult = {
          connectionId: conn.id,
          endpointIndex: i,
          worldPos: pos,
          layer: ep.layer,
          connection: conn,
        }
      }
    }
  }

  return bestResult
}

/** Handle pointer down in interactive routing mode */
export function handleRoutingPointerDown(
  worldPos: Point,
  button: number,
  getCC: () => CanvasContext,
) {
  const state = useAppStore.getState()

  // Right-click: delete trace under cursor or cancel active route
  if (button === 2) {
    if (isRouteActive()) {
      cancelRoute()
      return
    }

    // Find and delete trace near click point
    for (const [connId, trace] of state.routedTraces) {
      for (const seg of trace.segments) {
        for (let i = 0; i < seg.points.length - 1; i++) {
          const dist = pointToSegmentDistance(worldPos, seg.points[i], seg.points[i + 1])
          if (dist < 1.0) {
            // Delete this trace
            const newTraces = new Map(state.routedTraces)
            newTraces.delete(connId)
            const newUnrouted = new Set(state.unroutedConnectionIds)
            newUnrouted.add(connId)
            state.setRoutedTraces(newTraces, newUnrouted)
            invalidateAllMeshes()
            return
          }
        }
      }
    }
    return
  }

  // Left click
  if (button === 0) {
    if (isRouteActive()) {
      // Active route: check if clicking near target endpoint to complete
      const liveState = getLiveState()!
      const dx = worldPos.x - liveState.targetEndpoint.x
      const dy = worldPos.y - liveState.targetEndpoint.y
      const distToTarget = Math.sqrt(dx * dx + dy * dy)

      if (distToTarget < SNAP_DISTANCE) {
        // Complete the route
        const pathToTarget = queryLivePath(
          liveState.targetEndpoint,
          state.board,
          state.components,
          state.placements,
          state.routedTraces,
        )
        if (pathToTarget) {
          const result = completeRoute(pathToTarget)
          if (result) {
            const newTraces = new Map(state.routedTraces)
            newTraces.set(liveState.connectionId, {
              connectionId: liveState.connectionId,
              segments: result.segments,
              vias: result.vias,
            })
            const newUnrouted = new Set(state.unroutedConnectionIds)
            newUnrouted.delete(liveState.connectionId)
            state.setRoutedTraces(newTraces, newUnrouted)
            invalidateAllMeshes()
          }
        }
        return
      }

      // Not near target: place a via
      const pathToVia = queryLivePath(
        worldPos,
        state.board,
        state.components,
        state.placements,
        state.routedTraces,
      )
      if (pathToVia) {
        placeVia(worldPos, pathToVia)
      }
      return
    }

    // Not in active route: start a new route from nearest unrouted pad
    const nearest = findNearestUnroutedEndpoint(
      worldPos,
      state.connections,
      state.unroutedConnectionIds,
      state.components,
      state.placements,
    )

    if (nearest) {
      // Find the other endpoint of this connection
      const otherIdx = nearest.endpointIndex === 0 ? nearest.connection.endpoints.length - 1 : 0
      const otherEp = nearest.connection.endpoints[otherIdx]
      const otherPos = getWorldPadPosition(state.components, state.placements, otherEp.componentId, otherEp.padId)
      if (!otherPos) return

      // Pass pad IDs so the mesh excludes them (allowing pathfinder to reach them)
      const nearestEp = nearest.connection.endpoints[nearest.endpointIndex]
      startLiveRoute(
        nearest.connectionId,
        nearest.worldPos,
        nearest.layer,
        otherPos,
        otherEp.layer,
        nearestEp.padId,
        otherEp.padId,
      )
    }
  }
}

/** Handle pointer move in interactive routing mode — update live preview */
export function handleRoutingPointerMove(
  worldPos: Point,
): Point[] | null {
  if (!isRouteActive()) return null

  const state = useAppStore.getState()
  return queryLivePath(
    worldPos,
    state.board,
    state.components,
    state.placements,
    state.routedTraces,
  )
}

function pointToSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq < 0.0001) return Math.sqrt((p.x - a.x) ** 2 + (p.y - a.y) ** 2)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq))
  const projX = a.x + t * dx
  const projY = a.y + t * dy
  return Math.sqrt((p.x - projX) ** 2 + (p.y - projY) ** 2)
}
