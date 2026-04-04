/**
 * Placement physics simulation — two-body architecture.
 *
 * Each component has:
 *   outer body = margin collider (rotation-locked, handles collision)
 *   inner body = footprint (free rotation via revolute joint, no collision)
 *
 * Distance joints connect INNER bodies at pad positions, so the
 * connection forces create torque that rotates the footprint to its
 * optimal angle. The margin collider stays axis-aligned and handles
 * separation.
 *
 * Dragging applies velocity (not teleport) to jostle the pile.
 */

import type { ComponentData, ConnectionData, PlacementState } from "../types"
import {
  initBox2D,
  createWorld,
  createComponentBodies,
  createWallSegment,
  createDistanceJoint,
  stepWorld,
  getBodyPosition,
  getBodyRotation,
  setBodyTransform,
  setBodyType,
  setBodyLinearVelocity,
  applyForceToCenter,
  getOuterBodyId,
  getInnerBodyId,
  startMouseDrag,
  updateMouseDrag,
  endMouseDrag,
  applyMouseDragForce,
  getDragTargetComponentId,
  getBox2D,
} from "./box2dManager"

let simState = { initialized: false, running: false }
let componentMargin = 1.5
let connectionJointIds: Array<{ jointId: any; hertz: number }> = []
let springForcesActive = true

export function setComponentMargin(margin: number) {
  componentMargin = margin
}

export function getComponentMargin(): number {
  return componentMargin
}

export async function initPlacementSim(
  boardWidth: number,
  boardHeight: number,
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
  connections: ConnectionData[],
  margin = componentMargin,
) {
  await initBox2D()
  createWorld(0, 0)

  const halfW = boardWidth / 2
  const halfH = boardHeight / 2
  const wallPadding = 2

  createWallSegment(-halfW - wallPadding, -halfH - wallPadding, halfW + wallPadding, -halfH - wallPadding)
  createWallSegment(halfW + wallPadding, -halfH - wallPadding, halfW + wallPadding, halfH + wallPadding)
  createWallSegment(halfW + wallPadding, halfH + wallPadding, -halfW - wallPadding, halfH + wallPadding)
  createWallSegment(-halfW - wallPadding, halfH + wallPadding, -halfW - wallPadding, -halfH - wallPadding)

  componentMargin = margin
  connectionJointIds = []

  for (const [id, comp] of components) {
    const placement = placements.get(id)
    if (!placement) continue

    const { outer } = createComponentBodies(
      id,
      placement.x,
      placement.y,
      comp.width / 2,
      comp.height / 2,
      placement.rotation,
      margin,
      comp.pads.map((p) => ({ localX: p.localX, localY: p.localY, width: p.width, height: p.height })),
    )

    if (placement.frozen) {
      setBodyType(outer, "static")
    }
  }

  // Build connection pair weights
  const pairWeights = new Map<string, number>()
  const pairPads = new Map<string, Array<{ compA: string; padA: any; compB: string; padB: any }>>()

  for (const conn of connections) {
    if (conn.endpoints.length < 2) continue
    for (let i = 0; i < conn.endpoints.length; i++) {
      for (let j = i + 1; j < conn.endpoints.length; j++) {
        const epA = conn.endpoints[i]
        const epB = conn.endpoints[j]
        if (epA.componentId === epB.componentId) continue

        const key = [epA.componentId, epB.componentId].sort().join(":")
        pairWeights.set(key, (pairWeights.get(key) || 0) + 1)

        const arr = pairPads.get(key) || []
        const compA = components.get(epA.componentId)
        const compB = components.get(epB.componentId)
        if (compA && compB) {
          const padA = compA.pads.find((p) => p.id === epA.padId)
          const padB = compB.pads.find((p) => p.id === epB.padId)
          if (padA && padB) {
            arr.push({ compA: epA.componentId, padA, compB: epB.componentId, padB })
          }
        }
        pairPads.set(key, arr)
      }
    }
  }

  // Distance joints connect INNER bodies (so pad offsets create rotation torque)
  // Target length = footprint sizes only (no margin)
  for (const [key, weight] of pairWeights) {
    const [compIdA, compIdB] = key.split(":")
    const innerA = getInnerBodyId(compIdA)
    const innerB = getInnerBodyId(compIdB)
    if (!innerA || !innerB) continue

    const pads = pairPads.get(key) || []
    if (pads.length === 0) continue

    const firstPad = pads[0]
    const hertz = Math.min(0.3 + weight * 0.15, 2.0)

    const compA = components.get(compIdA)!
    const compB = components.get(compIdB)!
    const targetLength = (Math.max(compA.width, compA.height) + Math.max(compB.width, compB.height)) / 2

    const jid = createDistanceJoint(
      innerA,
      innerB,
      firstPad.padA.localX,
      firstPad.padA.localY,
      firstPad.padB.localX,
      firstPad.padB.localY,
      targetLength,
      hertz,
      0.7,
    )
    connectionJointIds.push({ jointId: jid, hertz })
  }

  springForcesActive = true
  simState = { initialized: true, running: true }
  console.log(`[placement] init: ${components.size} components, ${connectionJointIds.length} joints, margin=${margin}mm`)
}

