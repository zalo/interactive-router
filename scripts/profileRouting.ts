/**
 * Profile the simplified routing pipeline against the rp2040 board.
 * Run: npx tsx scripts/profileRouting.ts
 */

import { readFileSync } from "fs"
import { performance } from "perf_hooks"
import { parseCircuitJson } from "../src/state/circuitParser.ts"
import type { ComponentData, PlacementState, ConnectionData, BoardData, Point, ConnectionEndpoint, PadData } from "../src/types.ts"
import { cdtTriangulate } from "../src/lib/polyanya/index.ts"
import { buildMeshFromRegions } from "../src/lib/polyanya/index.ts"
import { mergeMesh } from "../src/lib/polyanya/index.ts"
import { SearchInstance } from "../src/lib/polyanya/index.ts"

// ─── Inline the helpers we need from meshManager / store ────────────

const PAD_CLEARANCE = 0.15
const MIN_CLEARANCE = 0.02
const GAP_MARGIN = 0.04

function getWorldPadPosition(
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
  componentId: string,
  padId: string,
): Point | null {
  const comp = components.get(componentId)
  const placement = placements.get(componentId)
  if (!comp || !placement) return null
  const pad = comp.pads.find((p) => p.id === padId)
  if (!pad) return null
  const rad = (placement.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return {
    x: placement.x + pad.localX * cos - pad.localY * sin,
    y: placement.y + pad.localX * sin + pad.localY * cos,
  }
}

function localRect(pad: PadData) {
  const hw = pad.width / 2
  const hh = pad.height / 2
  return [
    { x: pad.localX - hw, y: pad.localY - hh },
    { x: pad.localX + hw, y: pad.localY - hh },
    { x: pad.localX + hw, y: pad.localY + hh },
    { x: pad.localX - hw, y: pad.localY + hh },
  ]
}

function ptSegDist(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x, dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

function segSegDist(p1: any, p2: any, p3: any, p4: any) {
  return Math.min(ptSegDist(p1, p3, p4), ptSegDist(p2, p3, p4), ptSegDist(p3, p1, p2), ptSegDist(p4, p1, p2))
}

function polyPolyDist(a: any[], b: any[]) {
  let best = Infinity
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i]!, a2 = a[(i + 1) % a.length]!
    for (let j = 0; j < b.length; j++) {
      const b1 = b[j]!, b2 = b[(j + 1) % b.length]!
      best = Math.min(best, segSegDist(a1, a2, b1, b2))
    }
  }
  return best
}

function getPadClearances(comp: ComponentData): Map<string, number> {
  const pads = comp.pads
  const localPolys = pads.map(pad => localRect(pad))
  const clearances = new Map<string, number>()
  for (let i = 0; i < pads.length; i++) {
    let minGap = Infinity
    for (let j = 0; j < pads.length; j++) {
      if (i === j) continue
      const d = polyPolyDist(localPolys[i]!, localPolys[j]!)
      if (d < minGap) minGap = d
    }
    const clearance = Math.max(MIN_CLEARANCE, Math.min(PAD_CLEARANCE, (minGap - GAP_MARGIN) / 2))
    clearances.set(pads[i]!.id, clearance)
  }
  return clearances
}

function rotatedRectPolygon(cx: number, cy: number, w: number, h: number, rotation: number, clearance: number) {
  const hw = w / 2 + clearance
  const hh = h / 2 + clearance
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const corners = [
    { lx: -hw, ly: -hh }, { lx: hw, ly: -hh },
    { lx: hw, ly: hh }, { lx: -hw, ly: hh },
  ]
  return corners.map(({ lx, ly }) => ({
    x: cx + lx * cos - ly * sin,
    y: cy + lx * sin + ly * cos,
  }))
}

function clipObstacleToBounds(poly: { x: number; y: number }[], bounds: any) {
  return poly.map(p => ({
    x: Math.max(bounds.minX + 0.01, Math.min(bounds.maxX - 0.01, p.x)),
    y: Math.max(bounds.minY + 0.01, Math.min(bounds.maxY - 0.01, p.y)),
  }))
}

// ─── Main profiling ─────────────────────────────────────────────────

const circuitJson = JSON.parse(readFileSync("public/rp2040base.circuit.json", "utf-8"))

