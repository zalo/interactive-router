export interface Point {
  x: number
  y: number
}

export interface Rect {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export interface ComponentData {
  id: string
  name: string
  width: number
  height: number
  pads: PadData[]
  sourceComponentId: string
  originalPcbX: number
  originalPcbY: number
  originalRotation: number
  componentType: "chip" | "resistor" | "capacitor" | "pinheader" | "other"
}

export interface PadData {
  id: string
  localX: number
  localY: number
  width: number
  height: number
  layer: string
  layers?: string[]
  portId?: string
  netIds: string[]
}

export interface PlacementState {
  x: number
  y: number
  rotation: number
  frozen: boolean
}

export interface ConnectionData {
  id: string
  name: string
  endpoints: ConnectionEndpoint[]
}

export interface ConnectionEndpoint {
  componentId: string
  padId: string
  layer: string
}

export interface RoutedTrace {
  connectionId: string
  segments: TraceSegment[]
  vias: ViaData[]
}

export interface TraceSegment {
  points: Point[]
  layer: string
  width: number
}

export interface ViaData {
  x: number
  y: number
  fromLayer: string
  toLayer: string
  diameter: number
}

export interface ActiveRoute {
  connectionId: string
  targetEndpoint: ConnectionEndpoint
  currentLayer: string
  anchorPoint: Point
  placedVias: ViaData[]
  committedSegments: TraceSegment[]
  previewPath: Point[]
}

/** Mutable ref for live preview path (updated every frame, not in store to avoid re-renders) */
export const livePreviewRef = {
  path: null as Point[] | null,
  completionPath: null as Point[] | null,
}

export interface Metrics {
  totalConnectionLength: number
  crossingCount: number
  drcViolations: number
  unroutedCount: number
  routedCount: number
}

export type AppMode = "placement" | "autorouting" | "interactive" | "export"

export interface BoardData {
  width: number
  height: number
  layerCount: number
}
