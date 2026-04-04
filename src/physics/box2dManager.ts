/**
 * Box2D v3 WASM manager.
 * Coordinates: 1 unit = 1 mm (matching PCB coordinates).
 *
 * Two-body architecture per component:
 *   - "outer" body: margin collider, rotation-locked, handles collision
 *   - "inner" body: footprint, freely rotates, no collision shape
 *   - revolute joint pins inner to outer center
 * Distance joints attach to inner bodies so pad positions create torque.
 */

let box2d: any = null
let worldId: any = null

// Per-component body pairs
const outerBodies = new Map<string, any>() // componentId -> outer b2BodyId (collision)
const innerBodies = new Map<string, any>() // componentId -> inner b2BodyId (rotation)
const padBodiesMap = new Map<string, any[]>() // componentId -> array of kinematic pad bodies
const joints: any[] = []

export async function initBox2D(): Promise<void> {
  if (box2d) return
  const Box2DFactory = (await import("box2d3-wasm")).default
  box2d = await Box2DFactory()
}

export function getBox2D() {
  return box2d
}

export function createWorld(gravityX = 0, gravityY = 0) {
  if (!box2d) throw new Error("Box2D not initialized")
  if (worldId) destroyWorld()

  const worldDef = box2d.b2DefaultWorldDef()
  worldDef.gravity.Set(gravityX, gravityY)
  worldDef.enableSleep = false
  worldDef.enableContinuous = false // user requested: disable CCD
  worldId = box2d.b2CreateWorld(worldDef)
  return worldId
}

export function destroyWorld() {
  if (!worldId) return
  outerBodies.clear()
  innerBodies.clear()
  padBodiesMap.clear()
  joints.length = 0
  box2d.b2DestroyWorld(worldId)
  worldId = null
}

export function stepWorld(dt = 1 / 60, subSteps = 4) {
  if (!worldId) return
  box2d.b2World_Step(worldId, dt, subSteps)
}

export function createStaticBody(x: number, y: number): any {
  const bodyDef = box2d.b2DefaultBodyDef()
  bodyDef.type = box2d.b2BodyType.b2_staticBody
  bodyDef.position.Set(x, y)
  return box2d.b2CreateBody(worldId, bodyDef)
}

// Collision filter categories
const CAT_MARGIN    = 0x0001  // margin collider layer
const CAT_FOOTPRINT = 0x0002  // footprint collision layer
const CAT_WALL      = 0x0004  // board boundary walls
const CAT_PAD       = 0x0010  // individual pad shapes (for rope collision)
const CAT_ROPE      = 0x0008  // rope segment bodies

/**
 * Create a two-body component:
 *   outer = margin collider (rotation-locked, collides with other margins + walls)
 *   inner = footprint (free rotation, collides with other footprints + walls)
 *   revolute joint pins them at center
 *
 * Collision filtering keeps the two layers independent:
 *   margin <-> margin, footprint <-> footprint, both <-> walls
 */
