/**
 * Test the autorouter integration by building SRJ from the circuit JSON
 * and running the GreedySequentialPipelineSolver directly.
 */
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Load circuit JSON
const circuitJson = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../public/rp2040base.circuit.json"), "utf-8")
)

// Minimal circuit parser (same logic as circuitParser.ts)
function parseCircuit(elements: any[]) {
  const byType = new Map<string, any[]>()
  for (const el of elements) {
    const arr = byType.get(el.type) || []
    arr.push(el)
    byType.set(el.type, arr)
  }

  const pcbComponents = byType.get("pcb_component") || []
  const sourceComponents = byType.get("source_component") || []
  const pcbSmtpads = byType.get("pcb_smtpad") || []
  const pcbPorts = byType.get("pcb_port") || []
  const sourcePorts = byType.get("source_port") || []
  const sourceTraces = byType.get("source_trace") || []
  const sourceNets = byType.get("source_net") || []

  console.log(`Parsed: ${pcbComponents.length} components, ${pcbSmtpads.length} pads, ${sourceTraces.length} traces, ${sourceNets.length} nets`)

  // Build pad -> source_port -> pcb_port chain
  const sourcePortById = new Map<string, any>()
  for (const sp of sourcePorts) sourcePortById.set(sp.source_port_id, sp)

  const pcbPortBySourcePortId = new Map<string, any>()
  for (const pp of pcbPorts) pcbPortBySourcePortId.set(pp.source_port_id, pp)

  // Build pad -> connection name mapping
  const padToConnNames = new Map<string, string[]>()
  const connections: any[] = []
  let connId = 0

  // Net-based connections
  const netEndpoints = new Map<string, any[]>()
  for (const trace of sourceTraces) {
    const portIds: string[] = trace.connected_source_port_ids || []
    const netIds: string[] = trace.connected_source_net_ids || []

    const endpoints: any[] = []
    for (const pid of portIds) {
      const pcbPort = pcbPortBySourcePortId.get(pid)
      if (!pcbPort) continue
      const pad = pcbSmtpads.find((p: any) => p.pcb_port_id === pcbPort.pcb_port_id)
      if (!pad) continue
      endpoints.push({ padId: pad.pcb_smtpad_id, compId: pcbPort.pcb_component_id, layer: pad.layer || "top" })
    }

    if (netIds.length > 0) {
      for (const netId of netIds) {
        const arr = netEndpoints.get(netId) || []
        arr.push(...endpoints)
        netEndpoints.set(netId, arr)
      }
    } else if (endpoints.length >= 2) {
      const name = `trace_${++connId}`
      connections.push({ name, endpoints })
      for (const ep of endpoints) {
        const arr = padToConnNames.get(ep.padId) || []
        arr.push(name)
        padToConnNames.set(ep.padId, arr)
      }
    }
  }

  for (const [netId, endpoints] of netEndpoints) {
    const net = sourceNets.find((n: any) => n.source_net_id === netId)
    const name = net?.name || netId
    const seen = new Set<string>()
    const unique = endpoints.filter((ep: any) => {
      const key = `${ep.compId}:${ep.padId}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    if (unique.length >= 2) {
      connections.push({ name, endpoints: unique })
      for (const ep of unique) {
        const arr = padToConnNames.get(ep.padId) || []
        arr.push(name)
        padToConnNames.set(ep.padId, arr)
      }
    }
  }

  console.log(`Connections: ${connections.length}`)

  // Build SRJ obstacles from pads
  const obstacles: any[] = []
  let obsId = 0
  for (const pad of pcbSmtpads) {
    const connNames = padToConnNames.get(pad.pcb_smtpad_id) || []
    obstacles.push({
      obstacleId: `obs_${++obsId}`,
      type: "rect",
      layers: [pad.layer || "top"],
      center: { x: pad.x, y: pad.y },
      width: Math.max(pad.width || 0.2, 0.1),
      height: Math.max(pad.height || 0.2, 0.1),
      connectedTo: connNames,
    })
  }

  // Build SRJ connections
  const srjConnections: any[] = []
  for (const conn of connections) {
    const points: any[] = []
    for (const ep of conn.endpoints) {
      const pad = pcbSmtpads.find((p: any) => p.pcb_smtpad_id === ep.padId)
      if (pad) {
        points.push({ x: pad.x, y: pad.y, layer: pad.layer || "top" })
      }
    }
    if (points.length >= 2) {
      srjConnections.push({ name: conn.name, pointsToConnect: points })
    }
  }

  const connectedObs = obstacles.filter((o: any) => o.connectedTo.length > 0)
  console.log(`SRJ: ${obstacles.length} obstacles (${connectedObs.length} connected), ${srjConnections.length} connections`)

  // Sample connections
  for (const c of srjConnections.slice(0, 5)) {
    console.log(`  "${c.name}": ${c.pointsToConnect.length} pts -> ${c.pointsToConnect.map((p: any) => `(${p.x.toFixed(1)},${p.y.toFixed(1)})`).join(" ")}`)
  }

  return {
    layerCount: 2,
    minTraceWidth: 0.15,
    obstacles,
    connections: srjConnections,
    bounds: { minX: -27.5, maxX: 27.5, minY: -30, maxY: 30 },
  }
}

async function main() {
  const srj = parseCircuit(circuitJson)

  // Import the local autorouter
  const autorouterPath = path.resolve(__dirname, "../../tscircuit-autorouter/dist/index.js")
  console.log(`\nLoading autorouter from: ${autorouterPath}`)
  const mod = await import(autorouterPath)

  console.log("Available exports:", Object.keys(mod).filter(k => k.includes("Greedy") || k.includes("Pipeline")).join(", "))

  const { GreedySequentialPipelineSolver } = mod
  console.log("\nCreating solver...")
  const solver = new GreedySequentialPipelineSolver(srj)

  const startTime = performance.now()
  const timeout = 10000
  let lastPhase = ""

  while (!solver.solved && !solver.failed) {
    solver.step()
    const elapsed = performance.now() - startTime
    const phase = solver.getCurrentPhase()

    if (phase !== lastPhase) {
      console.log(`Phase: ${phase} (${elapsed.toFixed(0)}ms)`)
      lastPhase = phase
    }

    if (elapsed > timeout) {
      console.log(`Timeout at ${elapsed.toFixed(0)}ms`)
      break
    }
  }

  const elapsed = performance.now() - startTime
  console.log(`\nSolver done: solved=${solver.solved} failed=${solver.failed} error=${solver.error} elapsed=${elapsed.toFixed(0)}ms`)

  if (solver.solved) {
    try {
      const traces = solver.getOutputSimplifiedPcbTraces()
      console.log(`Output: ${traces.length} traces`)
      for (const t of traces.slice(0, 5)) {
        console.log(`  "${t.connection_name}": ${t.route.length} route points`)
      }
    } catch (e) {
      console.error("Failed to get output:", e)
    }
  } else {
    // Check partial state
    if (solver.greedySolver) {
      const paths = solver.greedySolver.getResolvedPaths?.()
      console.log(`Greedy solver has ${paths?.length ?? 0} resolved paths`)
    }
    if (solver.netToPointPairsSolver) {
      console.log(`NetToPointPairs solver: solved=${solver.netToPointPairsSolver.solved}`)
    }
  }
}

main().catch(console.error)
