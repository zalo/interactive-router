import type { AppState } from "../state/store"
import { getWorldPadPosition } from "../state/store"
import type { CanvasContext } from "./renderer"
import type { Point, PlacementState, ComponentData } from "../types"
import { livePreviewRef } from "../types"
import { getLiveState } from "../pathfinding/livePathfinder"
import { meshDebug } from "../pathfinding/meshManager"

// Color palette
const COLORS = {
  boardFill: "#12122a",
  boardStroke: "#3a3a5c",
  gridLine: "#1e1e3a",
  componentFill: "#2d2d4a",
  componentStroke: "#4a4a7a",
  componentHover: "#5a5a9a",
  componentFrozen: "#1a3a5c",
  frozenStroke: "#40c0e0",
  padFill: "#c4a35a",
  padStroke: "#a08840",
  ratsnest: "rgba(85, 85, 136, 0.5)",
  traceTop: "#e06060",
  traceBottom: "#4a90d9",
  via: "#50b080",
  viaCenterFill: "#1a1a2e",
  activePreview: "#f0c040",
  selectionGlow: "#7070ff",
  textLight: "#b0b0d0",
  textDim: "#606080",
}

export function renderBoard(ctx: CanvasRenderingContext2D, cc: CanvasContext, state: AppState) {
  const { width, height } = state.board
  const halfW = width / 2
  const halfH = height / 2

  // Grid
  ctx.strokeStyle = COLORS.gridLine
  ctx.lineWidth = 0.05
  for (let x = -halfW; x <= halfW; x += 1) {
    ctx.beginPath()
    ctx.moveTo(x, -halfH)
    ctx.lineTo(x, halfH)
    ctx.stroke()
  }
  for (let y = -halfH; y <= halfH; y += 1) {
    ctx.beginPath()
    ctx.moveTo(-halfW, y)
    ctx.lineTo(halfW, y)
    ctx.stroke()
  }

  // Board outline
  ctx.fillStyle = COLORS.boardFill
  ctx.strokeStyle = COLORS.boardStroke
  ctx.lineWidth = 0.15
  ctx.fillRect(-halfW, -halfH, width, height)
  ctx.strokeRect(-halfW, -halfH, width, height)
}

function drawRotatedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  rotation: number,
) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate((rotation * Math.PI) / 180)
  ctx.fillRect(-w / 2, -h / 2, w, h)
  ctx.strokeRect(-w / 2, -h / 2, w, h)
  ctx.restore()
}

export function renderComponents(ctx: CanvasRenderingContext2D, cc: CanvasContext, state: AppState) {
  const margin = state.componentMargin

  for (const [id, comp] of state.components) {
    const placement = state.placements.get(id)
    if (!placement) continue

    const isHovered = state.hoveredComponentId === id
    const isDragging = state.dragState.componentId === id
    const isFrozen = placement.frozen

    // Draw margin/clearance zone — axis-aligned (outer body doesn't rotate)
    if (margin > 0) {
      ctx.strokeStyle = "rgba(80, 80, 120, 0.25)"
      ctx.lineWidth = 0.05
      ctx.setLineDash([0.3, 0.2])
      const mw = comp.width + margin * 2
      const mh = comp.height + margin * 2
      ctx.strokeRect(placement.x - mw / 2, placement.y - mh / 2, mw, mh)
      ctx.setLineDash([])
    }

    // Component body (rotates with footprint)
    if (isFrozen) {
      ctx.fillStyle = COLORS.componentFrozen
      ctx.strokeStyle = COLORS.frozenStroke
    } else if (isHovered || isDragging) {
      ctx.fillStyle = "#3a3a6a"
      ctx.strokeStyle = COLORS.componentHover
    } else {
      ctx.fillStyle = COLORS.componentFill
      ctx.strokeStyle = COLORS.componentStroke
    }
    ctx.lineWidth = isFrozen ? 0.15 : 0.1

    drawRotatedRect(ctx, placement.x, placement.y, comp.width, comp.height, placement.rotation)
  }
}