export function createComponentBodies(
  componentId: string,
  x: number,
  y: number,
  halfW: number,
  halfH: number,
  rotation: number,
  margin: number,
  pads?: Array<{ localX: number; localY: number; width: number; height: number }>,
): { outer: any; inner: any } {
  // --- Outer body: margin collider, no rotation ---
  const outerDef = box2d.b2DefaultBodyDef()
  outerDef.type = box2d.b2BodyType.b2_dynamicBody
  outerDef.position.Set(x, y)
  outerDef.linearDamping = 1.0
  outerDef.angularDamping = 100.0
  outerDef.isAwake = true
  const outerId = box2d.b2CreateBody(worldId, outerDef)

  // Lock outer body rotation (margin box stays axis-aligned)
  const locks = new box2d.b2MotionLocks()
  locks.linearX = false
  locks.linearY = false
  locks.angularZ = true
  box2d.b2Body_SetMotionLocks(outerId, locks)
  locks.delete()

  // Margin collision shape — collides only with other margin shapes + walls
  const marginShapeDef = box2d.b2DefaultShapeDef()
  marginShapeDef.material.friction = 0.3
  marginShapeDef.material.restitution = 0.3
  marginShapeDef.density = 0.5
  marginShapeDef.filter.categoryBits = CAT_MARGIN
  marginShapeDef.filter.maskBits = CAT_MARGIN | CAT_WALL
  const marginPoly = box2d.b2MakeBox(halfW + margin, halfH + margin)
  box2d.b2CreatePolygonShape(outerId, marginShapeDef, marginPoly)

  // Per-pad collision shapes for rope interaction.
  // Each pad gets its own small static body at its world position.
  // Stored in padBodies map for cleanup.
  if (pads) {
    const padBodyIds: any[] = []
    for (const pad of pads) {
      // Compute pad world position
      const padWorldX = x + pad.localX
      const padWorldY = y + pad.localY

      const padBodyDef = box2d.b2DefaultBodyDef()
      padBodyDef.type = box2d.b2BodyType.b2_kinematicBody // kinematic so we can move them
      padBodyDef.position.Set(padWorldX, padWorldY)
      const padBodyId = box2d.b2CreateBody(worldId, padBodyDef)

      const padShapeDef = box2d.b2DefaultShapeDef()
      padShapeDef.density = 0.01
      padShapeDef.material.friction = 0.1
      padShapeDef.material.restitution = 0.1
      padShapeDef.filter.categoryBits = CAT_PAD
      padShapeDef.filter.maskBits = CAT_ROPE

      const hw = Math.max(pad.width / 2, 0.08)
      const hh = Math.max(pad.height / 2, 0.08)
      const padPoly = box2d.b2MakeBox(hw, hh)
      box2d.b2CreatePolygonShape(padBodyId, padShapeDef, padPoly)

      padBodyIds.push(padBodyId)
    }
    padBodiesMap.set(componentId, padBodyIds)
  }

  // --- Inner body: freely rotates, real footprint collision ---
  const innerDef = box2d.b2DefaultBodyDef()
  innerDef.type = box2d.b2BodyType.b2_dynamicBody
  innerDef.position.Set(x, y)
  innerDef.rotation.SetAngle((rotation * Math.PI) / 180)
  innerDef.linearDamping = 1.0
  innerDef.angularDamping = 3.0
  innerDef.isAwake = true
  const innerId = box2d.b2CreateBody(worldId, innerDef)

  // Footprint collision shape — collides only with other footprints + walls
  const footprintShapeDef = box2d.b2DefaultShapeDef()
  footprintShapeDef.material.friction = 0.3
  footprintShapeDef.material.restitution = 0.3
  footprintShapeDef.density = 1.0
  footprintShapeDef.filter.categoryBits = CAT_FOOTPRINT
  footprintShapeDef.filter.maskBits = CAT_FOOTPRINT | CAT_WALL // no rope collision on full footprint
  const footprintPoly = box2d.b2MakeBox(halfW, halfH)
  box2d.b2CreatePolygonShape(innerId, footprintShapeDef, footprintPoly)

  // --- Revolute joint: pins inner to outer center, free rotation ---
  const revDef = box2d.b2DefaultRevoluteJointDef()
  revDef.base.bodyIdA = outerId
  revDef.base.bodyIdB = innerId
  revDef.base.collideConnected = false // same component, don't collide with self
  // localFrameA/B default to origin, which is what we want (pin at center)
  revDef.enableLimit = false
  revDef.enableMotor = false
  revDef.enableSpring = false
  const revJoint = box2d.b2CreateRevoluteJoint(worldId, revDef)
  joints.push(revJoint)

  outerBodies.set(componentId, outerId)
  innerBodies.set(componentId, innerId)

  return { outer: outerId, inner: innerId }
}

export function createWallSegment(x1: number, y1: number, x2: number, y2: number) {
  const bodyId = createStaticBody(0, 0)
  const shapeDef = box2d.b2DefaultShapeDef()
  shapeDef.material.friction = 0.5
  shapeDef.material.restitution = 0.3
  // Walls collide with everything
  shapeDef.filter.categoryBits = CAT_WALL
  shapeDef.filter.maskBits = CAT_MARGIN | CAT_FOOTPRINT | CAT_WALL
  const seg = new box2d.b2Segment()
  seg.point1.Set(x1, y1)
  seg.point2.Set(x2, y2)
  box2d.b2CreateSegmentShape(bodyId, shapeDef, seg)
  seg.delete()
  return bodyId
}

