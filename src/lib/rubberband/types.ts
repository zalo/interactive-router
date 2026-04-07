// Data structures ported from router.rb
// Stefan Salewski's Rubberband Router

import { booleanCrossProduct2D } from './geometry.ts';

// Constants
export const MBD = (2 ** 30 - 2 ** 24); // Maximum Board Diagonal ~= Infinity
export const AVD = 5000; // Average Via Diameter (50 mil in 0.01mil units)
export const ATW = 1000; // Average Trace Width (10 mil)

export const DEFAULT_PIN_RADIUS = 1000;
export const DEFAULT_TRACE_WIDTH = 1200;
export const DEFAULT_CLEARANCE = 800;
export const DEFAULT_MIN_CUT_SIZE = 6000;

// Net connecting two terminals (2-Net)
let netIdCounter = 0;

export class NetDesc {
  id: number;
  t1Name: string;
  t2Name: string;
  traceWidth: number;
  traceClearance: number;
  pri: number = 0; // priority for net ordering by length
  flag: number = 1; // used for sorting attached nets

  constructor(t1Name: string, t2Name: string, traceWidth = DEFAULT_TRACE_WIDTH, traceClearance = DEFAULT_CLEARANCE) {
    this.id = ++netIdCounter;
    this.t1Name = t1Name;
    this.t2Name = t2Name;
    this.traceWidth = traceWidth;
    this.traceClearance = traceClearance;
  }

  static resetIds(): void {
    netIdCounter = 0;
  }
}

// Incident or attached net step at a terminal
export class Step {
  static _uidCounter = 0;
  readonly _uid: number;
  id: number;
  netDesc!: NetDesc;
  vertex!: Vertex;
  prev: Vertex | null = null;
  next: Vertex | null = null;
  pstep: Step | null = null;
  nstep: Step | null = null;
  radius: number = 0;
  score: number | null = 0;
  index: number = 0;
  ref: Step | null = null;
  rgt: boolean = false; // right tangent side
  outer: boolean = false; // use outer lane
  xt: boolean = false; // tangents cross (concave)
  lrTurn: boolean = false; // left or right turn

  constructor(prev: Vertex | null, next: Vertex | null, id: number) {
    this._uid = Step._uidCounter++;
    this.prev = prev;
    this.next = next;
    this.id = id;
  }
}

// Plain temporary vertex
export class Tex {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

// Terminal / Vertex
let vertexIdCounter = 0;

export class Vertex {
  id: number;
  cid: number = -1; // cluster id; -1 for plain pins
  visFlag: number = 0;
  x: number;
  y: number;
  core: number; // outer copper of pin itself
  radius: number; // outer copper including attached traces
  separation: number; // clearance
  neighbors: Vertex[] = [];
  incidentNets: Step[] = [];
  attachedNets: Step[] = [];
  name: string = '';
  tradius: number = 0;
  trgt: boolean = false;
  outer: boolean | null = null;
  lrTurn: boolean | null = null;
  via: boolean = false;
  numInets: number = 0;

  constructor(x: number = 0, y: number = 0, r: number = DEFAULT_PIN_RADIUS, c: number = DEFAULT_CLEARANCE) {
    this.id = vertexIdCounter++;
    this.x = x;
    this.y = y;
    this.radius = this.core = r;
    this.separation = c;
  }

  static resetIds(): void {
    vertexIdCounter = 0;
  }

  resetInitialSize(): void {
    this.radius = this.core;
    this.separation = DEFAULT_CLEARANCE;
  }

  resize(): void {
    this.resetInitialSize();
    for (const step of this.attachedNets) {
      const net = step.netDesc;
      const traceSep = Math.max(this.separation, net.traceClearance);
      this.radius += traceSep + net.traceWidth;
      step.radius = this.radius - net.traceWidth * 0.5;
      this.separation = net.traceClearance;
    }
  }

  // Worst case radius estimation
  unfriendlyResize(): void {
    const cl = this.attachedNets.map(step => step.netDesc.traceClearance);
    const totalWidth = this.attachedNets.reduce((sum, step) => sum + step.netDesc.traceWidth, 0);
    this.radius = this.core + totalWidth;

    // Compute worst case clearance arrangement
    const allCl = [...cl, this.separation];
    let maxSep = 0;
    // Simplified: sum of max adjacent pairs
    const sorted = [...allCl].sort((a, b) => b - a);
    maxSep = sorted.reduce((sum, v) => sum + v, 0) - Math.min(...allCl);
    this.radius += maxSep;
    this.separation = Math.max(...allCl);
  }

  update(s: Step): void {
    const net = s.netDesc;
    const traceSep = Math.max(this.separation, net.traceClearance);
    this.radius += traceSep + net.traceWidth;
    s.radius = this.radius - net.traceWidth * 0.5;
    this.separation = net.traceClearance;
  }

  net(id: number): Step | null {
    for (const s of this.incidentNets) if (s.id === id) return s;
    for (const s of this.attachedNets) if (s.id === id) return s;
    return null;
  }

