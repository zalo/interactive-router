import type { AppState } from "../state/store"
import { renderBoard, renderComponents, renderComponentLabels, renderPads, renderRatsnest, renderTraces, renderOverlay, renderInteractivePreview, renderDebugObstacles, renderDebugMesh } from "./layers"

export interface CanvasContext {
  ctx: CanvasRenderingContext2D
  width: number
  height: number
  zoom: number
  panX: number
  panY: number
  dpr: number
}

export function screenToWorld(cc: CanvasContext, screenX: number, screenY: number): { x: number; y: number } {
  const x = (screenX - cc.width / 2 - cc.panX) / cc.zoom
  const y = -(screenY - cc.height / 2 - cc.panY) / cc.zoom
  return { x, y }
}

export function worldToScreen(cc: CanvasContext, worldX: number, worldY: number): { x: number; y: number } {
  return {
    x: worldX * cc.zoom + cc.width / 2 + cc.panX,
    y: -worldY * cc.zoom + cc.height / 2 + cc.panY,
  }
}

export function renderFrame(canvas: HTMLCanvasElement, state: AppState) {
  const ctx = canvas.getContext("2d")
  if (!ctx) return

  const dpr = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  const width = rect.width
  const height = rect.height

  // Handle HiDPI
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr
    canvas.height = height * dpr
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  const cc: CanvasContext = {
    ctx,
    width,
    height,
    zoom: state.camera.zoom,
    panX: state.camera.panX,
    panY: state.camera.panY,
    dpr,
  }

  // Clear
  ctx.fillStyle = "#1a1a2e"
  ctx.fillRect(0, 0, width, height)

  // Save and apply world transform
  ctx.save()
  ctx.translate(width / 2 + cc.panX, height / 2 + cc.panY)
  ctx.scale(cc.zoom, -cc.zoom) // Y-flip for PCB coords (+Y up)

  // Render layers in order
  renderBoard(ctx, cc, state)
  renderRatsnest(ctx, cc, state)
  renderComponents(ctx, cc, state)
  renderPads(ctx, cc, state)

  // Debug overlays (drawn ABOVE pads so obstacles/mesh are visible)
  if (state.debugView === "obstacles") renderDebugObstacles(ctx, cc, state)
  if (state.debugView === "mesh") renderDebugMesh(ctx, cc, state)

  renderTraces(ctx, cc, state)
  renderComponentLabels(ctx, cc, state)
  renderInteractivePreview(ctx, cc, state)

  ctx.restore()

  // Overlay (screen-space)
  renderOverlay(ctx, cc, state)
}