export function createDistanceJoint(
  bodyIdA: any,
  bodyIdB: any,
  localAnchorAx: number,
  localAnchorAy: number,
  localAnchorBx: number,
  localAnchorBy: number,
  targetLength: number,
  hertz = 0.5,
  dampingRatio = 0.7,
) {
  const jointDef = box2d.b2DefaultDistanceJointDef()
  jointDef.base.bodyIdA = bodyIdA
  jointDef.base.bodyIdB = bodyIdB
  jointDef.base.collideConnected = true

  // .p.Set() may not persist in WASM bindings (returns copy of embedded struct).
  // Set .x/.y directly on the property accessor instead.
  jointDef.base.localFrameA.p.x = localAnchorAx
  jointDef.base.localFrameA.p.y = localAnchorAy
  jointDef.base.localFrameB.p.x = localAnchorBx
  jointDef.base.localFrameB.p.y = localAnchorBy

  jointDef.length = targetLength
  jointDef.enableSpring = true
  jointDef.hertz = hertz
  jointDef.dampingRatio = dampingRatio
  jointDef.minLength = 0
  jointDef.maxLength = targetLength * 5

  // Verify anchors were set (debug)
  const checkA = jointDef.base.localFrameA.p
  const checkB = jointDef.base.localFrameB.p
  if (Math.abs(localAnchorAx) > 0.1 || Math.abs(localAnchorBx) > 0.1) {
    console.log(`[joint] anchorA=(${checkA.x.toFixed(2)},${checkA.y.toFixed(2)}) anchorB=(${checkB.x.toFixed(2)},${checkB.y.toFixed(2)}) requested A=(${localAnchorAx.toFixed(2)},${localAnchorAy.toFixed(2)}) B=(${localAnchorBx.toFixed(2)},${localAnchorBy.toFixed(2)})`)
  }

  const jid = box2d.b2CreateDistanceJoint(worldId, jointDef)
  joints.push(jid)
  return jid
}

export function getBodyPosition(bodyId: any): { x: number; y: number } {
  const pos = box2d.b2Body_GetPosition(bodyId)
  return { x: pos.x, y: pos.y }
}

export function getBodyRotation(bodyId: any): number {
  const rot = box2d.b2Body_GetRotation(bodyId)
  return Math.atan2(rot.s, rot.c) * (180 / Math.PI)
}

export function setBodyTransform(bodyId: any, x: number, y: number, angleDeg: number) {
  const pos = new box2d.b2Vec2(x, y)
  const rot = new box2d.b2Rot()
  rot.SetAngle((angleDeg * Math.PI) / 180)
  box2d.b2Body_SetTransform(bodyId, pos, rot)
  pos.delete()
  rot.delete()
}

export function setBodyType(bodyId: any, type: "static" | "dynamic" | "kinematic") {
  const typeMap: Record<string, any> = {
    static: box2d.b2BodyType.b2_staticBody,
    dynamic: box2d.b2BodyType.b2_dynamicBody,
    kinematic: box2d.b2BodyType.b2_kinematicBody,
  }
  box2d.b2Body_SetType(bodyId, typeMap[type])
}

export function setBodyLinearVelocity(bodyId: any, vx: number, vy: number) {
  const vel = new box2d.b2Vec2(vx, vy)
  box2d.b2Body_SetLinearVelocity(bodyId, vel)
  vel.delete()
}

export function applyForceToCenter(bodyId: any, fx: number, fy: number) {
  const force = new box2d.b2Vec2(fx, fy)
  box2d.b2Body_ApplyForceToCenter(bodyId, force, true)
  force.delete()
}

// --- Mouse drag: per-frame force at contact point ---
// No joints needed — we compute a spring force each frame and apply
// it at the world-space grab point, which creates both translation and torque.

let dragTargetComponentId: string | null = null
let dragLocalX = 0  // grab offset in footprint body-local coords
let dragLocalY = 0
let dragPointerX = 0 // current pointer world position
let dragPointerY = 0

const DRAG_STIFFNESS = 2000.0  // spring constant (N/mm) — very stiff for snappy drag
const DRAG_DAMPING = 160.0     // velocity damping — prevents oscillation

/**
 * Start dragging a component at a world-space contact point.
 * Records the local-space grab offset on the footprint body.
 */
export function startMouseDrag(componentId: string, worldX: number, worldY: number) {
  const innerId = innerBodies.get(componentId)
  if (!innerId) return

  dragTargetComponentId = componentId
  dragPointerX = worldX
  dragPointerY = worldY

  // Compute local contact point on the footprint body
  const pos = box2d.b2Body_GetPosition(innerId)
  const rot = box2d.b2Body_GetRotation(innerId)
  const dx = worldX - pos.x
  const dy = worldY - pos.y
  dragLocalX = dx * rot.c + dy * rot.s
  dragLocalY = -dx * rot.s + dy * rot.c
}

/** Move the drag target to a new pointer position. */
export function updateMouseDrag(worldX: number, worldY: number) {
  dragPointerX = worldX
  dragPointerY = worldY
}

