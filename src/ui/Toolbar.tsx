import { useAppStore } from "../state/store"

export function Toolbar() {
  const mode = useAppStore((s) => s.mode)
  const setMode = useAppStore((s) => s.setMode)
  const componentMargin = useAppStore((s) => s.componentMargin)
  const setComponentMargin = useAppStore((s) => s.setComponentMargin)
  const resetToAutoPlacement = useAppStore((s) => s.resetToAutoPlacement)
  const routedTraces = useAppStore((s) => s.routedTraces)
  const autorouterProgress = useAppStore((s) => s.autorouterProgress)
  const debugView = useAppStore((s) => s.debugView)
  const setDebugView = useAppStore((s) => s.setDebugView)

  return (
    <>
      {/* Top-right control panel */}
      <div
        style={{
          position: "absolute",
          top: 12,
          right: 12,
          background: "rgba(26, 26, 46, 0.92)",
          borderRadius: 8,
          padding: "10px 14px",
          border: "1px solid #3a3a5c",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          zIndex: 10,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          minWidth: 150,
        }}
      >
        {/* Margin slider */}
        <label
          style={{
            fontSize: 11,
            color: "#808098",
            fontFamily: "'Inter', system-ui, sans-serif",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>Margin</span>
          <span style={{ color: "#b0b0d0", fontWeight: 600 }}>{componentMargin.toFixed(1)} mm</span>
        </label>
        <input
          type="range"
          min="0"
          max="5"
          step="0.25"
          value={componentMargin}
          onChange={(e) => setComponentMargin(parseFloat(e.target.value))}
          style={{ width: "100%", accentColor: "#5a5a9a", height: 4 }}
        />

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
          <button
            onClick={resetToAutoPlacement}
            title="Repack layout (Q)"
            style={btnStyle}
            onPointerEnter={(e) => { (e.target as HTMLElement).style.background = "#3a3a6a" }}
            onPointerLeave={(e) => { (e.target as HTMLElement).style.background = "#2a2a4a" }}
          >
            Repack
          </button>
          <button
            onClick={() => setMode("autorouting")}
            title="Run autorouter (2)"
            disabled={mode === "autorouting"}
            style={{
              ...btnStyle,
              background: mode === "autorouting" ? "#3a3a6a" : "#2a2a4a",
              opacity: mode === "autorouting" ? 0.6 : 1,
            }}
            onPointerEnter={(e) => { if (mode !== "autorouting") (e.target as HTMLElement).style.background = "#3a3a6a" }}
            onPointerLeave={(e) => { if (mode !== "autorouting") (e.target as HTMLElement).style.background = "#2a2a4a" }}
          >
            {mode === "autorouting" ? `${Math.round(autorouterProgress * 100)}%` : "Route"}
          </button>
        </div>

        {/* Debug view dropdown */}
        <select
          value={debugView}
          onChange={(e) => setDebugView(e.target.value as any)}
          style={{
            marginTop: 2,
            padding: "4px 6px",
            borderRadius: 4,
            border: "1px solid #3a3a5c",
            background: "#1a1a2e",
            color: "#808098",
            fontSize: 11,
            fontFamily: "'Inter', system-ui, sans-serif",
          }}
        >
          <option value="normal">Normal View</option>
          <option value="obstacles">Obstacle Map</option>
          <option value="mesh">CDT Mesh</option>
        </select>

        {/* Status */}
        {routedTraces.size > 0 && (
          <div style={{ fontSize: 10, color: "#606080", fontFamily: "'Inter', system-ui, sans-serif" }}>
            {routedTraces.size} traces routed
          </div>
        )}
      </div>
    </>
  )
}

const btnStyle: React.CSSProperties = {
  flex: 1,
  padding: "7px 0",
  borderRadius: 5,
  border: "1px solid #3a3a5c",
  background: "#2a2a4a",
  color: "#b0b0d0",
  fontSize: 12,
  fontFamily: "'Inter', system-ui, sans-serif",
  cursor: "pointer",
  transition: "all 0.15s ease",
}
