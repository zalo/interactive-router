import { useAppStore } from "../state/store"
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
  const entries = Array.from(components.entries()).reverse()
  for (const [id, comp] of entries) {
    const placement = placements.get(id)
    if (!placement) continue
    const dx = worldPoint.x - placement.x
    const dy = worldPoint.y - placement.y
    const rad = (-placement.rotation * Math.PI) / 180
    const localX = dx * Math.cos(rad) - dy * Math.sin(rad)
    const localY = dx * Math.sin(rad) + dy * Math.cos(rad)
    if (Math.abs(localX) <= comp.width / 2 && Math.abs(localY) <= comp.height / 2) {
      return id
    }
  }
  return null
}

export function setupInputHandlers(
  canvas: HTMLCanvasElement,
  inputState: InputState,
  getCC: () => CanvasContext,
): () => void {
  const store = useAppStore.getState
  const { setCamera, setDragState, setHoveredComponent, toggleFrozen, updatePlacement } = useAppStore.getState()

  function getWorldPos(e: PointerEvent | MouseEvent): Point {
    const cc = getCC()
    const rect = canvas.getBoundingClientRect()
    return screenToWorld(cc, e.clientX - rect.left, e.clientY - rect.top)
  }

  function startComponentDrag(e: PointerEvent, hitId: string) {
    const s = store()
    const placement = s.placements.get(hitId)!
    const world = getWorldPos(e)
    canvas.setPointerCapture(e.pointerId)
    setDragState({
      componentId: hitId,
      offsetX: world.x - placement.x,
      offsetY: world.y - placement.y,
      pointerId: e.pointerId,
    })
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

    if (e.button === 0 || e.button === 2) {
      const s = store()
      const world = getWorldPos(e)

      // Right-click: context menu actions
      if (e.button === 2) {
        if (s.mode === "interactive") {
          handleRoutingPointerDown(world, 2, getCC)
        } else {
          // Placement: toggle frozen
          const hitId = hitTestComponent(world, s.components, s.placements)
          if (hitId) toggleFrozen(hitId)
        }
        return
      }

      // Left click: try component drag first (works in all modes)
      const hitId = hitTestComponent(world, s.components, s.placements)
      if (hitId) {
        startComponentDrag(e, hitId)
        return
      }

      // No component hit — routing in interactive mode
      if (s.mode === "interactive") {
        if (e.pointerType === "touch") {
          // Defer tap to distinguish from pinch
          inputState.pendingTap = {
            worldPos: world,
            pointerId: e.pointerId,
            startTime: performance.now(),
            startScreenX: e.clientX,
            startScreenY: e.clientY,
          }
          if (inputState.pendingTapTimer) clearTimeout(inputState.pendingTapTimer)
          inputState.pendingTapTimer = window.setTimeout(() => {
            if (inputState.pendingTap && inputState.camera.pointers.size < 2) {
              handleRoutingPointerDown(inputState.pendingTap.worldPos, 0, getCC)
            }
            inputState.pendingTap = null
            inputState.pendingTapTimer = null
          }, 150)
        } else {
          handleRoutingPointerDown(world, 0, getCC)
        }
      }
    }
  }

  function onPointerMove(e: PointerEvent) {
    inputState.camera.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (inputState.camera.pointers.size >= 2 && inputState.canvasRect) {
      if (inputState.pendingTap) {
        inputState.pendingTap = null
        if (inputState.pendingTapTimer) { clearTimeout(inputState.pendingTapTimer); inputState.pendingTapTimer = null }
      }
      handlePinchUpdate(inputState.camera, setCamera, inputState.canvasRect)
      return
    }

    handlePanMove(e, inputState.camera, setCamera)

    const s = store()
    const dragState = s.dragState

    // Component drag — direct position update in any mode
    if (dragState.componentId && dragState.pointerId === e.pointerId) {
      if (inputState.longPressTimer) {
        clearTimeout(inputState.longPressTimer)
        inputState.longPressTimer = null
      }
      const world = getWorldPos(e)
      const newX = world.x - dragState.offsetX
      const newY = world.y - dragState.offsetY
      updatePlacement(dragState.componentId, { x: newX, y: newY })
      return
    }

    // Interactive routing: live preview
    if (s.mode === "interactive") {
      const world = getWorldPos(e)
      livePreviewRef.path = handleRoutingPointerMove(world)
      return
    }

    // Hover detection
    const world = getWorldPos(e)
    const hitId = hitTestComponent(world, s.components, s.placements)
    if (hitId !== s.hoveredComponentId) {
      setHoveredComponent(hitId)
    }
  }

  function onPointerUp(e: PointerEvent) {
    inputState.camera.pointers.delete(e.pointerId)

    if (inputState.camera.pointers.size < 2) {
      inputState.camera.lastPinchDist = null
      inputState.camera.lastPinchCenter = null
    }

    handlePanEnd(e, inputState.camera)

    if (inputState.longPressTimer) {
      clearTimeout(inputState.longPressTimer)
      inputState.longPressTimer = null
    }

    const s = store()
    if (s.dragState.componentId && s.dragState.pointerId === e.pointerId) {
      setDragState({ componentId: null, offsetX: 0, offsetY: 0, pointerId: null })
    }

    canvas.releasePointerCapture(e.pointerId)
  }

  function onWheel(e: WheelEvent) {
    const s = store()
    // Scroll wheel on dragged component = rotate 45 degrees
    if (s.dragState.componentId) {
      e.preventDefault()
      const comp = s.placements.get(s.dragState.componentId)
      if (comp) {
        const delta = e.deltaY > 0 ? -45 : 45
        const newRotation = ((comp.rotation + delta) % 360 + 360) % 360
        updatePlacement(s.dragState.componentId, { rotation: newRotation })
      }
      return
    }
    handleWheelZoom(e, inputState.camera, setCamera)
  }

  function onContextMenu(e: MouseEvent) {
    e.preventDefault()
  }

  canvas.addEventListener("pointerdown", onPointerDown)
  canvas.addEventListener("pointermove", onPointerMove)
  canvas.addEventListener("pointerup", onPointerUp)
  canvas.addEventListener("pointercancel", onPointerUp)
  canvas.addEventListener("wheel", onWheel, { passive: false })
  canvas.addEventListener("contextmenu", onContextMenu)
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
