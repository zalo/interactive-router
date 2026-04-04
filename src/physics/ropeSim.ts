/**
 * Trace-as-rope physics simulation.
 * Tessellates routed traces into chains of small Box2D bodies
 * connected by distance joints. Endpoints are attached to their
 * component bodies. Rope segments have capsule-like collision shapes.
 *
 * When enabled, traces flex physically when components are dragged,
 * providing a tangible feel for routing tension.
 */

import type { RoutedTrace, Point, ComponentData, PlacementState, ConnectionData } from "../types"
import {
  getBox2D,
  getWorldId,
  getOuterBodyId,
} from "./box2dManager"

const SEGMENT_LENGTH = 0.3  // mm between rope nodes (fine tessellation)
const ROPE_RADIUS = 0.4     // mm — wider collision for trace clearance
const ROPE_DENSITY = 0.2
const ROPE_HERTZ = 4.0      // joint stiffness
const ROPE_DAMPING = 0.8

// Collision category for rope segments (separate from components)
const CAT_ROPE = 0x0008
const CAT_MARGIN = 0x0001
const CAT_PAD = 0x0010
const CAT_WALL = 0x0004

interface RopeBody {
  bodyId: any
  x: number
  y: number
}

interface RopeChain {
  connectionId: string
  bodies: RopeBody[]
  joints: any[]
  endpointJoints: any[] // joints connecting to component bodies
}

let ropeChains: RopeChain[] = []
let initialized = false

export function isRopeSimActive(): boolean {
  return initialized && ropeChains.length > 0
}

/**
 * Create rope bodies for all routed traces.
 */
export function createRopes(
  routedTraces: Map<string, RoutedTrace>,
  connections: ConnectionData[],
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
) {
  destroyRopes()

  const box2d = getBox2D()
  const worldId = getWorldId()
  if (!box2d || !worldId) return

  for (const [connId, trace] of routedTraces) {
    // Collect all points in the trace
    const allPoints: Point[] = []
    for (const seg of trace.segments) {
      for (const p of seg.points) {
        if (allPoints.length === 0 || distance(allPoints[allPoints.length - 1]!, p) > 0.01) {
          allPoints.push(p)
        }
      }
    }
    if (allPoints.length < 2) continue

    // Tessellate into evenly spaced points
    const tessellated = tessellate(allPoints, SEGMENT_LENGTH)
    if (tessellated.length < 2) continue

    const chain: RopeChain = {
      connectionId: connId,
      bodies: [],
      joints: [],
      endpointJoints: [],
    }

    // Create a small dynamic body at each tessellation point
    for (const pt of tessellated) {
      const bodyDef = box2d.b2DefaultBodyDef()
      bodyDef.type = box2d.b2BodyType.b2_dynamicBody
      bodyDef.position.Set(pt.x, pt.y)
      bodyDef.linearDamping = 2.0
      bodyDef.angularDamping = 5.0
      bodyDef.isAwake = true

      const bodyId = box2d.b2CreateBody(worldId, bodyDef)

      // Lock rotation on rope segments
      const locks = new box2d.b2MotionLocks()
      locks.angularZ = true
      box2d.b2Body_SetMotionLocks(bodyId, locks)
      locks.delete()

      // Circle shape for collision
      const shapeDef = box2d.b2DefaultShapeDef()
      shapeDef.density = ROPE_DENSITY
      shapeDef.material.friction = 0.1
      shapeDef.material.restitution = 0.0
      // Ropes collide with individual pads, walls, and other ropes
      shapeDef.filter.categoryBits = CAT_ROPE
      shapeDef.filter.maskBits = CAT_PAD | CAT_WALL | CAT_ROPE

      const circle = new box2d.b2Circle()
      circle.center.Set(0, 0)
      circle.radius = ROPE_RADIUS
      box2d.b2CreateCircleShape(bodyId, shapeDef, circle)
      circle.delete()

      chain.bodies.push({ bodyId, x: pt.x, y: pt.y })
    }

    // Connect adjacent rope bodies with distance joints
    for (let i = 0; i < chain.bodies.length - 1; i++) {
      const a = chain.bodies[i]!
      const b = chain.bodies[i + 1]!
      const dist = distance(a, b)

      const jointDef = box2d.b2DefaultDistanceJointDef()
      jointDef.base.bodyIdA = a.bodyId
      jointDef.base.bodyIdB = b.bodyId
      jointDef.base.collideConnected = false
      jointDef.length = dist * 0.95
      jointDef.enableSpring = true
      jointDef.hertz = ROPE_HERTZ
      jointDef.dampingRatio = ROPE_DAMPING
      jointDef.minLength = 0
      jointDef.maxLength = dist * 3

      const jid = box2d.b2CreateDistanceJoint(worldId, jointDef)
      chain.joints.push(jid)
    }

    // Skip constraints (connect every 2nd and 3rd body) for stability.
    // Prevents the rope from folding in on itself and oscillating.
    for (const skip of [2, 3]) {
      for (let i = 0; i < chain.bodies.length - skip; i++) {
        const a = chain.bodies[i]!
        const b = chain.bodies[i + skip]!
        const dist = distance(a, b)

        const jointDef = box2d.b2DefaultDistanceJointDef()
        jointDef.base.bodyIdA = a.bodyId
        jointDef.base.bodyIdB = b.bodyId
        jointDef.base.collideConnected = false
        jointDef.length = dist * 0.95
        jointDef.enableSpring = true
        jointDef.hertz = ROPE_HERTZ * 0.5 // softer than primary links
        jointDef.dampingRatio = ROPE_DAMPING
        jointDef.minLength = 0
        jointDef.maxLength = dist * 4

        const jid = box2d.b2CreateDistanceJoint(worldId, jointDef)
        chain.joints.push(jid)
      }
    }

    // Make first and last rope bodies kinematic — they'll be teleported
    // to their pad world positions each frame by updateRopeEndpoints().
    const conn = connections.find((c) => c.id === connId)
    if (conn && conn.endpoints.length >= 2) {
      const first = chain.bodies[0]!
      const last = chain.bodies[chain.bodies.length - 1]!
      box2d.b2Body_SetType(first.bodyId, box2d.b2BodyType.b2_kinematicBody)
      box2d.b2Body_SetType(last.bodyId, box2d.b2BodyType.b2_kinematicBody)
    }

    ropeChains.push(chain)
  }

  initialized = true
}

