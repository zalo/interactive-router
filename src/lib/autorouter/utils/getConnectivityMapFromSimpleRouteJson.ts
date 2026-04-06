import { SimpleRouteJson } from "../types/index"
import { ConnectivityMap } from "circuit-json-to-connectivity-map"
import { mapLayerNameToZ } from "./mapLayerNameToZ"

const pointHash = (point: { x: number; y: number }) =>
  `${Math.round(point.x * 100)},${Math.round(point.y * 100)}`

export const getConnectivityMapFromSimpleRouteJson = (srj: SimpleRouteJson) => {
  const connMap = new ConnectivityMap({})
  for (const connection of srj.connections) {
    if (connection.rootConnectionName) {
      connMap.addConnections([[connection.name, connection.rootConnectionName]])
    }
    // Also link the connection name to its overall netConnectionName if available
    if (connection.netConnectionName) {
      connMap.addConnections([[connection.name, connection.netConnectionName]])
    }

    // Link to all merged connection names (original names before merge)
    if (connection.mergedConnectionNames) {
      for (const mergedName of connection.mergedConnectionNames) {
        connMap.addConnections([[connection.name, mergedName]])
      }
    }

    for (const point of connection.pointsToConnect) {
      connMap.addConnections([
        [
          connection.name,
          `${pointHash(point)}:${
            "layers" in point
              ? point.layers
                  .map((l) => mapLayerNameToZ(l, srj.layerCount))
                  .sort()
                  .join("-")
              : mapLayerNameToZ(point.layer, srj.layerCount)
          }`,
        ],
      ])
      if ("pcb_port_id" in point && point.pcb_port_id) {
        connMap.addConnections([[connection.name, point.pcb_port_id as string]])
      }
    }
  }
  for (const obstacle of srj.obstacles) {
    const offBoardConnections = obstacle.offBoardConnectsTo ?? []
    const connectionGroup = Array.from(
      new Set(
        [
          obstacle.obstacleId!,
          ...obstacle.connectedTo,
          ...offBoardConnections,
          `${pointHash(obstacle.center)}:${obstacle.layers
            .map((l) => mapLayerNameToZ(l, srj.layerCount))
            .sort()
            .join("-")}`,
        ].filter(Boolean),
      ),
    )

    if (connectionGroup.length > 0) {
      connMap.addConnections([connectionGroup])
    }
  }
  return connMap
}
