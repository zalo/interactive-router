/**
 * Autorouter runner - wraps GreedySequentialPipelineSolver.
 * Steps the solver in requestAnimationFrame chunks with a 30s timeout.
 */

import type { RoutedTrace, TraceSegment, ViaData, Point } from "../types"

export interface AutorouterDebugData {
  baseObstaclePolygons: Array<{ x: number; y: number }[]>  // layer 0
  traceObstaclePolygons: Array<{ x: number; y: number }[]> // layer 0
  meshPolygons: Array<{ vertices: { x: number; y: number }[]; blocked: boolean; obstacleIndex: number }>
}

export interface AutorouterResult {
  success: boolean
  traces: Map<string, RoutedTrace>
  unroutedIds: Set<string>
  elapsedMs: number
  debugData?: AutorouterDebugData
}

export async function runAutorouter(
  srj: any, // SimpleRouteJson from srjBuilder
  timeoutMs = 10000,
  onProgress?: (progress: number) => void,
): Promise<AutorouterResult> {
  const mod = await import("../lib/autorouter/autorouter-pipelines/GreedySequentialPipeline/GreedySequentialPipelineSolver")
  const { GreedySequentialPipelineSolver } = mod

  console.log("[autorouter] Module loaded, exports:", Object.keys(mod).filter(k => k.includes("Greedy") || k.includes("Pipeline")).join(", "))
  console.log("[autorouter] SRJ:", srj.connections.length, "connections,", srj.obstacles.length, "obstacles")

  const solver = new GreedySequentialPipelineSolver(srj, {})
  const startTime = performance.now()
  console.log("[autorouter] Solver created, starting...")

  return new Promise((resolve) => {
    function tick() {
      const elapsed = performance.now() - startTime

      // Timeout — still try to extract any partial results
      if (elapsed > timeoutMs) {
        console.log(`[autorouter] Timeout after ${elapsed.toFixed(0)}ms, extracting partial results`)
        resolve(extractResult(solver, srj, elapsed))
        return
      }

      // Step the solver in a batch (multiple steps per frame for speed)
      const frameStart = performance.now()
      while (performance.now() - frameStart < 12) { // 12ms budget per frame
        if (solver.solved || solver.failed) break
        solver.step()
      }

      // Report progress
      const phase = solver.getCurrentPhase()
      const subProgress = solver.activeSubSolver?.progress ?? 0
      const phaseIndex = phase === "netToPointPairsSolver" ? 0 : phase === "greedySolver" ? 1 : 2
      const overallProgress = (phaseIndex + subProgress) / 3
      onProgress?.(Math.min(overallProgress, 0.99))

      // Log phase transitions
      if (solver.iterations % 500 === 0) {
        console.log(`[autorouter] iter=${solver.iterations} phase=${phase} progress=${(overallProgress*100).toFixed(1)}% elapsed=${elapsed.toFixed(0)}ms`)
      }

      if (solver.solved) {
        console.log(`[autorouter] Solved in ${elapsed.toFixed(0)}ms`)
        resolve(extractResult(solver, srj, elapsed))
        return
      }

      if (solver.failed) {
        console.log(`[autorouter] Failed: ${solver.error}, extracting partial results`)
        resolve(extractResult(solver, srj, elapsed))
        return
      }

      requestAnimationFrame(tick)
    }

    requestAnimationFrame(tick)
  })
}