export function renderPads(ctx: CanvasRenderingContext2D, cc: CanvasContext, state: AppState) {
  for (const [id, comp] of state.components) {
    const placement = state.placements.get(id)
    if (!placement) continue

    const rad = (placement.rotation * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)

    ctx.fillStyle = COLORS.padFill
    ctx.strokeStyle = COLORS.padStroke
    ctx.lineWidth = 0.03

    for (const pad of comp.pads) {
      const wx = placement.x + pad.localX * cos - pad.localY * sin
      const wy = placement.y + pad.localX * sin + pad.localY * cos

      // Draw pad as small rect (rotated with component)
      ctx.save()
      ctx.translate(wx, wy)
      ctx.rotate(rad)
      const pw = Math.max(pad.width, 0.15)
      const ph = Math.max(pad.height, 0.15)
      ctx.fillRect(-pw / 2, -ph / 2, pw, ph)
      ctx.strokeRect(-pw / 2, -ph / 2, pw, ph)
      ctx.restore()
    }
  }
}

export function renderComponentLabels(ctx: CanvasRenderingContext2D, cc: CanvasContext, state: AppState) {
  for (const [id, comp] of state.components) {
    const placement = state.placements.get(id)
    if (!placement) continue

    const isFrozen = placement.frozen

    // Component name — rendered on top of pads
    ctx.save()
    ctx.translate(placement.x, placement.y)
    ctx.scale(1, -1) // Unflip Y for text
    const fontSize = Math.min(comp.width, comp.height) * 0.3
    ctx.font = `bold ${Math.max(fontSize, 0.8)}px sans-serif`
    ctx.fillStyle = COLORS.textLight
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"

    // Drop shadow for readability over pads
    ctx.shadowColor = "rgba(0, 0, 0, 0.7)"
    ctx.shadowBlur = 2 / cc.zoom
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 0
    ctx.fillText(comp.name, 0, 0)
    ctx.shadowColor = "transparent"
    ctx.restore()

    // Frozen badge
    if (isFrozen) {
      ctx.save()
      ctx.translate(placement.x + comp.width / 2 - 0.5, placement.y + comp.height / 2 - 0.5)
      ctx.scale(1, -1)
      ctx.font = "bold 0.8px sans-serif"
      ctx.fillStyle = COLORS.frozenStroke
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.fillText("*", 0, 0)
      ctx.restore()
    }
  }
}

export function renderRatsnest(ctx: CanvasRenderingContext2D, cc: CanvasContext, state: AppState) {
  if (state.mode !== "placement" && state.unroutedConnectionIds.size === 0) return

  ctx.strokeStyle = COLORS.ratsnest
  ctx.lineWidth = 0.08
  ctx.setLineDash([0.3, 0.3])

  const connectionsToShow =
    state.mode === "placement"
      ? state.connections
      : state.connections.filter((c) => state.unroutedConnectionIds.has(c.id))

  for (const conn of connectionsToShow) {
    if (conn.endpoints.length < 2) continue

    // Draw star topology from first endpoint to all others
    const p0 = getWorldPadPosition(state.components, state.placements, conn.endpoints[0].componentId, conn.endpoints[0].padId)
    if (!p0) continue

    for (let i = 1; i < conn.endpoints.length; i++) {
      const pi = getWorldPadPosition(state.components, state.placements, conn.endpoints[i].componentId, conn.endpoints[i].padId)
      if (!pi) continue

      ctx.beginPath()
      ctx.moveTo(p0.x, p0.y)
      ctx.lineTo(pi.x, pi.y)
      ctx.stroke()
    }
  }

  ctx.setLineDash([])
}

