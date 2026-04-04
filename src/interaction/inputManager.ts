import { useAppStore, getWorldPadPosition } from "../state/store"
import { screenToWorld, type CanvasContext } from "../canvas/renderer"
import {
  type CameraState,
  handleWheelZoom,
  handlePanStart,
  handlePanMove,
  handlePanEnd,
  handlePinchUpdate,
} from "./camera"
import { handleRoutingPointerDown, handleRoutingPointerMove } from "./routingHandlers"
import type { Point, ComponentData, PlacementState } from "../types"
import { livePreviewRef } from "../types"

export interface InputState {
  camera: CameraState
  longPressTimer: number | null
  longPressTriggered: boolean
  canvasRect: DOMRect | null
  // Pending tap for touch — deferred to distinguish from pinch-zoom
  pendingTap: {
    worldPos: Point
    pointerId: number
    startTime: number
    startScreenX: number
    startScreenY: number
  } | null
  pendingTapTimer: number | null
}

function hitTestComponent(
  worldPoint: Point,
  components: Map<string, ComponentData>,
  placements: Map<string, PlacementState>,
): string | null {
  // Test in reverse order (top-most first)
  const entries = Array.from(components.entries()).reverse()
  for (const [id, comp] of entries) {
    const placement = placements.get(id)
    if (!placement) continue

    // Transform point into component's local space
    const dx = worldPoint.x - placement.x
    const dy = worldPoint.y - placement.y
    const rad = (-placement.rotation * Math.PI) / 180
    const localX = dx * Math.cos(rad) - dy * Math.sin(rad)
    const localY = dx * Math.sin(rad) + dy * Math.cos(rad)

    if (
      Math.abs(localX) <= comp.width / 2 &&
      Math.abs(localY) <= comp.height / 2
    ) {
      return id
    }
  }
  return null
}

