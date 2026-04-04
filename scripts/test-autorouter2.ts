import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const circuitJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../public/rp2040base.circuit.json"), "utf-8"))

// Reuse parse logic from test script
const byType = new Map<string, any[]>()
for (const el of circuitJson) { const arr = byType.get(el.type) || []; arr.push(el); byType.set(el.type, arr) }
const pcbSmtpads = byType.get("pcb_smtpad") || []
const pcbPorts = byType.get("pcb_port") || []
const sourcePorts = byType.get("source_port") || []
const sourceTraces = byType.get("source_trace") || []
const sourceNets = byType.get("source_net") || []

const pcbPortBySourcePortId = new Map<string, any>()
for (const pp of pcbPorts) pcbPortBySourcePortId.set(pp.source_port_id, pp)
const padToConnNames = new Map<string, string[]>()
const connections: any[] = []
let connId = 0
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
  if (netIds.length > 0) { for (const netId of netIds) { const arr = netEndpoints.get(netId) || []; arr.push(...endpoints); netEndpoints.set(netId, arr) } }
  else if (endpoints.length >= 2) { const name = `trace_${++connId}`; connections.push({ name, endpoints }); for (const ep of endpoints) { const arr = padToConnNames.get(ep.padId) || []; arr.push(name); padToConnNames.set(ep.padId, arr) } }
}
for (const [netId, endpoints] of netEndpoints) {
  const net = sourceNets.find((n: any) => n.source_net_id === netId)
  const name = net?.name || netId
  const seen = new Set<string>()
  const unique = endpoints.filter((ep: any) => { const key = `${ep.compId}:${ep.padId}`; if (seen.has(key)) return false; seen.add(key); return true })
  if (unique.length >= 2) { connections.push({ name, endpoints: unique }); for (const ep of unique) { const arr = padToConnNames.get(ep.padId) || []; arr.push(name); padToConnNames.set(ep.padId, arr) } }
}

const obstacles: any[] = []
let obsId = 0
for (const pad of pcbSmtpads) {
  obstacles.push({ obstacleId: `obs_${++obsId}`, type: "rect", layers: [pad.layer || "top"], center: { x: pad.x, y: pad.y }, width: Math.max(pad.width || 0.2, 0.1), height: Math.max(pad.height || 0.2, 0.1), connectedTo: padToConnNames.get(pad.pcb_smtpad_id) || [] })
}
const srjConnections: any[] = []
for (const conn of connections) {
  const points: any[] = []
  for (const ep of conn.endpoints) { const pad = pcbSmtpads.find((p: any) => p.pcb_smtpad_id === ep.padId); if (pad) points.push({ x: pad.x, y: pad.y, layer: pad.layer || "top" }) }
  if (points.length >= 2) srjConnections.push({ name: conn.name, pointsToConnect: points })
}

const srj = { layerCount: 2, minTraceWidth: 0.15, obstacles, connections: srjConnections, bounds: { minX: -27.5, maxX: 27.5, minY: -30, maxY: 30 } }

async function main() {
  const mod = await import(path.resolve(__dirname, "../../tscircuit-autorouter/dist/index.js"))
  const { GreedySequentialPipelineSolver } = mod
  const solver = new GreedySequentialPipelineSolver(srj)

  const startTime = performance.now()
  while (!solver.solved && !solver.failed && performance.now() - startTime < 10000) {
    solver.step()
  }

  console.log(`solved=${solver.solved} failed=${solver.failed}`)

  // Inspect greedy solver resolved paths
  if (solver.greedySolver) {
    const paths = solver.greedySolver.getResolvedPaths()
    console.log(`Resolved paths: ${paths.length}`)
    for (const p of paths.slice(0, 3)) {
      console.log(`  "${p.connectionName}": ${p.route.length} points, ${p.vias?.length ?? 0} vias`)
      console.log(`    route[0]:`, JSON.stringify(p.route[0]))
      console.log(`    route[last]:`, JSON.stringify(p.route[p.route.length - 1]))
    }
  }
}

main().catch(console.error)
