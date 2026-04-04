import { useAppStore } from "../state/store"
import type { AppMode } from "../types"

const MODE_CONFIG: Array<{ mode: AppMode; label: string; shortcut: string; icon: string }> = [
  { mode: "placement", label: "Place", shortcut: "1", icon: "\u229e" },
  { mode: "autorouting", label: "Route", shortcut: "2", icon: "\u27bf" },
  { mode: "interactive", label: "Edit", shortcut: "3", icon: "\u270e" },
  { mode: "export", label: "Export", shortcut: "4", icon: "\u2197" },
]

export function Toolbar() {
  const mode = useAppStore((s) => s.mode)
  const setMode = useAppStore((s) => s.setMode)
  const componentMargin = useAppStore((s) => s.componentMargin)
  const setComponentMargin = useAppStore((s) => s.setComponentMargin)
  const physicsEnabled = useAppStore((s) => s.physicsEnabled)
  const setPhysicsEnabled = useAppStore((s) => s.setPhysicsEnabled)
  const freeRotationEnabled = useAppStore((s) => s.freeRotationEnabled)
  const setFreeRotationEnabled = useAppStore((s) => s.setFreeRotationEnabled)
  const ropesEnabled = useAppStore((s) => s.ropesEnabled)
  const setRopesEnabled = useAppStore((s) => s.setRopesEnabled)
  const resetToAutoPlacement = useAppStore((s) => s.resetToAutoPlacement)

  return (
    <>
      {/* Mode buttons — centered horizontally */}
      <div
        style={{
          position: "absolute",
          top: 12,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          gap: 4,
          background: "rgba(26, 26, 46, 0.92)",
          borderRadius: 8,
          padding: 4,
          border: "1px solid #3a3a5c",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          zIndex: 10,
        }}
      >
        {MODE_CONFIG.map(({ mode: m, label, shortcut, icon }) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            title={`${label} (${shortcut})`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 14px",
              borderRadius: 6,
              border: "none",
              cursor: "pointer",
              fontSize: 13,
              fontFamily: "'Inter', system-ui, sans-serif",
              fontWeight: mode === m ? 600 : 400,
              background: mode === m ? "#3a3a6a" : "transparent",
              color: mode === m ? "#e0e0ff" : "#808098",
              transition: "all 0.15s ease",
              minHeight: 36,
              minWidth: 44,
            }}
            onPointerEnter={(e) => {
              if (mode !== m) (e.target as HTMLElement).style.background = "#2a2a4a"
            }}
            onPointerLeave={(e) => {
              if (mode !== m) (e.target as HTMLElement).style.background = "transparent"
            }}
          >
            <span style={{ fontSize: 16, lineHeight: 1 }}>{icon}</span>
            <span>{label}</span>
            <span
              style={{
                fontSize: 10,
                opacity: 0.5,
                background: "#1a1a2e",
                padding: "1px 5px",
                borderRadius: 3,
                marginLeft: 2,
              }}
            >
              {shortcut}
            </span>
          </button>
        ))}
      </div>

      {/* Margin slider — top-right, only in placement mode */}
      {mode === "placement" && (
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
            gap: 4,
            minWidth: 140,
          }}
        >
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
            style={{
              width: "100%",
              accentColor: "#5a5a9a",
              height: 4,
            }}
          />
          <label style={{
            display: "flex", alignItems: "center", gap: 6, fontSize: 12,
            color: "#b0b0d0", fontFamily: "'Inter', system-ui, sans-serif",
            cursor: "pointer", marginTop: 2,
          }}>
            <input
              type="checkbox"
              checked={physicsEnabled}
              onChange={(e) => setPhysicsEnabled(e.target.checked)}
              style={{ accentColor: "#5a5a9a" }}
            />
            Physics
          </label>
          <label style={{
            display: "flex", alignItems: "center", gap: 6, fontSize: 12,
            color: "#b0b0d0", fontFamily: "'Inter', system-ui, sans-serif",
            cursor: "pointer",
          }}>
            <input
              type="checkbox"
              checked={freeRotationEnabled}
              onChange={(e) => setFreeRotationEnabled(e.target.checked)}
              style={{ accentColor: "#5a5a9a" }}
            />
            Free Rotation
          </label>
          <label style={{
            display: "flex", alignItems: "center", gap: 6, fontSize: 12,
            color: "#b0b0d0", fontFamily: "'Inter', system-ui, sans-serif",
            cursor: "pointer", marginBottom: 2,
          }}>
            <input
              type="checkbox"
              checked={ropesEnabled}
              onChange={(e) => setRopesEnabled(e.target.checked)}
              style={{ accentColor: "#50b080" }}
            />
            Rope Traces
          </label>
          <button
            onClick={resetToAutoPlacement}
            title="Repack placement (Q)"
            style={{
              marginTop: 4,
              padding: "6px 0",
              borderRadius: 5,
              border: "1px solid #3a3a5c",
              background: "#2a2a4a",
              color: "#b0b0d0",
              fontSize: 12,
              fontFamily: "'Inter', system-ui, sans-serif",
              cursor: "pointer",
              transition: "all 0.15s ease",
            }}
            onPointerEnter={(e) => { (e.target as HTMLElement).style.background = "#3a3a6a" }}
            onPointerLeave={(e) => { (e.target as HTMLElement).style.background = "#2a2a4a" }}
          >
            Repack
          </button>
        </div>
      )}
    </>
  )
}