export function stepPlacementSim(
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
  boardWidth: number,
  boardHeight: number,
  freeRotationEnabled = false,
  applySpringForces = true,
): Map<string, Partial<PlacementState>> | null {
  if (!simState.initialized || !simState.running) return null

  // Toggle connection spring joints when Physics checkbox changes
  if (applySpringForces !== springForcesActive) {
    const box2d = getBox2D()
    if (box2d) {
      for (const { jointId, hertz } of connectionJointIds) {
        box2d.b2DistanceJoint_SetSpringHertz(jointId, applySpringForces ? hertz : 0)
      }
    }
    springForcesActive = applySpringForces
  }

  // Central attraction (only when "Physics" checkbox is on)
  if (applySpringForces) {
    for (const [id] of components) {
      const placement = placements.get(id)
      if (!placement || placement.frozen) continue

      const outerId = getOuterBodyId(id)
      if (!outerId) continue

      const pos = getBodyPosition(outerId)
      applyForceToCenter(outerId, -pos.x * 0.2, -pos.y * 0.2)
    }
  }

  // Apply mouse drag force at the contact point (creates torque when off-center)
  applyMouseDragForce()

  stepWorld(1 / 60, 4)

  // Read back: position from outer body, rotation from inner body
  const updates = new Map<string, Partial<PlacementState>>()
  for (const [id] of components) {
    const placement = placements.get(id)
    if (!placement || placement.frozen) continue

    const outerId = getOuterBodyId(id)
    const innerId = getInnerBodyId(id)
    if (!outerId || !innerId) continue

    const pos = getBodyPosition(outerId)

    const dx = pos.x - placement.x
    const dy = pos.y - placement.y

    if (freeRotationEnabled) {
      const rot = getBodyRotation(innerId)
      const dr = Math.abs(rot - placement.rotation)
      if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001 || dr > 0.1) {
        updates.set(id, { x: pos.x, y: pos.y, rotation: rot })
      }
    } else {
      if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
        updates.set(id, { x: pos.x, y: pos.y })
      }
    }
  }

  return updates.size > 0 ? updates : null
}

// --- Drag: spring joint from kinematic anchor to contact point ---

export function startDrag(componentId: string, worldX: number, worldY: number) {
  startMouseDrag(componentId, worldX, worldY)
}

export function updateDrag(componentId: string, targetX: number, targetY: number) {
  updateMouseDrag(targetX, targetY)
}

export function endDrag(componentId: string) {
  endMouseDrag()
}

/** Teleport all Box2D bodies to match current store placements. */
export function syncBodiesToPlacements(
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
) {
  for (const [id] of components) {
    const placement = placements.get(id)
    if (!placement) continue

    const outerId = getOuterBodyId(id)
    const innerId = getInnerBodyId(id)
    if (!outerId || !innerId) continue

    // Teleport outer body (margin collider) — no rotation
    setBodyTransform(outerId, placement.x, placement.y, 0)
    setBodyLinearVelocity(outerId, 0, 0)

    // Teleport inner body (footprint) — with rotation
    setBodyTransform(innerId, placement.x, placement.y, placement.rotation)
    setBodyLinearVelocity(innerId, 0, 0)
  }
}

export function setComponentRotation(componentId: string, rotationDeg: number) {
  // Set rotation on the INNER body (the footprint)
  const innerId = getInnerBodyId(componentId)
  if (!innerId) return
  const pos = getBodyPosition(innerId)
  setBodyTransform(innerId, pos.x, pos.y, rotationDeg)
}

export function setComponentFrozen(componentId: string, frozen: boolean) {
  const outerId = getOuterBodyId(componentId)
  if (!outerId) return
  setBodyType(outerId, frozen ? "static" : "dynamic")
}

export async function reinitWithMargin(
  boardWidth: number,
  boardHeight: number,
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
  connections: ConnectionData[],
  margin: number,
) {
  simState = { initialized: false, running: false }
  await initPlacementSim(boardWidth, boardHeight, components, placements, connections, margin)
}

export function isSimRunning() {
  return simState.running
}

export function pauseSim() {
  simState.running = false
}

export function resumeSim() {
  simState.running = true
}
