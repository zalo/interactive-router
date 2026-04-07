/**
 * Test script: reproduce the failing Polyanya search with obstacle-aware mesh.
 * Run with: npx tsx scripts/test-obstacle-search.ts
 */

import { cdtTriangulate, rectToPolygon } from "../src/lib/polyanya/cdt-builder"
import { buildMeshFromRegions } from "../src/lib/polyanya/mesh-builder"
import { mergeMesh } from "../src/lib/polyanya/mesh-merger"
import { SearchInstance } from "../src/lib/polyanya/search"
import { SuccessorType } from "../src/lib/polyanya/types"

// Test: 2 pads with a blocking obstacle in between
const bounds = { minX: -5, maxX: 5, minY: -5, maxY: 5 }

// Two endpoint pads and a blocking obstacle between them
const padA = rectToPolygon(-3, 0, 0.8, 0.8, 0.1) // obstacle 0 (start)
const padB = rectToPolygon(3, 0, 0.8, 0.8, 0.1)  // obstacle 1 (goal)
const blocker = rectToPolygon(0, 0, 1.5, 3, 0.1)  // obstacle 2 (wall)

const obstacles = [padA, padB, blocker]

console.log("=== CDT ===")
const cdtResult = cdtTriangulate({ bounds, obstacles })
console.log(`Regions: ${cdtResult.regions.length}`)
console.log(`Obstacle indices: ${cdtResult.obstacleIndices.filter(i => i >= 0).length} occupied, ${cdtResult.obstacleIndices.filter(i => i === -1).length} free`)

console.log("\n=== Mesh ===")
const rawMesh = buildMeshFromRegions(cdtResult)
console.log(`Raw: ${rawMesh.polygons.length} polys, ${rawMesh.vertices.length} verts`)

const mesh = mergeMesh(rawMesh)
console.log(`Merged: ${mesh.polygons.length} polys, ${mesh.vertices.length} verts`)

const corners = mesh.vertices.filter(v => v.isCorner).length
const ambig = mesh.vertices.filter(v => v.isAmbig).length
console.log(`Corners: ${corners}, Ambig: ${ambig}`)

// Count polygons by obstacleIndex
const obsCounts = new Map<number, number>()
for (const p of mesh.polygons) {
  obsCounts.set(p.obstacleIndex, (obsCounts.get(p.obstacleIndex) || 0) + 1)
}
console.log(`Polygon distribution:`, Object.fromEntries(obsCounts))

// Test search: from center of padA to center of padB
const start = { x: -3, y: 0 }
const goal = { x: 3, y: 0 }

// Find which obstacle indices the pads are
const startLoc = mesh.getPointLocation(start)
const goalLoc = mesh.getPointLocation(goal)
console.log(`\n=== Search ===`)
console.log(`Start: ${startLoc.type} poly=${startLoc.poly1}${startLoc.poly1 >= 0 ? ` obs=${mesh.polygons[startLoc.poly1]!.obstacleIndex}` : ""}`)
console.log(`Goal: ${goalLoc.type} poly=${goalLoc.poly1}${goalLoc.poly1 >= 0 ? ` obs=${mesh.polygons[goalLoc.poly1]!.obstacleIndex}` : ""}`)

// Search with ignore list = {0, 1} (both pads)
const si = new SearchInstance(mesh)
si.ignoreObstacles = new Set([0, 1])
si.timeLimitMs = 5000
si.setStartGoal(start, goal)

// Step through search
const initEvents = si.searchInit()
console.log(`Init events: ${initEvents.length}`)
for (const ev of initEvents) {
  if (ev.message) console.log(`  ${ev.type}: ${ev.message}`)
}

let stepCount = 0
let obsSucc = 0
let nonObsSucc = 0
let rootMinusOne = 0
let rootOther = 0

while (!si.isSearchComplete() && stepCount < 200) {
  const events = si.step()
  stepCount++

  for (const ev of events) {
    if (ev.successors) {
      for (const s of ev.successors) {
        if (s.type === SuccessorType.OBSERVABLE) obsSucc++
        else nonObsSucc++
      }
    }
    if (ev.node) {
      if (ev.node.root === -1) rootMinusOne++
      else rootOther++
    }

    if (stepCount <= 10 && ev.node) {
      console.log(`Step ${stepCount}: root=${ev.node.root} poly=${ev.node.nextPolygon} f=${ev.node.f.toFixed(3)} g=${ev.node.g.toFixed(3)}`)
    }
  }
}

console.log(`\nAfter ${stepCount} steps:`)
console.log(`  Observable successors: ${obsSucc}`)
console.log(`  Non-observable successors: ${nonObsSucc}`)
console.log(`  Root=-1 nodes: ${rootMinusOne}`)
console.log(`  Root=vertex nodes: ${rootOther}`)
console.log(`  Found: ${si.isSearchComplete() ? (si.finalNode ? "YES" : "NO (exhausted)") : "NO (limit)"}`)
console.log(`  Stats: popped=${si.nodesPopped} generated=${si.nodesGenerated} pruned=${si.nodesPrunedPostPop}`)

if (si.finalNode) {
  const path = si.getPathPoints()
  console.log(`  Path: ${path.map(p => `(${p.x.toFixed(2)},${p.y.toFixed(2)})`).join(" -> ")}`)
}

// Also test WITHOUT ignore list to confirm obstacles block
console.log(`\n=== Search WITHOUT ignore list ===`)
const si2 = new SearchInstance(mesh)
si2.ignoreObstacles = new Set()
si2.timeLimitMs = 1000
si2.setStartGoal(start, goal)
const found2 = si2.search()
console.log(`Found: ${found2}, popped=${si2.nodesPopped}, timedOut=${si2.timedOut}`)