export function renderTraces(ctx: CanvasRenderingContext2D, cc: CanvasContext, state: AppState) {
  for (const [, trace] of state.routedTraces) {
    // Draw segments
    for (const seg of trace.segments) {
      ctx.strokeStyle = seg.layer === "top" ? COLORS.traceTop : COLORS.traceBottom
      ctx.lineWidth = Math.max(seg.width, 0.15)
      ctx.lineCap = "round"
      ctx.lineJoin = "round"

      if (seg.points.length < 2) continue
      ctx.beginPath()
      ctx.moveTo(seg.points[0].x, seg.points[0].y)
      for (let i = 1; i < seg.points.length; i++) {
        ctx.lineTo(seg.points[i].x, seg.points[i].y)
      }
      ctx.stroke()
    }

    // Draw vias
    for (const via of trace.vias) {
      const r = (via.diameter || 0.6) / 2
      ctx.fillStyle = COLORS.via
      ctx.beginPath()
      ctx.arc(via.x, via.y, r, 0, Math.PI * 2)
      ctx.fill()

      ctx.fillStyle = COLORS.viaCenterFill
      ctx.beginPath()
      ctx.arc(via.x, via.y, r * 0.4, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

export function renderInteractivePreview(ctx: CanvasRenderingContext2D, cc: CanvasContext, state: AppState) {
  const liveState = getLiveState()

  // Draw from livePathfinder state (active routing in interactive mode)
  if (liveState) {
    // Committed segments
    for (const seg of liveState.committedSegments) {
      ctx.strokeStyle = COLORS.activePreview
      ctx.lineWidth = 0.2
      ctx.lineCap = "round"
      ctx.setLineDash([])
      if (seg.points.length < 2) continue
      ctx.beginPath()
      ctx.moveTo(seg.points[0].x, seg.points[0].y)
      for (let i = 1; i < seg.points.length; i++) ctx.lineTo(seg.points[i].x, seg.points[i].y)
      ctx.stroke()
    }

    // Placed vias
    for (const via of liveState.placedVias) {
      ctx.fillStyle = COLORS.activePreview
      ctx.beginPath()
      ctx.arc(via.x, via.y, 0.3, 0, Math.PI * 2)
      ctx.fill()
    }

    // Start point indicator
    ctx.fillStyle = COLORS.activePreview
    ctx.beginPath()
    ctx.arc(liveState.startPoint.x, liveState.startPoint.y, 0.25, 0, Math.PI * 2)
    ctx.fill()

    // Target endpoint indicator (pulsing)
    const pulse = 0.2 + Math.sin(performance.now() / 200) * 0.1
    ctx.strokeStyle = COLORS.activePreview
    ctx.lineWidth = 0.1
    ctx.beginPath()
    ctx.arc(liveState.targetEndpoint.x, liveState.targetEndpoint.y, pulse + 0.3, 0, Math.PI * 2)
    ctx.stroke()
  }

  // Draw live preview path from livePreviewRef (updated by pointer move)
  const previewPath = livePreviewRef.path
  if (previewPath && previewPath.length >= 2) {
    ctx.strokeStyle = COLORS.activePreview
    ctx.lineWidth = 0.15
    ctx.lineCap = "round"
    ctx.setLineDash([0.2, 0.15])
    ctx.beginPath()
    ctx.moveTo(previewPath[0].x, previewPath[0].y)
    for (let i = 1; i < previewPath.length; i++) ctx.lineTo(previewPath[i].x, previewPath[i].y)
    ctx.stroke()
    ctx.setLineDash([])
  }

  // Also draw from store's activeRoute if present (legacy/compat)
  if (state.activeRoute && state.activeRoute.previewPath.length >= 2) {
    const route = state.activeRoute
    ctx.strokeStyle = COLORS.activePreview
    ctx.lineWidth = 0.15
    ctx.setLineDash([0.2, 0.15])
    ctx.beginPath()
    ctx.moveTo(route.previewPath[0].x, route.previewPath[0].y)
    for (let i = 1; i < route.previewPath.length; i++) ctx.lineTo(route.previewPath[i].x, route.previewPath[i].y)
    ctx.stroke()
    ctx.setLineDash([])
  }
}

export function renderOverlay(ctx: CanvasRenderingContext2D, cc: CanvasContext, state: AppState) {
  ctx.save()

  // Metrics panel (bottom-left)
  const m = state.metrics
  const panelY = cc.height - 100
  ctx.fillStyle = "rgba(26, 26, 46, 0.9)"
  ctx.beginPath()
  ctx.roundRect(12, panelY, 220, 88, 6)
  ctx.fill()
  ctx.strokeStyle = "#3a3a5c"
  ctx.lineWidth = 1
  ctx.stroke()

  ctx.font = "11px 'Inter', system-ui, sans-serif"
  ctx.fillStyle = "#808098"
  ctx.textAlign = "left"
  const lines = [
    `Total Length: ${m.totalConnectionLength.toFixed(1)} mm`,
    `Crossings: ${m.crossingCount}`,
    `Unrouted: ${m.unroutedCount}`,
    `Routed: ${m.routedCount}`,
  ]
  lines.forEach((line, i) => {
    ctx.fillStyle = i === 0 ? "#c0c0e0" : "#808098"
    ctx.fillText(line, 22, panelY + 18 + i * 18)
  })

  // Autorouter progress
  if (state.mode === "autorouting" && state.autorouterProgress > 0) {
    const barW = 200
    const barH = 6
    const barX = cc.width / 2 - barW / 2
    const barY = cc.height - 40

    ctx.fillStyle = "rgba(26, 26, 46, 0.9)"
    ctx.beginPath()
    ctx.roundRect(barX - 10, barY - 20, barW + 20, 40, 6)
    ctx.fill()

    ctx.fillStyle = "#2a2a4a"
    ctx.beginPath()
    ctx.roundRect(barX, barY, barW, barH, 3)
    ctx.fill()

    ctx.fillStyle = "#50b080"
    ctx.beginPath()
    ctx.roundRect(barX, barY, barW * state.autorouterProgress, barH, 3)
    ctx.fill()

    ctx.font = "11px 'Inter', system-ui, sans-serif"
    ctx.fillStyle = "#b0b0d0"
    ctx.textAlign = "center"
    ctx.fillText(`Routing... ${Math.round(state.autorouterProgress * 100)}%`, cc.width / 2, barY - 6)
  }

  ctx.restore()
}

function drawPolygonList(
  ctx: CanvasRenderingContext2D,
  polygons: Array<{ x: number; y: number }[]>,
  fillColor: string,
  strokeColor: string,
  showLabels: boolean,
) {
  for (let i = 0; i < polygons.length; i++) {
    const poly = polygons[i]!
    if (poly.length < 3) continue

    ctx.fillStyle = fillColor
    ctx.strokeStyle = strokeColor
    ctx.lineWidth = 0.05

    ctx.beginPath()
    ctx.moveTo(poly[0]!.x, poly[0]!.y)
    for (let j = 1; j < poly.length; j++) {
      ctx.lineTo(poly[j]!.x, poly[j]!.y)
    }
    ctx.closePath()
    ctx.fill()
    ctx.stroke()

    if (showLabels) {
      const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length
      const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length
      ctx.save()
      ctx.translate(cx, cy)
      ctx.scale(1, -1)
      ctx.font = "0.35px sans-serif"
      ctx.fillStyle = "#fff"
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.fillText(`${i}`, 0, 0)
      ctx.restore()
    }
  }
}

/** Render obstacle polygons — always uses live data from buildDebugMesh */
export function renderDebugObstacles(ctx: CanvasRenderingContext2D, cc: CanvasContext, state: AppState) {
  // Live pad obstacles (green) — rebuilt every frame from current placements
  drawPolygonList(ctx, meshDebug.lastObstaclePolygons, "rgba(40, 180, 80, 0.25)", "rgba(40, 180, 80, 0.7)", true)

  // Autorouter trace obstacles (orange) — from last routing run
  if (meshDebug.autorouterTraceObstacles.length > 0) {
    drawPolygonList(ctx, meshDebug.autorouterTraceObstacles, "rgba(220, 100, 40, 0.2)", "rgba(220, 100, 40, 0.7)", false)
  }
}

/** Render CDT mesh — always uses live data from buildDebugMesh */
export function renderDebugMesh(ctx: CanvasRenderingContext2D, cc: CanvasContext, state: AppState) {
  const polys = meshDebug.lastMeshPolygons
  if (polys.length === 0) return

  for (const poly of polys) {
    if (poly.vertices.length < 3) continue

    if (poly.blocked) {
      ctx.fillStyle = "rgba(180, 40, 40, 0.25)"
      ctx.strokeStyle = "rgba(180, 40, 40, 0.5)"
    } else if (poly.obstacleIndex >= 0) {
      ctx.fillStyle = "rgba(180, 120, 40, 0.15)"
      ctx.strokeStyle = "rgba(180, 120, 40, 0.4)"
    } else {
      // Navigable polygons — visible enough to debug mesh structure
      ctx.fillStyle = "rgba(40, 120, 180, 0.15)"
      ctx.strokeStyle = "rgba(40, 120, 180, 0.5)"
    }
    ctx.lineWidth = 0.03

    ctx.beginPath()
    ctx.moveTo(poly.vertices[0]!.x, poly.vertices[0]!.y)
    for (let j = 1; j < poly.vertices.length; j++) {
      ctx.lineTo(poly.vertices[j]!.x, poly.vertices[j]!.y)
    }
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
  }
}
