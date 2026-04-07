// Debug visualization system for step-by-step algorithm inspection
import type { DrawnSegment } from './router-ts.ts';

export interface DebugSnapshot {
  step: number;
  type: string;
  description: string;
  // Rendering data captured at this moment:
  vertices: { x: number; y: number; name: string; radius: number; isObstacle: boolean }[];
  edges: { x1: number; y1: number; x2: number; y2: number }[];  // CDT edges
  cuts: { x1: number; y1: number; x2: number; y2: number; cap: number; freeCap: number; usage: number }[];  // Cut capacities
  paths: { netId: number; points: { x: number; y: number }[]; color: string }[];
  segments: DrawnSegment[];  // Tangent-rendered segments (only after rubberband)
  regions: { x: number; y: number; rx: number; ry: number; incident: boolean; neighborCount: number; name: string; regionId: number }[];
  triangles: { x1: number; y1: number; x2: number; y2: number; x3: number; y3: number }[];
  highlight?: {
    vertices?: { x: number; y: number; color: string; label?: string }[];
    edges?: { x1: number; y1: number; x2: number; y2: number; color: string }[];
    path?: { x: number; y: number }[];
  };
}

export class DebugManager {
  snapshots: DebugSnapshot[] = [];
  currentStep: number = -1;
  active: boolean = false;

  reset(): void {
    this.snapshots = [];
    this.currentStep = -1;
  }

  addSnapshot(snapshot: DebugSnapshot): void {
    snapshot.step = this.snapshots.length;
    this.snapshots.push(snapshot);
  }

  stepForward(): DebugSnapshot | null {
    if (this.currentStep < this.snapshots.length - 1) {
      this.currentStep++;
      return this.snapshots[this.currentStep];
    }
    return null;
  }

  stepBackward(): DebugSnapshot | null {
    if (this.currentStep > 0) {
      this.currentStep--;
      return this.snapshots[this.currentStep];
    }
    return null;
  }

  resetToStart(): DebugSnapshot | null {
    this.currentStep = 0;
    return this.snapshots.length > 0 ? this.snapshots[0] : null;
  }

  getCurrent(): DebugSnapshot | null {
    if (this.currentStep >= 0 && this.currentStep < this.snapshots.length) {
      return this.snapshots[this.currentStep];
    }
    return null;
  }

  get totalSteps(): number {
    return this.snapshots.length;
  }
}