function extractResult(
  solver: any,
  srj: any,
  elapsedMs: number,
): AutorouterResult {
  const traces = new Map<string, RoutedTrace>()
  const allConnectionNames = new Set<string>(srj.connections.map((c: any) => c.name))

  // Try to extract traces - from output solver if complete, or directly from greedy solver paths
  let pcbTraces: any[] = []
  try {
    if (solver.solved && solver.outputSolver) {
      pcbTraces = solver.getOutputSimplifiedPcbTraces()
      console.log(`[autorouter] Got ${pcbTraces.length} traces from output solver`)
    } else if (solver.greedySolver) {
      // Partial results: convert resolved paths directly to SimplifiedPcbTrace format
      const resolvedPaths = solver.greedySolver.getResolvedPaths?.() || []
      console.log(`[autorouter] Converting ${resolvedPaths.length} resolved paths from greedy solver`)
      const layerNames = ["top", "bottom", "inner1", "inner2", "inner3", "inner4"]
      for (const rp of resolvedPaths) {
        const route: any[] = []
        let prevZ = -1
        for (const pt of rp.route) {
          const layer = layerNames[pt.z] || "top"
          if (prevZ >= 0 && pt.z !== prevZ) {
            route.push({
              route_type: "via",
              x: pt.x,
              y: pt.y,
              from_layer: layerNames[prevZ] || "top",
              to_layer: layer,
            })
          }
          route.push({ route_type: "wire", x: pt.x, y: pt.y, width: 0.15, layer })
          prevZ = pt.z
        }
        // Strip the _mstN suffix added by NetToPointPairsSolver to get connection name
        const connName = rp.connectionName.replace(/_mst\d+$/, "")
        pcbTraces.push({
          type: "pcb_trace",
          pcb_trace_id: `trace_${connName}`,
          connection_name: connName,
          route,
        })
      }
      console.log(`[autorouter] Converted to ${pcbTraces.length} traces`)
    }
  } catch (e) {
    console.warn("[autorouter] Error extracting traces:", e)
  }

  for (const trace of pcbTraces) {
    const segments: TraceSegment[] = []
    const vias: ViaData[] = []
    let currentSegmentPoints: Point[] = []
    let currentLayer = ""
    let currentWidth = 0.15

    for (const routePoint of trace.route) {
      if (routePoint.route_type === "wire") {
        if (currentLayer && currentLayer !== routePoint.layer && currentSegmentPoints.length > 0) {
          segments.push({
            points: currentSegmentPoints,
            layer: currentLayer,
            width: currentWidth,
          })
          currentSegmentPoints = [{ x: routePoint.x, y: routePoint.y }]
        } else {
          currentSegmentPoints.push({ x: routePoint.x, y: routePoint.y })
        }
        currentLayer = routePoint.layer
        currentWidth = routePoint.width || 0.15
      } else if (routePoint.route_type === "via") {
        if (currentSegmentPoints.length > 0) {
          segments.push({
            points: currentSegmentPoints,
            layer: currentLayer,
            width: currentWidth,
          })
          currentSegmentPoints = [{ x: routePoint.x, y: routePoint.y }]
        }
        vias.push({
          x: routePoint.x,
          y: routePoint.y,
          fromLayer: routePoint.from_layer,
          toLayer: routePoint.to_layer,
          diameter: routePoint.via_diameter || 0.6,
        })
        currentLayer = routePoint.to_layer
      }
    }

    if (currentSegmentPoints.length > 0) {
      segments.push({
        points: currentSegmentPoints,
        layer: currentLayer,
        width: currentWidth,
      })
    }

    traces.set(trace.connection_name, {
      connectionId: trace.connection_name,
      segments,
      vias,
    })

    allConnectionNames.delete(trace.connection_name)
  }

  // Extract debug data from the greedy solver
  let debugData: AutorouterDebugData | undefined
  try {
    const gs = solver.greedySolver
    if (gs) {
      const baseObs = gs.baseObstaclePolygons?.[0] || []
      const traceObs = gs.tracePolygonObstacles?.[0] || []
      const mesh = gs.meshes?.[0]

      let meshPolygons: AutorouterDebugData["meshPolygons"] = []
      if (mesh) {
        meshPolygons = mesh.polygons.map((poly: any) => ({
          vertices: poly.vertices.map((vi: number) => ({
            x: mesh.vertices[vi].p.x,
            y: mesh.vertices[vi].p.y,
          })),
          blocked: poly.blocked,
          obstacleIndex: poly.obstacleIndex,
        }))
      }

      debugData = {
        baseObstaclePolygons: baseObs,
        traceObstaclePolygons: traceObs,
        meshPolygons,
      }
    }
  } catch {}

  return {
    success: solver.solved && allConnectionNames.size === 0,
    traces,
    unroutedIds: allConnectionNames,
    elapsedMs,
    debugData,
  }
}
