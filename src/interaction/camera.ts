import type { AppState } from "../state/store"

export interface CameraState {
  panX: number
  panY: number
  zoom: number
  // Multi-touch tracking
  pointers: Map<number, { x: number; y: number }>
  lastPinchDist: number | null
  lastPinchCenter: { x: number; y: number } | null
  isPanning: boolean
  panStartX: number
  panStartY: number
  panPointerId: number | null
}

export function createCameraState(): CameraState {
  return {
    panX: 0,
    panY: 0,
    zoom: 8,
    pointers: new Map(),
    lastPinchDist: null,
    lastPinchCenter: null,
    isPanning: false,
    panStartX: 0,
    panStartY: 0,
    panPointerId: null,
  }
}

export function handleWheelZoom(
  e: WheelEvent,
  camera: CameraState,
  setCamera: (cam: Partial<AppState["camera"]>) => void,
) {
  e.preventDefault()
  const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1
  const newZoom = Math.max(0.5, Math.min(100, camera.zoom * zoomFactor))

  // Zoom toward cursor
  const rect = (e.target as HTMLElement).getBoundingClientRect()
  const mx = e.clientX - rect.left
  const my = e.clientY - rect.top
  const cx = rect.width / 2 + camera.panX
  const cy = rect.height / 2 + camera.panY

  const scale = newZoom / camera.zoom
  const newPanX = mx - scale * (mx - cx) - rect.width / 2
  const newPanY = my - scale * (my - cy) - rect.height / 2

  setCamera({ zoom: newZoom, panX: newPanX, panY: newPanY })
  camera.zoom = newZoom
  camera.panX = newPanX
  camera.panY = newPanY
}

export function handlePanStart(e: PointerEvent, camera: CameraState) {
  // Middle button or touch with 2+ fingers triggers pan
  if (e.button === 1 || (e.pointerType === "touch" && camera.pointers.size >= 1)) {
    camera.isPanning = true
    camera.panStartX = e.clientX - camera.panX
    camera.panStartY = e.clientY - camera.panY
    camera.panPointerId = e.pointerId
  }
}

export function handlePanMove(
  e: PointerEvent,
  camera: CameraState,
  setCamera: (cam: Partial<AppState["camera"]>) => void,
) {
  if (camera.isPanning && camera.panPointerId === e.pointerId) {
    const newPanX = e.clientX - camera.panStartX
    const newPanY = e.clientY - camera.panStartY
    setCamera({ panX: newPanX, panY: newPanY })
    camera.panX = newPanX
    camera.panY = newPanY
  }
}

export function handlePanEnd(e: PointerEvent, camera: CameraState) {
  if (camera.panPointerId === e.pointerId) {
    camera.isPanning = false
    camera.panPointerId = null
  }
}

export function handlePinchUpdate(
  camera: CameraState,
  setCamera: (cam: Partial<AppState["camera"]>) => void,
  canvasRect: DOMRect,
) {
  const pts = Array.from(camera.pointers.values())
  if (pts.length < 2) {
    camera.lastPinchDist = null
    camera.lastPinchCenter = null
    return
  }

  const dx = pts[1].x - pts[0].x
  const dy = pts[1].y - pts[0].y
  const dist = Math.sqrt(dx * dx + dy * dy)
  const center = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }

  if (camera.lastPinchDist !== null && camera.lastPinchCenter !== null) {
    const scale = dist / camera.lastPinchDist
    const newZoom = Math.max(0.5, Math.min(100, camera.zoom * scale))

    // Zoom toward pinch center
    const zoomScale = newZoom / camera.zoom
    const cx = canvasRect.width / 2 + camera.panX
    const cy = canvasRect.height / 2 + camera.panY
    const newPanX = center.x - zoomScale * (center.x - cx) - canvasRect.width / 2
    const newPanY = center.y - zoomScale * (center.y - cy) - canvasRect.height / 2

    // Also pan with pinch movement
    const panDx = center.x - camera.lastPinchCenter.x
    const panDy = center.y - camera.lastPinchCenter.y

    camera.zoom = newZoom
    camera.panX = newPanX + panDx
    camera.panY = newPanY + panDy
    setCamera({ zoom: camera.zoom, panX: camera.panX, panY: camera.panY })
  }

  camera.lastPinchDist = dist
  camera.lastPinchCenter = center
}