  deleteNet(step: Step): void {
    this.incidentNets = this.incidentNets.filter(s => s !== step);
    this.attachedNets = this.attachedNets.filter(s => s !== step);
    this.resize();
  }

  private _fullAngle(s: Step): number | null {
    if (!s.next || !s.prev) return null;
    const v = s.vertex;
    let d = Math.atan2(s.next.y - v.y, s.next.x - v.x) -
      Math.atan2(v.y - s.prev.y, v.x - s.prev.x);
    if (d < -Math.PI) d += 2 * Math.PI;
    else if (d > Math.PI) d -= 2 * Math.PI;
    return d;
  }

  sortAttachedNets(): void {
    if (this.attachedNets.length < 2) return;

    for (const n of this.attachedNets) {
      const angle = this._fullAngle(n);
      n.index = (angle ?? 0) * (n.rgt ? 1 : -1);
    }
    this.attachedNets.sort((a, b) => a.index - b.index);
    this.attachedNets.forEach((n, i) => n.index = i);

    // Group attached nets with same angle (overlapping)
    const shash = new Map<string, Step[]>();
    for (const n of this.attachedNets) {
      const l = n.prev;
      const r = n.next;
      n.netDesc.flag = 1;
      const key1 = `${l?.id ?? 'null'}_${r?.id ?? 'null'}`;
      const key2 = `${r?.id ?? 'null'}_${l?.id ?? 'null'}`;
      if (shash.has(key1)) {
        shash.get(key1)!.push(n);
      } else if (shash.has(key2)) {
        n.netDesc.flag = -1;
        shash.get(key2)!.push(n);
      } else {
        shash.set(key1, [n]);
      }
    }

    // Fine sort each group by tracing
    for (const group of shash.values()) {
      if (group.length > 1) {
        group.reverse();
        for (const el of group) el.ref = el;
        const indices = group.map(el => el.index).sort((a, b) => a - b);

        const rel = new Map<string, number>();
        for (const direction of [-1, 1]) {
          const gr: (Step | null)[] = [...group];
          let final = true;
          let unresolved = false;

          let maxIter = 100;
          while (gr.length > 1 && maxIter-- > 0) {
            // Walk: replace each element with next/prev step (may become null)
            for (let k = 0; k < gr.length; k++) {
              const el = gr[k]!;
              gr[k] = el.netDesc.flag === direction ? el.pstep : el.nstep;
            }
            // Update refs on walked steps
            for (const el of gr) {
              if (el) {
                el.ref = (el.netDesc.flag === direction ? el.nstep!.ref : el.pstep!.ref);
              }
            }
            // Compute scores
            for (const el of gr) {
              if (el) {
                el.score = this._fullAngle(el);
              }
            }

            unresolved = false;
            // Filter to alive steps for comparison
            const alive = gr.filter((el): el is Step => el != null && el.next != null && el.prev != null);
            for (let i = 0; i < alive.length; i++) {
              for (let j = i + 1; j < alive.length; j++) {
                const a = alive[i];
                const b = alive[j];
                const rkey = `${a.ref!._uid}_${b.ref!._uid}`;
                const rkeyR = `${b.ref!._uid}_${a.ref!._uid}`;
                const relation = rel.get(rkey);
                if (!relation || Math.abs(relation) < 2) {
                  let c: number;
                  if (a.score == null) {
                    c = ((b.rgt === b.ref!.rgt) ? 1 : -1);
                  } else if (b.score == null) {
                    c = ((a.rgt === a.ref!.rgt) ? -1 : 1);
                  } else if (Math.abs(a.score * a.netDesc.flag - b.score * b.netDesc.flag) < 1e-6) {
                    c = 0;
                  } else {
                    const aVal = a.score * (a.ref!.rgt ? 1 : -1);
                    const bVal = b.score * (b.ref!.rgt ? 1 : -1);
                    c = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
                  }
                  if (c !== 0) {
                    if (final) c *= 2;
                    rel.set(rkey, c);
                    rel.set(rkeyR, -c);
                  } else {
                    unresolved = true;
                  }
                }
              }
            }
            if (!unresolved) break;
            // Remove dead ends (nulls and steps without next/prev)
            gr.length = 0;
            gr.push(...alive);
          }
          if (final) break;
        }

        group.sort((a, b) => {
          const key = `${a._uid}_${b._uid}`;
          return rel.get(key) ?? 0;
        });
        for (const el of group) {
          el.index = indices.shift()!;
        }
      }
    }

    this.attachedNets.sort((a, b) => -a.index + b.index);
  }
}

// Region - represents a node in the routing graph
export class Region {
  static _nextId = 0;
  readonly regionId: number;
  vertex: Vertex;
  neighbors: Region[] = [];
  incident: boolean = true;
  outer: boolean | null = null;
  g: number = 1;
  ox: number = 0;
  oy: number = 0;
  rx: number;
  ry: number;
  lrTurn: boolean | null = null;
  idirs: [number, number][] = [];
  odirs: [number, number][] = [];