/**
 * Teleport rope endpoints to their pad world positions.
 * Called each frame before stepWorld() so ropes track component movement.
 */
export function updateRopeEndpoints(
  connections: ConnectionData[],
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
) {
  const box2d = getBox2D()
  if (!box2d) return

  for (const chain of ropeChains) {
    const conn = connections.find((c) => c.id === chain.connectionId)
    if (!conn || conn.endpoints.length < 2) continue

    const ep1 = conn.endpoints[0]!
    const ep2 = conn.endpoints[conn.endpoints.length - 1]!

    const teleportTo = (ropeBody: RopeBody, ep: any) => {
      const comp = components.get(ep.componentId)
      const pl = placements.get(ep.componentId)
      if (!comp || !pl) return
      const pad = comp.pads.find((p: any) => p.id === ep.padId)
      if (!pad) return

      const rad = (pl.rotation * Math.PI) / 180
      const wx = pl.x + pad.localX * Math.cos(rad) - pad.localY * Math.sin(rad)
      const wy = pl.y + pad.localX * Math.sin(rad) + pad.localY * Math.cos(rad)

      const pos = new box2d.b2Vec2(wx, wy)
      const rot = new box2d.b2Rot()
      rot.SetAngle(0)
      box2d.b2Body_SetTransform(ropeBody.bodyId, pos, rot)
      pos.delete()
      rot.delete()
    }

    if (chain.bodies.length >= 2) {
      teleportTo(chain.bodies[0]!, ep1)
      teleportTo(chain.bodies[chain.bodies.length - 1]!, ep2)
    }
  }
}

/**
 * Read back rope body positions and return updated traces.
 */
export function readRopePositions(): Map<string, Point[]> {
  const box2d = getBox2D()
  if (!box2d) return new Map()

  const result = new Map<string, Point[]>()
  for (const chain of ropeChains) {
    const points: Point[] = []
    for (const rb of chain.bodies) {
      const pos = box2d.b2Body_GetPosition(rb.bodyId)
      points.push({ x: pos.x, y: pos.y })
    }
    result.set(chain.connectionId, points)
  }
  return result
}

/**
 * Destroy all rope bodies and joints.
 */
export function destroyRopes() {
  const box2d = getBox2D()
  const worldId = getWorldId()
  if (!box2d || !worldId) {
    ropeChains = []
    initialized = false
    return
  }

  for (const chain of ropeChains) {
    for (const jid of chain.joints) {
      try { box2d.b2DestroyJoint(jid, true) } catch {}
    }
    for (const jid of chain.endpointJoints) {
      try { box2d.b2DestroyJoint(jid, true) } catch {}
    }
    for (const rb of chain.bodies) {
      try { box2d.b2DestroyBody(rb.bodyId) } catch {}
    }
  }

  ropeChains = []
  initialized = false
}

// Helpers

function distance(a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  return Math.sqrt(dx * dx + dy * dy)
}

function tessellate(points: Point[], maxSegLength: number): Point[] {
  if (points.length < 2) return [...points]

  const result: Point[] = [points[0]!]
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!
    const curr = points[i]!
    const d = distance(prev, curr)
    const numSegs = Math.max(1, Math.ceil(d / maxSegLength))
    for (let s = 1; s <= numSegs; s++) {
      const t = s / numSegs
      result.push({
        x: prev.x + (curr.x - prev.x) * t,
        y: prev.y + (curr.y - prev.y) * t,
      })
    }
  }
  return result
}