export function setupInputHandlers(
  canvas: HTMLCanvasElement,
  inputState: InputState,
  getCC: () => CanvasContext,
  onPhysicsDrag?: (componentId: string, worldX: number, worldY: number) => void,
  onPhysicsDragEnd?: (componentId: string) => void,
  onPhysicsRotate?: (componentId: string, rotation: number) => void,
): () => void {
  const store = useAppStore.getState
  const { setCamera, setDragState, setHoveredComponent, toggleFrozen, updatePlacement } = useAppStore.getState()

  function getWorldPos(e: PointerEvent | MouseEvent): Point {
    const cc = getCC()
    const rect = canvas.getBoundingClientRect()
    return screenToWorld(cc, e.clientX - rect.left, e.clientY - rect.top)
  }

  function onPointerDown(e: PointerEvent) {
    inputState.canvasRect = canvas.getBoundingClientRect()
    inputState.camera.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

    // Multi-touch: pinch-zoom — cancel any pending tap
    if (inputState.camera.pointers.size >= 2) {
      if (inputState.pendingTap) {
        inputState.pendingTap = null
        if (inputState.pendingTapTimer) { clearTimeout(inputState.pendingTapTimer); inputState.pendingTapTimer = null }
      }
      handlePinchUpdate(inputState.camera, setCamera, inputState.canvasRect!)
      return
    }

    // Middle button: pan
    if (e.button === 1) {
      handlePanStart(e, inputState.camera)
      canvas.setPointerCapture(e.pointerId)
      return
    }

    // Left button: mode-dependent interaction
    if (e.button === 0 || e.button === 2) {
      const s = store()

      // Interactive mode: routing OR dragging depending on click target
      if (s.mode === "interactive") {
        const world = getWorldPos(e)

        // Right-click: delete trace
        if (e.button === 2) {
          handleRoutingPointerDown(world, e.button, getCC)
          return
        }

        // Component drag (works immediately for both mouse and touch)
        const hitId = hitTestComponent(world, s.components, s.placements)
        if (hitId) {
          const placement = s.placements.get(hitId)!
          canvas.setPointerCapture(e.pointerId)
          setDragState({
            componentId: hitId,
            offsetX: world.x - placement.x,
            offsetY: world.y - placement.y,
            pointerId: e.pointerId,
          })

          // Long-press on component in edit mode = delete traces for this component
          inputState.longPressTriggered = false
          inputState.longPressTimer = window.setTimeout(() => {
            inputState.longPressTriggered = true
            // Delete all traces connected to this component
            const st = store()
            const newTraces = new Map(st.routedTraces)
            const newUnrouted = new Set(st.unroutedConnectionIds)
            for (const conn of st.connections) {
              if (conn.endpoints.some((ep: any) => ep.componentId === hitId) && newTraces.has(conn.id)) {
                newTraces.delete(conn.id)
                newUnrouted.add(conn.id)
              }
            }
            st.setRoutedTraces(newTraces, newUnrouted)
          }, 500)
          return
        }

        // No component hit — routing action.
        // On touch, defer to distinguish from pinch-zoom start.
        if (e.pointerType === "touch") {
          inputState.pendingTap = {
            worldPos: world,
            pointerId: e.pointerId,
            startTime: performance.now(),
            startScreenX: e.clientX,
            startScreenY: e.clientY,
          }
          // If no second finger arrives within 150ms, treat as tap
          if (inputState.pendingTapTimer) clearTimeout(inputState.pendingTapTimer)
          inputState.pendingTapTimer = window.setTimeout(() => {
            if (inputState.pendingTap && inputState.camera.pointers.size < 2) {
              handleRoutingPointerDown(inputState.pendingTap.worldPos, 0, getCC)
            }
            inputState.pendingTap = null
            inputState.pendingTapTimer = null
          }, 150)
          return
        }

        // Mouse: act immediately
        handleRoutingPointerDown(world, e.button, getCC)
        return
      }

      if (s.mode !== "placement") return
      if (e.button === 2) return // right-click handled by contextmenu

      const world = getWorldPos(e)
      const hitId = hitTestComponent(world, s.components, s.placements)

      if (hitId) {
        const placement = s.placements.get(hitId)!
        canvas.setPointerCapture(e.pointerId)
        setDragState({
          componentId: hitId,
          offsetX: world.x - placement.x,
          offsetY: world.y - placement.y,
          pointerId: e.pointerId,
        })

        // Start long-press timer for freeze toggle
        inputState.longPressTriggered = false
        inputState.longPressTimer = window.setTimeout(() => {
          inputState.longPressTriggered = true
          toggleFrozen(hitId)
        }, 500)

        // Notify physics of drag start (only if physics enabled)
        const s2 = store()
        if (s2.physicsEnabled) {
          onPhysicsDrag?.(hitId, world.x, world.y)
        }
      }
    }
  }

  function onPointerMove(e: PointerEvent) {
    inputState.camera.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

    // Pinch
    if (inputState.camera.pointers.size >= 2 && inputState.canvasRect) {
      handlePinchUpdate(inputState.camera, setCamera, inputState.canvasRect)
      return
    }

    // Pan
    handlePanMove(e, inputState.camera, setCamera)

    const s = store()

    // Interactive mode: handle drag OR routing preview
    if (s.mode === "interactive") {
      const dragState = s.dragState
      if (dragState.componentId && dragState.pointerId === e.pointerId) {
        // Cancel long-press timer on move (don't delete traces just because we dragged)
        if (inputState.longPressTimer) {
          clearTimeout(inputState.longPressTimer)
          inputState.longPressTimer = null
        }
        // Dragging a component in interactive mode — direct position update
        const world = getWorldPos(e)
        const newX = world.x - dragState.offsetX
        const newY = world.y - dragState.offsetY
        updatePlacement(dragState.componentId, { x: newX, y: newY })
      } else {
        // Not dragging — update live routing preview
        const world = getWorldPos(e)
        livePreviewRef.path = handleRoutingPointerMove(world)
      }
      return
    }

    if (s.mode !== "placement") return

    // Drag
    const dragState = s.dragState
    if (dragState.componentId && dragState.pointerId === e.pointerId) {
      // Cancel long-press if moved enough
      if (inputState.longPressTimer) {
        clearTimeout(inputState.longPressTimer)
        inputState.longPressTimer = null
      }

      const world = getWorldPos(e)

      // If physics is enabled, update the drag force target.
      // If physics is off, directly update the store position.
      const s2 = store()
      if (s2.physicsEnabled) {
        onPhysicsDrag?.(dragState.componentId, world.x, world.y)
      } else {
        const newX = world.x - dragState.offsetX
        const newY = world.y - dragState.offsetY
        updatePlacement(dragState.componentId, { x: newX, y: newY })
      }
    } else {
      // Hover detection
      const world = getWorldPos(e)
      const hitId = hitTestComponent(world, s.components, s.placements)
      if (hitId !== s.hoveredComponentId) {
        setHoveredComponent(hitId)
      }
    }
  }

  function onPointerUp(e: PointerEvent) {
    inputState.camera.pointers.delete(e.pointerId)

    if (inputState.camera.pointers.size < 2) {
      inputState.camera.lastPinchDist = null
      inputState.camera.lastPinchCenter = null
    }

    handlePanEnd(e, inputState.camera)

    // Clear long-press
    if (inputState.longPressTimer) {
      clearTimeout(inputState.longPressTimer)
      inputState.longPressTimer = null
    }

    const s = store()
    if (s.dragState.componentId && s.dragState.pointerId === e.pointerId) {
      onPhysicsDragEnd?.(s.dragState.componentId)
      setDragState({ componentId: null, offsetX: 0, offsetY: 0, pointerId: null })
    }

    canvas.releasePointerCapture(e.pointerId)
  }

  function onWheel(e: WheelEvent) {
    const s = store()

    // If dragging, scroll wheel rotates component
    if (s.dragState.componentId) {
      e.preventDefault()
      const comp = s.placements.get(s.dragState.componentId)
      if (comp) {
        const delta = e.deltaY > 0 ? -45 : 45
        const newRotation = ((comp.rotation + delta) % 360 + 360) % 360
        updatePlacement(s.dragState.componentId, { rotation: newRotation })
        onPhysicsRotate?.(s.dragState.componentId, newRotation)
      }
      return
    }

    // Otherwise zoom
    handleWheelZoom(e, inputState.camera, setCamera)
  }

  function onContextMenu(e: MouseEvent) {
    e.preventDefault()
    const s = store()
    if (s.mode !== "placement") return

    const world = getWorldPos(e as any)
    const hitId = hitTestComponent(world, s.components, s.placements)
    if (hitId) {
      toggleFrozen(hitId)
    }
  }

  canvas.addEventListener("pointerdown", onPointerDown)
  canvas.addEventListener("pointermove", onPointerMove)
  canvas.addEventListener("pointerup", onPointerUp)
  canvas.addEventListener("pointercancel", onPointerUp)
  canvas.addEventListener("wheel", onWheel, { passive: false })
  canvas.addEventListener("contextmenu", onContextMenu)

  // Prevent default touch behaviors (scroll, zoom)
  canvas.style.touchAction = "none"

  return () => {
    canvas.removeEventListener("pointerdown", onPointerDown)
    canvas.removeEventListener("pointermove", onPointerMove)
    canvas.removeEventListener("pointerup", onPointerUp)
    canvas.removeEventListener("pointercancel", onPointerUp)
    canvas.removeEventListener("wheel", onWheel)
    canvas.removeEventListener("contextmenu", onContextMenu)
  }
}