console.log("=== Simplified Pipeline Profiler (rp2040) ===\n")

// Phase 0: Parse circuit
const tParse0 = performance.now()
const parsed = parseCircuitJson(circuitJson)
const tParse1 = performance.now()

const components = parsed.components
const connections = parsed.connections
const board = parsed.board

// Build placements from original positions
const placements = new Map<string, PlacementState>()
for (const [id, comp] of components) {
  placements.set(id, {
    x: comp.originalPcbX,
    y: comp.originalPcbY,
    rotation: comp.originalRotation,
    frozen: false,
  })
}

console.log(`Circuit: ${components.size} components, ${connections.length} connections, board ${board.width}x${board.height}mm`)
let totalPads = 0
for (const comp of components.values()) totalPads += comp.pads.length
console.log(`Total pads: ${totalPads}`)
console.log()

// ─── Phase 1: Pad clearance computation ─────────────────────────────
const tClear0 = performance.now()
const clearanceMap = new Map<string, Map<string, number>>()
for (const [compId, comp] of components) {
  clearanceMap.set(compId, getPadClearances(comp))
}
const tClear1 = performance.now()

// ─── Phase 2: Obstacle polygon construction ─────────────────────────
const tObs0 = performance.now()
const halfW = board.width / 2
const halfH = board.height / 2
const bounds = { minX: -halfW - 1, maxX: halfW + 1, minY: -halfH - 1, maxY: halfH + 1 }

const obstacles: Array<{ x: number; y: number }[]> = []
const padIdToObstacle = new Map<string, number>()

