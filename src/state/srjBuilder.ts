/**
 * Converts internal placement state to SimpleRouteJson for the autorouter.
 */

import type { ComponentData, ConnectionData, PlacementState, BoardData, Point } from "../types"
import { getWorldPadPosition } from "./store"

export function buildSimpleRouteJson(
  board: BoardData,
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
  connections: ConnectionData[],
) {
  const halfW = board.width / 2
  const halfH = board.height / 2

  // Build a map: padId -> list of connection names this pad participates in
  const padToConnectionNames = new Map<string, string[]>()
  for (const conn of connections) {
    for (const ep of conn.endpoints) {
      const names = padToConnectionNames.get(ep.padId) || []
      names.push(conn.name)
      padToConnectionNames.set(ep.padId, names)
    }
  }

  // Create obstacles from component pads
  const obstacles: any[] = []
  let obstacleCounter = 0

  for (const [compId, comp] of components) {
    const placement = placements.get(compId)
    if (!placement) continue

    const rad = (placement.rotation * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)

    for (const pad of comp.pads) {
      const wx = placement.x + pad.localX * cos - pad.localY * sin
      const wy = placement.y + pad.localX * sin + pad.localY * cos

      // connectedTo must contain the connection NAMES that touch this pad
      const connNames = padToConnectionNames.get(pad.id) || []

      obstacles.push({
        obstacleId: `obstacle_${++obstacleCounter}`,
        type: "rect",
        layers: pad.layers || [pad.layer],
        center: { x: wx, y: wy },
        width: Math.max(pad.width, 0.1),
        height: Math.max(pad.height, 0.1),
        connectedTo: connNames,
      })
    }

    // NOTE: Only pads are obstacles for routing, not the component body.
    // The router needs to route traces between/over component bodies.
  }

  // Create connections with pointsToConnect
  const srjConnections: any[] = []
  for (const conn of connections) {
    const points: any[] = []

    for (const ep of conn.endpoints) {
      const pos = getWorldPadPosition(components, placements, ep.componentId, ep.padId)
      if (pos) {
        points.push({
          x: pos.x,
          y: pos.y,
          layer: ep.layer,
          pcb_port_id: ep.padId,
        })
      }
    }

    if (points.length >= 2) {
      srjConnections.push({
        name: conn.name,
        pointsToConnect: points,
      })
    }
  }

  const srj = {
    layerCount: board.layerCount,
    minTraceWidth: 0.15,
    obstacles,
    connections: srjConnections,
    bounds: { minX: -halfW, maxX: halfW, minY: -halfH, maxY: halfH },
  }

  console.log(`[srj] Built: ${obstacles.length} obstacles, ${srjConnections.length} connections, bounds=${halfW*2}x${halfH*2}mm`)

  // Log first few connections for debugging
  for (const conn of srjConnections.slice(0, 3)) {
    console.log(`[srj]   conn "${conn.name}": ${conn.pointsToConnect.length} points`, conn.pointsToConnect.map((p: any) => `(${p.x.toFixed(1)},${p.y.toFixed(1)} ${p.layer})`).join(" -> "))
  }
  // Log obstacle connectivity stats
  const connectedObstacles = obstacles.filter((o: any) => o.connectedTo.length > 0)
  console.log(`[srj]   ${connectedObstacles.length}/${obstacles.length} obstacles have connections`)

  return srj
}
