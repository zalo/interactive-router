import { useRef, useEffect } from "react"
import { useAppStore } from "./state/store"
import { renderFrame, type CanvasContext } from "./canvas/renderer"
import { setupInputHandlers, type InputState } from "./interaction/inputManager"
import { createCameraState } from "./interaction/camera"
import { routeAllTraces, invalidateAllMeshes, buildDebugMesh, meshDebug } from "./pathfinding/meshManager"
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

    /** Reroute all traces from current placements. */
    function rerouteAll() {
      const s = useAppStore.getState()
      if (s.connections.length === 0) return
      const { traces, unrouted } = routeAllTraces(s.board, s.components, s.placements, s.connections)
      s.setRoutedTraces(traces, unrouted)
    }

    cleanupRef.current = setupInputHandlers(
      canvas,
      inputStateRef.current,
      getCC,
      () => {
        // On drag end: reroute all traces (component was moved/rotated)
        rerouteAll()
      },
    )

    let metricsCounter = 0
    let renderScheduled = false
    let isRouting = false // guard against setRoutedTraces re-triggering render

    /** Schedule a single render on the next animation frame. */
    function requestRender() {
      if (renderScheduled || isRouting) return
      renderScheduled = true
      rafRef.current = requestAnimationFrame(() => {
        renderScheduled = false
        const state = useAppStore.getState()

        // Live reroute ALL traces when a component is being dragged
        if (state.dragState.componentId && state.routedTraces.size > 0) {
          invalidateAllMeshes()
          isRouting = true
          const { traces, unrouted } = routeAllTraces(
            state.board,
            state.components,
            state.placements,
            state.connections,
          )
          if (traces.size > 0) {
            state.setRoutedTraces(traces, unrouted)
          }
          isRouting = false
        }

        // Debug mesh piggybacks on routeAllTraces; only build separately if needed
        if (state.debugView !== "normal" && meshDebug.lastObstaclePolygons.length === 0) {
          buildDebugMesh("top", state.board, state.components, state.placements, state.routedTraces)
        }

        metricsCounter++
        if (metricsCounter % 30 === 0) {
          state.recomputeMetrics()
        }

        renderFrame(canvas!, state)
      })
    }

    // Re-render whenever zustand state changes (camera, placements, traces, etc.)
    const unsubscribe = useAppStore.subscribe(requestRender)

    // Re-render on window resize
    const onResize = () => requestRender()
    window.addEventListener("resize", onResize)

    // Initial render
    requestRender()

    return () => {
      cancelAnimationFrame(rafRef.current)
      unsubscribe()
      window.removeEventListener("resize", onResize)
      cleanupRef.current?.()
    }
  }, [initialized])

  // Auto-route when mode switches to "autorouting" — simplified single-pass Polyanya
  useEffect(() => {
    if (mode !== "autorouting") return

    const state = useAppStore.getState()
    state.setAutorouterProgress(0.5)

    // Simple single-pass: build pad-only mesh, route all traces
    const t0 = performance.now()
    const { traces, unrouted } = routeAllTraces(
      state.board,
      state.components,
      state.placements,
      state.connections,
    )
    const elapsed = performance.now() - t0

    state.setRoutedTraces(traces, unrouted)
    state.setAutorouterProgress(0)
    console.log(`[autorouter] ${traces.size} routed, ${unrouted.size} unrouted, ${elapsed.toFixed(0)}ms`)
    state.setMode("interactive")
  }, [mode])

  // Reroute traces when placements change (repack/randomize)
  useEffect(() => {
    if (!initialized || placementVersion === 0) return
    const state = useAppStore.getState()
    if (state.connections.length === 0) return
    const { traces, unrouted } = routeAllTraces(state.board, state.components, state.placements, state.connections)
    state.setRoutedTraces(traces, unrouted)
  }, [initialized, placementVersion])

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