  constructor(v: Vertex) {
    this.regionId = Region._nextId++;
    this.vertex = v;
    this.rx = v.x;
    this.ry = v.y;
  }

  /**
   * Iterate over qualified neighbors based on inner/outer directions
   * Yields [neighbor, useInner, useOuter]
   */
  qbors(
    old: Region | null,
    callback: (neighbor: Region, useInner: boolean, useOuter: boolean) => void
  ): void {
    if (old) {
      // Original Ruby: ox = self.vertex.x, oy = self.vertex.y (raw vertex coords)
      // Direction vectors use rx, ry (with offset) relative to raw vertex position
      const ox = this.vertex.x;
      const oy = this.vertex.y;
      const ax = old.rx - ox;
      const ay = old.ry - oy;

      for (const el of this.neighbors) {
        if (el === old) continue;
        const bx = el.rx - ox;
        const by = el.ry - oy;

        // Original: RBR::xboolean_really_smart_cross_product_2d_with_offset(old, el, self)
        const turn = booleanCrossProduct2D(old.rx, old.ry, el.rx, el.ry, this.vertex.x, this.vertex.y);

        let inner = true;
        let outer = this.incident;

        if (this.odirs.length > 0) {
          outer = true;
          for (const [zx, zy] of this.odirs) {
            let j: boolean;
            if (turn) {
              j = ax * zy >= ay * zx && bx * zy <= by * zx;
            } else {
              j = ax * zy <= ay * zx && bx * zy >= by * zx;
            }
            if (!(outer = outer && j)) break;
          }
          inner = !outer;
        }

        for (const [zx, zy] of this.idirs) {
          let j: boolean;
          if (turn) {
            j = ax * zy >= ay * zx && bx * zy <= by * zx;
          } else {
            j = ax * zy <= ay * zx && bx * zy >= by * zx;
          }
          if (j) {
            inner = false;
          } else {
            outer = false;
          }
          if (!inner && !outer) break;
        }

        callback(el, inner, outer);
      }
    } else {
      for (const el of this.neighbors) {
        callback(el, true, true);
      }
    }
  }

  distanceTo(other: Region): number {
    return Math.hypot(this.vertex.x - other.vertex.x, this.vertex.y - other.vertex.y);
  }
}


// Cut between two adjacent vertices in the triangulation
export class Cut {
  cap: number; // vertex distance
  freeCap: number; // cap - vertex copper - copper of passing traces
  cv1: number; // clearance of first vertex
  cv2: number; // clearance of second vertex
  cl: number[] = []; // clearances for each trace passing

  constructor(v1: Vertex, v2: Vertex) {
    this.cap = Math.hypot(v1.x - v2.x, v1.y - v2.y);
    this.freeCap = this.cap - v1.core - v2.core;
    this.cv1 = DEFAULT_CLEARANCE;
    this.cv2 = DEFAULT_CLEARANCE;
  }

  /**
   * Return MBD when no space, or squeeze measure going to zero with more space
   */
  squeezeStrength(traceWidth: number, traceClearance: number): number {
    let s: number;
    if (this.cl.length === 0) {
      if (this.cv1 < this.cv2 && this.cv1 < traceClearance) {
        s = this.cv2 + traceClearance;
      } else if (this.cv2 < traceClearance) {
        s = this.cv1 + traceClearance;
      } else {
        s = this.cv1 + this.cv2;
      }
    } else {
      this.cl.push(traceClearance);
      const ll = Math.floor(this.cl.length / 2);
      const sorted = [...this.cl].sort((a, b) => b - a);
      const hhh = [...sorted.slice(0, ll + 1), ...sorted.slice(0, ll + 1)];
      if (this.cl.length % 2 === 0) hhh.pop();
      hhh.push(this.cv1);
      hhh.push(this.cv2);
      hhh.sort((a, b) => a - b);
      hhh.splice(0, 2);
      s = hhh.reduce((sum, v) => sum + v, 0);
      this.cl.pop();
    }
    s = this.freeCap - traceWidth - s;
    return s < 0 ? MBD : 10 * AVD * ATW / (ATW + s * 2);
  }

  use(traceWidth: number, traceClearance: number): void {
    this.freeCap -= traceWidth;
    this.cl.push(traceClearance);
  }
}

// Hash with ordered key pairs
export class SymmetricMap<V> {
  private map = new Map<string, V>();

  private key(a: number, b: number): string {
    return a < b ? `${a}_${b}` : `${b}_${a}`;
  }

  get(a: { id: number }, b: { id: number }): V | undefined {
    return this.map.get(this.key(a.id, b.id));
  }

  set(a: { id: number }, b: { id: number }, v: V): void {
    this.map.set(this.key(a.id, b.id), v);
  }

  has(a: { id: number }, b: { id: number }): boolean {
    return this.map.has(this.key(a.id, b.id));
  }

  forEach(callback: (value: V, key: string) => void): void {
    this.map.forEach(callback);
  }
}