/**
 * Apply drag spring force. Called each frame before stepWorld().
 * Computes the world-space grab point from the body's current transform,
 * then applies a spring force from grab point toward pointer.
 * Since the force is applied at an off-center point, it creates torque.
 */
export function applyMouseDragForce() {
  if (!dragTargetComponentId) return

  const innerId = innerBodies.get(dragTargetComponentId)
  if (!innerId) return

  // Current world-space position of the grab point
  const pos = box2d.b2Body_GetPosition(innerId)
  const rot = box2d.b2Body_GetRotation(innerId)
  const grabWorldX = pos.x + dragLocalX * rot.c - dragLocalY * rot.s
  const grabWorldY = pos.y + dragLocalX * rot.s + dragLocalY * rot.c

  // Spring force: pull grab point toward pointer
  const dx = dragPointerX - grabWorldX
  const dy = dragPointerY - grabWorldY

  const fx = dx * DRAG_STIFFNESS
  const fy = dy * DRAG_STIFFNESS

  // Apply force at the grab point (creates torque when off-center)
  const forceVec = new box2d.b2Vec2(fx, fy)
  const pointVec = new box2d.b2Vec2(grabWorldX, grabWorldY)
  box2d.b2Body_ApplyForce(innerId, forceVec, pointVec, true)
  forceVec.delete()
  pointVec.delete()

  // Also apply damping force at center to prevent oscillation
  const vel = box2d.b2Body_GetLinearVelocity(innerId)
  const dampForce = new box2d.b2Vec2(-vel.x * DRAG_DAMPING, -vel.y * DRAG_DAMPING)
  box2d.b2Body_ApplyForceToCenter(innerId, dampForce, true)
  dampForce.delete()

  // Also apply force to the OUTER body to keep it tracking the pointer.
  // The revolute joint transfers force, but adding direct force to the outer
  // body makes the collision-body follow more responsively.
  const outerId = outerBodies.get(dragTargetComponentId)
  if (outerId) {
    const outerPos = box2d.b2Body_GetPosition(outerId)
    const outerFx = (dragPointerX - outerPos.x) * DRAG_STIFFNESS * 0.5
    const outerFy = (dragPointerY - outerPos.y) * DRAG_STIFFNESS * 0.5
    const outerForce = new box2d.b2Vec2(outerFx, outerFy)
    box2d.b2Body_ApplyForceToCenter(outerId, outerForce, true)
    outerForce.delete()

    const outerVel = box2d.b2Body_GetLinearVelocity(outerId)
    const outerDamp = new box2d.b2Vec2(-outerVel.x * DRAG_DAMPING, -outerVel.y * DRAG_DAMPING)
    box2d.b2Body_ApplyForceToCenter(outerId, outerDamp, true)
    outerDamp.delete()
  }
}

/** End dragging. */
export function endMouseDrag() {
  dragTargetComponentId = null
}

export function getDragTargetComponentId(): string | null {
  return dragTargetComponentId
}

/**
 * Update kinematic pad body positions to match component placements.
 * Called each frame so pad collision shapes track component movement.
 */
export function syncPadBodies(
  components: Map<string, { pads: Array<{ localX: number; localY: number }> }>,
  placements: Map<string, { x: number; y: number; rotation: number }>,
) {
  if (!box2d) return
  for (const [compId, padBodyIds] of padBodiesMap) {
    const comp = components.get(compId)
    const pl = placements.get(compId)
    if (!comp || !pl) continue

    const rad = (pl.rotation * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)

    for (let i = 0; i < Math.min(padBodyIds.length, comp.pads.length); i++) {
      const pad = comp.pads[i]!
      const wx = pl.x + pad.localX * cos - pad.localY * sin
      const wy = pl.y + pad.localX * sin + pad.localY * cos

      const pos = new box2d.b2Vec2(wx, wy)
      const rot = new box2d.b2Rot()
      rot.SetAngle(0)
      box2d.b2Body_SetTransform(padBodyIds[i], pos, rot)
      pos.delete()
      rot.delete()
    }
  }
}

export function getOuterBodyId(componentId: string): any | undefined {
  return outerBodies.get(componentId)
}

export function getInnerBodyId(componentId: string): any | undefined {
  return innerBodies.get(componentId)
}

// Legacy compat
export function getBodyId(componentId: string): any | undefined {
  return outerBodies.get(componentId)
}

export function getWorldId() {
  return worldId
}