for (const [compId, comp] of components) {
  const placement = placements.get(compId)
  if (!placement) continue
  const rad = (placement.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const clearances = clearanceMap.get(compId)!

  for (const pad of comp.pads) {
    const padLayers = pad.layers || [pad.layer]
    if (!padLayers.includes("top")) continue

    const wx = placement.x + pad.localX * cos - pad.localY * sin
    const wy = placement.y + pad.localX * sin + pad.localY * cos
    const clearance = clearances.get(pad.id) ?? PAD_CLEARANCE

    padIdToObstacle.set(pad.id, obstacles.length)
    let poly = rotatedRectPolygon(wx, wy, pad.width, pad.height, rad, clearance)
    poly = clipObstacleToBounds(poly, bounds)
    obstacles.push(poly)
  }
}
const tObs1 = performance.now()

// ─── Phase 3: CDT triangulation ─────────────────────────────────────
const tCdt0 = performance.now()
const cdtResult = cdtTriangulate({ bounds, obstacles })
const tCdt1 = performance.now()

// ─── Phase 4: Build mesh from regions ───────────────────────────────
const tBuild0 = performance.now()
const rawMesh = buildMeshFromRegions(cdtResult)
const tBuild1 = performance.now()

// ─── Phase 5: Merge mesh ────────────────────────────────────────────
const tMerge0 = performance.now()
const mesh = mergeMesh(rawMesh)
const tMerge1 = performance.now()

console.log(`Mesh stats: ${obstacles.length} obstacles → ${cdtResult.regions.length} CDT regions → ${rawMesh.polygons.length} raw polys → ${mesh.polygons.length} merged polys`)
console.log()

// ─── Phase 6: MST pair expansion ────────────────────────────────────
const tMst0 = performance.now()
const pairs: { connId: string; ep1: ConnectionEndpoint; ep2: ConnectionEndpoint; layer: string }[] = []

for (const conn of connections) {
  if (conn.endpoints.length < 2) continue
  if (conn.endpoints.length === 2) {
    pairs.push({ connId: conn.id, ep1: conn.endpoints[0]!, ep2: conn.endpoints[1]!, layer: conn.endpoints[0]!.layer || "top" })
  } else {
    const epPos: { ep: ConnectionEndpoint; pos: Point }[] = []
    for (const ep of conn.endpoints) {
      const pos = getWorldPadPosition(components, placements, ep.componentId, ep.padId)
      if (pos) epPos.push({ ep, pos })
    }
    if (epPos.length < 2) continue
    const inMST = new Uint8Array(epPos.length)
    inMST[0] = 1
    let added = 1
    while (added < epPos.length) {
      let bestI = -1, bestJ = -1, bestDist = Infinity
      for (let i = 0; i < epPos.length; i++) {
        if (!inMST[i]) continue
        for (let j = 0; j < epPos.length; j++) {
          if (inMST[j]) continue
          const d = Math.hypot(epPos[i]!.pos.x - epPos[j]!.pos.x, epPos[i]!.pos.y - epPos[j]!.pos.y)
          if (d < bestDist) { bestDist = d; bestI = i; bestJ = j }
        }
      }
      if (bestJ === -1) break
      inMST[bestJ] = 1
      added++
      pairs.push({
        connId: `${conn.id}_mst${added - 1}`,
        ep1: epPos[bestI]!.ep,
        ep2: epPos[bestJ]!.ep,
        layer: epPos[bestI]!.ep.layer || "top",
      })
    }
  }
}
const tMst1 = performance.now()

// ─── Phase 7: Polyanya pathfinding (all pairs) ─────────────────────
const searchTimings: { connId: string; ms: number; nodes: number; found: boolean }[] = []
let successes = 0
let failures = 0

const tSearch0 = performance.now()

// Sub-timings within search phase
let tSearchInstanceCreate = 0
let tSearchSetStartGoal = 0
let tSearchActualSearch = 0
let tSearchGetPath = 0

for (const pair of pairs) {
  const { connId, ep1, ep2 } = pair
  const startRaw = getWorldPadPosition(components, placements, ep1.componentId, ep1.padId)
  const goalRaw = getWorldPadPosition(components, placements, ep2.componentId, ep2.padId)
  if (!startRaw || !goalRaw) { failures++; continue }

  const ignoreObstacles = new Set<number>()
  const oi1 = padIdToObstacle.get(ep1.padId)
  const oi2 = padIdToObstacle.get(ep2.padId)
  if (oi1 !== undefined) ignoreObstacles.add(oi1)
  if (oi2 !== undefined) ignoreObstacles.add(oi2)

  const t0 = performance.now()
  const si = new SearchInstance(mesh)
  const t1 = performance.now()
  si.timeLimitMs = 50
  si.ignoreObstacles = ignoreObstacles
  si.setStartGoal(startRaw, goalRaw)
  const t2 = performance.now()
  const found = si.search()
  const t3 = performance.now()

  tSearchInstanceCreate += t1 - t0
  tSearchSetStartGoal += t2 - t1
  tSearchActualSearch += t3 - t2

  if (found) {
    const t4 = performance.now()
    si.getPathPoints()
    const t5 = performance.now()
    tSearchGetPath += t5 - t4
    successes++
  } else {
    failures++
  }

  searchTimings.push({
    connId,
    ms: performance.now() - t0,
    nodes: si.nodesPopped,
    found,
  })
}

const tSearch1 = performance.now()

// ─── Results ────────────────────────────────────────────────────────

const phases = [
  { name: "Parse circuit JSON", ms: tParse1 - tParse0 },
  { name: "Pad clearance computation", ms: tClear1 - tClear0 },
  { name: "Obstacle polygon construction", ms: tObs1 - tObs0 },
  { name: "CDT triangulation", ms: tCdt1 - tCdt0 },
  { name: "Build mesh from regions", ms: tBuild1 - tBuild0 },
  { name: "Merge mesh", ms: tMerge1 - tMerge0 },
  { name: "MST pair expansion", ms: tMst1 - tMst0 },
  { name: "Polyanya pathfinding (all)", ms: tSearch1 - tSearch0 },
]

const totalMs = phases.reduce((s, p) => s + p.ms, 0)

console.log("─── Phase Timings ─────────────────────────────────────────")
for (const p of phases) {
  const pct = ((p.ms / totalMs) * 100).toFixed(1)
  const bar = "█".repeat(Math.round(p.ms / totalMs * 40))
  console.log(`  ${p.name.padEnd(35)} ${p.ms.toFixed(2).padStart(8)}ms  ${pct.padStart(5)}%  ${bar}`)
}
console.log(`  ${"TOTAL".padEnd(35)} ${totalMs.toFixed(2).padStart(8)}ms`)
console.log()

console.log("─── Pathfinding Sub-Timings ────────────────────────────────")
console.log(`  SearchInstance creation:   ${tSearchInstanceCreate.toFixed(2)}ms`)
console.log(`  setStartGoal:             ${tSearchSetStartGoal.toFixed(2)}ms`)
console.log(`  search() execution:       ${tSearchActualSearch.toFixed(2)}ms`)
console.log(`  getPathPoints():          ${tSearchGetPath.toFixed(2)}ms`)
console.log()

console.log(`─── Pathfinding Results ────────────────────────────────────`)
console.log(`  ${pairs.length} pairs: ${successes} routed, ${failures} failed`)
console.log()

// Top 10 slowest searches
searchTimings.sort((a, b) => b.ms - a.ms)
console.log("─── Top 10 Slowest Searches ───────────────────────────────")
for (const s of searchTimings.slice(0, 10)) {
  console.log(`  ${s.connId.padEnd(30)} ${s.ms.toFixed(2).padStart(7)}ms  ${s.nodes} nodes  ${s.found ? "OK" : "FAIL"}`)
}
console.log()

// Histogram of search times
const buckets = [0.1, 0.5, 1, 2, 5, 10, 50]
console.log("─── Search Time Distribution ──────────────────────────────")
let prev = 0
for (const b of buckets) {
  const count = searchTimings.filter(s => s.ms >= prev && s.ms < b).length
  if (count > 0) console.log(`  ${prev.toString().padStart(4)}-${b.toString().padStart(4)}ms: ${count}`)
  prev = b
}
const over = searchTimings.filter(s => s.ms >= prev).length
if (over > 0) console.log(`  ${prev.toString().padStart(4)}+   ms: ${over}`)

// Run it 5 more times to get warm timings
console.log("\n─── Warm Runs (mesh build + all searches) ──────────────────")
for (let run = 0; run < 5; run++) {
  const t0 = performance.now()

  // Rebuild obstacles
  const obs2: Array<{ x: number; y: number }[]> = []
  const padMap2 = new Map<string, number>()
  for (const [compId, comp] of components) {
    const placement = placements.get(compId)!
    const rad = (placement.rotation * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const clearances = clearanceMap.get(compId)!
    for (const pad of comp.pads) {
      if (!(pad.layers || [pad.layer]).includes("top")) continue
      const wx = placement.x + pad.localX * cos - pad.localY * sin
      const wy = placement.y + pad.localX * sin + pad.localY * cos
      padMap2.set(pad.id, obs2.length)
      let poly = rotatedRectPolygon(wx, wy, pad.width, pad.height, rad, clearances.get(pad.id) ?? PAD_CLEARANCE)
      poly = clipObstacleToBounds(poly, bounds)
      obs2.push(poly)
    }
  }
  const tA = performance.now()

  const cdt2 = cdtTriangulate({ bounds, obstacles: obs2 })
  const tB = performance.now()

  const raw2 = buildMeshFromRegions(cdt2)
  const tC = performance.now()

  const mesh2 = mergeMesh(raw2)
  const tD = performance.now()

  let s = 0
  for (const pair of pairs) {
    const start = getWorldPadPosition(components, placements, pair.ep1.componentId, pair.ep1.padId)
    const goal = getWorldPadPosition(components, placements, pair.ep2.componentId, pair.ep2.padId)
    if (!start || !goal) continue
    const ignore = new Set<number>()
    const o1 = padMap2.get(pair.ep1.padId); if (o1 !== undefined) ignore.add(o1)
    const o2 = padMap2.get(pair.ep2.padId); if (o2 !== undefined) ignore.add(o2)
    const si = new SearchInstance(mesh2)
    si.timeLimitMs = 50
    si.ignoreObstacles = ignore
    si.setStartGoal(start, goal)
    if (si.search()) s++
  }
  const tE = performance.now()

  console.log(
    `  Run ${run + 1}: obs=${(tA-t0).toFixed(1)}ms  cdt=${(tB-tA).toFixed(1)}ms  build=${(tC-tB).toFixed(1)}ms  merge=${(tD-tC).toFixed(1)}ms  search=${(tE-tD).toFixed(1)}ms  total=${(tE-t0).toFixed(1)}ms  (${s}/${pairs.length} routed)`
  )
}
