import { useRef, useEffect } from "react"
import { useAppStore } from "./state/store"
import { renderFrame, type CanvasContext } from "./canvas/renderer"
import { setupInputHandlers, type InputState } from "./interaction/inputManager"
import { createCameraState } from "./interaction/camera"
import { buildSimpleRouteJson } from "./state/srjBuilder"
import { runAutorouter } from "./autorouter/runner"
import { rerouteComponentTraces, invalidateAllMeshes, buildDebugMesh, meshDebug } from "./pathfinding/meshManager"
import { Toolbar } from "./ui/Toolbar"

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const inputStateRef = useRef<InputState>({
    camera: createCameraState(),
    longPressTimer: null,
    longPressTriggered: false,
    canvasRect: null,
    pendingTap: null,
    pendingTapTimer: null,
  })
  const rafRef = useRef<number>(0)
  const cleanupRef = useRef<(() => void) | null>(null)

  const initialized = useAppStore((s) => s.initialized)
  const mode = useAppStore((s) => s.mode)
  const componentMargin = useAppStore((s) => s.componentMargin)
  const placementVersion = useAppStore((s) => s.placementVersion)
  const debugView = useAppStore((s) => s.debugView)

  // Load circuit data
  useEffect(() => {
    async function load() {
      try {
        const resp = await fetch("/rp2040base.circuit.json")
        const json = await resp.json()
        useAppStore.getState().loadCircuit(json)

        const cam = useAppStore.getState().camera
        inputStateRef.current.camera.panX = cam.panX
        inputStateRef.current.camera.panY = cam.panY
        inputStateRef.current.camera.zoom = cam.zoom
      } catch (e) {
        console.error("Failed to load circuit:", e)
      }
    }
    load()
  }, [])

  // Setup canvas + interaction + render loop
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !initialized) return

    const getCC = (): CanvasContext => {
      const rect = canvas.getBoundingClientRect()
      const cam = inputStateRef.current.camera
      return {
        ctx: canvas.getContext("2d")!,
        width: rect.width,
        height: rect.height,
        zoom: cam.zoom,
        panX: cam.panX,
        panY: cam.panY,
        dpr: window.devicePixelRatio || 1,
      }
    }

    cleanupRef.current = setupInputHandlers(
      canvas,
      inputStateRef.current,
      getCC,
      () => {
        // On drag end: rebuild debug mesh with full obstacles (no exclusions)
        const s = useAppStore.getState()
        if (s.debugView !== "normal") {
          buildDebugMesh("top", s.board, s.components, s.placements, s.routedTraces)
        }
      },
    )

    let metricsCounter = 0

    function tick() {
      const state = useAppStore.getState()

      // Live reroute traces when a component is being dragged
      if (state.dragState.componentId && state.routedTraces.size > 0) {
        invalidateAllMeshes()
        const newTraces = rerouteComponentTraces(
          state.dragState.componentId,
          state.board,
          state.components,
          state.placements,
          state.connections,
          state.routedTraces,
        )
        if (newTraces) {
          state.setRoutedTraces(newTraces, state.unroutedConnectionIds)
        }
      }

      // Rebuild debug mesh every frame when debug view is active
      if (state.debugView !== "normal") {
        buildDebugMesh("top", state.board, state.components, state.placements, state.routedTraces)
      }

      metricsCounter++
      if (metricsCounter % 30 === 0) {
        state.recomputeMetrics()
      }

      renderFrame(canvas!, state)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafRef.current)
      cleanupRef.current?.()
    }
  }, [initialized])

  // Auto-route when mode switches to "autorouting"
  useEffect(() => {
    if (mode !== "autorouting") return

    const state = useAppStore.getState()
    const srj = buildSimpleRouteJson(state.board, state.components, state.placements, state.connections)

    state.setAutorouterProgress(0.01)

    runAutorouter(srj, 10000, (progress) => {
      useAppStore.getState().setAutorouterProgress(progress)
    }).then((result) => {
      const s = useAppStore.getState()

      const routedNames = new Set(result.traces.keys())
      const unroutedIds = new Set<string>()
      for (const conn of s.connections) {
        if (!routedNames.has(conn.name)) {
          unroutedIds.add(conn.id)
        }
      }

      const tracesById = new Map<string, any>()
      for (const conn of s.connections) {
        const trace = result.traces.get(conn.name)
        if (trace) {
          tracesById.set(conn.id, { ...trace, connectionId: conn.id })
        }
      }

      s.setRoutedTraces(tracesById, unroutedIds)
      s.setAutorouterProgress(0)
      // Store autorouter debug data for visualization
      if (result.debugData) {
        meshDebug.autorouterBaseObstacles = result.debugData.baseObstaclePolygons
        meshDebug.autorouterTraceObstacles = result.debugData.traceObstaclePolygons
        meshDebug.autorouterMeshPolygons = result.debugData.meshPolygons
      }

      console.log(`[autorouter] ${tracesById.size} routed, ${unroutedIds.size} unrouted, ${result.elapsedMs.toFixed(0)}ms`)
      s.setMode("interactive")
    })
  }, [mode])

  // Rebuild debug mesh when debug view changes
  useEffect(() => {
    if (!initialized || debugView === "normal") return
    const state = useAppStore.getState()
    buildDebugMesh("top", state.board, state.components, state.placements, state.routedTraces)
  }, [debugView, initialized, placementVersion])

  // Keyboard shortcuts
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const state = useAppStore.getState()
      if (e.key === "1") state.setMode("placement")
      else if (e.key === "2") state.setMode("autorouting")
      else if (e.key === "3") state.setMode("interactive")
      else if (e.key === "r" || e.key === "R") state.randomizePlacements()
      else if (e.key === "q" || e.key === "Q") state.resetToAutoPlacement()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", background: "#1a1a2e" }}>
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: "100%", display: "block", cursor: "crosshair" }}
      />
      {initialized && <Toolbar />}
      {!initialized && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#808098",
            fontSize: 16,
            fontFamily: "'Inter', system-ui, sans-serif",
          }}
        >
          Loading circuit...
        </div>
      )}
    </div>
  )
}
