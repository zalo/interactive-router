import { useRef, useEffect } from "react"
import { useAppStore } from "./state/store"
import { renderFrame, type CanvasContext } from "./canvas/renderer"
import { setupInputHandlers, type InputState } from "./interaction/inputManager"
import { createCameraState } from "./interaction/camera"
import { buildSimpleRouteJson } from "./state/srjBuilder"
import { runAutorouter } from "./autorouter/runner"
import {
  initPlacementSim,
  stepPlacementSim,
  startDrag,
  updateDrag,
  endDrag,
  setComponentRotation,
  reinitWithMargin,
  syncBodiesToPlacements,
} from "./physics/placementSim"
import { syncPadBodies } from "./physics/box2dManager"
import { rerouteComponentTraces, invalidateAllMeshes } from "./pathfinding/meshManager"
import { createRopes, destroyRopes, readRopePositions, isRopeSimActive, updateRopeEndpoints } from "./physics/ropeSim"
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
  const physicsReadyRef = useRef(false)

  const initialized = useAppStore((s) => s.initialized)
  const mode = useAppStore((s) => s.mode)
  const componentMargin = useAppStore((s) => s.componentMargin)
  const placementVersion = useAppStore((s) => s.placementVersion)
  const ropesEnabled = useAppStore((s) => s.ropesEnabled)
  const marginTimerRef = useRef<number>(0)

  // Load circuit data
  useEffect(() => {
    async function load() {
      try {
        const resp = await fetch("/rp2040base.circuit.json")
        const json = await resp.json()
        useAppStore.getState().loadCircuit(json)

        // Sync camera state with store
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

  // Initialize physics when circuit is loaded
  useEffect(() => {
    if (!initialized) return

    async function setupPhysics() {
      const state = useAppStore.getState()
      try {
        await initPlacementSim(
          state.board.width,
          state.board.height,
          state.components,
          state.placements,
          state.connections,
        )
        physicsReadyRef.current = true
        console.log("Physics initialized with", state.components.size, "components and", state.connections.length, "connections")
      } catch (e) {
        console.error("Failed to init physics:", e)
      }
    }
    setupPhysics()
  }, [initialized])

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

    // Physics-aware interaction callbacks.
    // onPhysicsDrag: pointerdown (first) records grab point, pointermove updates target.
    const dragStartedRef = { current: false }

    const onPhysicsDrag = (componentId: string, worldX: number, worldY: number) => {
      if (!physicsReadyRef.current) return
      if (!dragStartedRef.current) {
        startDrag(componentId, worldX, worldY)
        dragStartedRef.current = true
      } else {
        updateDrag(componentId, worldX, worldY)
      }
    }

    const onPhysicsDragEnd = (componentId: string) => {
      if (physicsReadyRef.current) {
        endDrag(componentId)
      }
      dragStartedRef.current = false
    }

    const onPhysicsRotate = (componentId: string, rotation: number) => {
      if (physicsReadyRef.current) {
        setComponentRotation(componentId, rotation)
      }
    }

    // Setup input handlers
    cleanupRef.current = setupInputHandlers(
      canvas,
      inputStateRef.current,
      getCC,
      onPhysicsDrag,
      onPhysicsDragEnd,
      onPhysicsRotate,
    )

    let metricsCounter = 0

    // Render loop
    function tick() {
      const state = useAppStore.getState()

      // Sync pad collision bodies to component positions
      syncPadBodies(state.components, state.placements)

      // Teleport rope endpoints to pad positions before stepping
      if (isRopeSimActive()) {
        updateRopeEndpoints(state.connections, state.components, state.placements)
      }

      // Always step physics when ready (for ropes, drag forces, collisions).
      // The "Physics" checkbox controls spring forces + inter-component gravity,
      // but the Box2D world always steps so ropes and drag work regardless.
      if (physicsReadyRef.current) {
        const updates = stepPlacementSim(
          state.components,
          state.placements,
          state.board.width,
          state.board.height,
          state.freeRotationEnabled,
          state.physicsEnabled, // only apply spring forces when this is true
        )
        if (updates && updates.size > 0) {
          if (state.dragState.componentId) {
            updates.delete(state.dragState.componentId)
          }
          if (updates.size > 0) {
            state.batchUpdatePlacements(updates)
          }
        }
      }

      // Update rope trace positions from Box2D bodies (when ropes are active)
      if (isRopeSimActive() && state.routedTraces.size > 0) {
        const ropePositions = readRopePositions()
        if (ropePositions.size > 0) {
          const newTraces = new Map(state.routedTraces)
          let changed = false
          for (const [connId, points] of ropePositions) {
            const existing = newTraces.get(connId)
            if (existing && points.length >= 2) {
              newTraces.set(connId, {
                ...existing,
                segments: [{
                  points,
                  layer: existing.segments[0]?.layer || "top",
                  width: existing.segments[0]?.width || 0.15,
                }],
              })
              changed = true
            }
          }
          if (changed) {
            state.setRoutedTraces(newTraces, state.unroutedConnectionIds)
          }
        }
      }

      // Live reroute traces when a component is being dragged (polyanya, when ropes not active)
      if (!isRopeSimActive() && state.dragState.componentId && state.routedTraces.size > 0) {
        // Log once for diagnostics
        if (metricsCounter === 0) {
          console.log(`[reroute-debug] Dragging ${state.dragState.componentId}, routedTraces keys:`, [...state.routedTraces.keys()].slice(0, 5), `conn ids:`, state.connections.slice(0, 5).map(c => c.id))
        }
        {
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
      }

      // Recompute metrics periodically
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

  // Reinit physics when margin changes (debounced)
  useEffect(() => {
    if (!initialized || !physicsReadyRef.current) return
    clearTimeout(marginTimerRef.current)
    marginTimerRef.current = window.setTimeout(async () => {
      const state = useAppStore.getState()
      physicsReadyRef.current = false
      await reinitWithMargin(
        state.board.width,
        state.board.height,
        state.components,
        state.placements,
        state.connections,
        componentMargin,
      )
      physicsReadyRef.current = true
    }, 300)
  }, [componentMargin, initialized])

  // Teleport bodies when placements are randomized
  useEffect(() => {
    if (!initialized || !physicsReadyRef.current || placementVersion === 0) return
    const state = useAppStore.getState()
    syncBodiesToPlacements(state.components, state.placements)
  }, [placementVersion, initialized])

  // Run autorouter when mode switches to "autorouting"
  useEffect(() => {
    if (mode !== "autorouting") return

    const state = useAppStore.getState()
    const srj = buildSimpleRouteJson(state.board, state.components, state.placements, state.connections)

    state.setAutorouterProgress(0.01)

    runAutorouter(srj, 10000, (progress) => {
      useAppStore.getState().setAutorouterProgress(progress)
    }).then((result) => {
      const s = useAppStore.getState()

      // Map connection names back to connection IDs for unrouted tracking
      const routedNames = new Set(result.traces.keys())
      const unroutedIds = new Set<string>()
      for (const conn of s.connections) {
        if (!routedNames.has(conn.name)) {
          unroutedIds.add(conn.id)
        }
      }

      // Map traces by connection ID instead of name
      const tracesById = new Map<string, any>()
      for (const conn of s.connections) {
        const trace = result.traces.get(conn.name)
        if (trace) {
          tracesById.set(conn.id, { ...trace, connectionId: conn.id })
        }
      }

      s.setRoutedTraces(tracesById, unroutedIds)
      s.setAutorouterProgress(0)

      console.log(`[autorouter] ${tracesById.size} routed, ${unroutedIds.size} unrouted, ${result.elapsedMs.toFixed(0)}ms`)
      s.setMode("interactive")
    })
  }, [mode])

  // Create/destroy ropes when toggle changes
  useEffect(() => {
    if (!initialized || !physicsReadyRef.current) return
    const state = useAppStore.getState()
    if (ropesEnabled && state.routedTraces.size > 0) {
      createRopes(state.routedTraces, state.connections, state.components, state.placements)
    } else {
      destroyRopes()
    }
  }, [ropesEnabled, initialized])

  // Keyboard shortcuts
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const state = useAppStore.getState()
      if (e.key === "1") state.setMode("placement")
      else if (e.key === "2") state.setMode("autorouting")
      else if (e.key === "3") state.setMode("interactive")
      else if (e.key === "4") state.setMode("export")
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
