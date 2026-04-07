// Main Router ported from router.rb
// Stefan Salewski's Rubberband Router

import {
  Vertex, Region, Step, NetDesc, Cut, Tex,
  SymmetricMap, MBD, AVD, ATW,
  DEFAULT_PIN_RADIUS, DEFAULT_TRACE_WIDTH, DEFAULT_CLEARANCE
} from './types.ts';
import {
  booleanCrossProduct2D, getTangents,
  normalDistanceLineSegmentPointSquared,
  distanceLineSegmentPointSquared,
  pointInTriangle, verticesInPolygon,
  segmentIntersects as segmentsIntersect,
  apolloniusConvexHull
} from './geometry.ts';
import { PriorityQueue } from './priority-queue.ts';
import { CDT } from './cdt.ts';
import type { DebugSnapshot } from './debug.ts';

export interface RouteResult {
  success: boolean;
  netId: number;
}

export interface DrawnSegment {
  type: 'line' | 'arc';
  x1: number; y1: number;
  x2: number; y2: number;
  cx?: number; cy?: number; // center for arcs
  r?: number; // radius for arcs
  startAngle?: number; endAngle?: number;
  width: number;
  netId: number;
  layer: number;
}

export class Router {
  private b1x: number;
  private b1y: number;
  private b2x: number;
  private b2y: number;
  private cdt: CDT;
  private cdtHash: Map<string, Vertex> = new Map();
  private vertices: Vertex[] = [];
  private regions: Region[] = [];
  private newcuts: SymmetricMap<Cut> = new SymmetricMap();
  private edgesInCluster: SymmetricMap<boolean> = new SymmetricMap();
  private pathId: number = 0;
  private nextObstacleClusterId: number = 100; // start high to avoid conflicts with pin cids
  private obstaclePolygons: { vertices: Vertex[]; clusterId: number }[] = [];
  netlist: NetDesc[] = [];
  drawnSegments: DrawnSegment[] = [];
  onDebugStep?: (snapshot: Partial<DebugSnapshot>) => void;

  constructor(b1x: number, b1y: number, b2x: number, b2y: number) {
    this.b1x = b1x;
    this.b1y = b1y;
    this.b2x = b2x;
    this.b2y = b2y;
    this.cdt = new CDT();
    Vertex.resetIds();
    NetDesc.resetIds();
  }

  insertVertex(name: string, x: number, y: number, r: number = DEFAULT_PIN_RADIUS, c: number = DEFAULT_CLEARANCE): Vertex {
    const key = `${x}_${y}`;
    if (this.cdtHash.has(key)) return this.cdtHash.get(key)!;
    const v = new Vertex(x, y, r, c);
    v.name = name;
    this.cdtHash.set(key, v);
    this.cdt.insert(v);
    return v;
  }

  insertBorder(): void {
    const [a0, b0] = [Math.min(this.b1x, this.b2x), Math.max(this.b1x, this.b2x)];
    const dx0 = (b0 - a0) / 25;
    const a = a0 - dx0;
    const b = b0 + dx0;
    const dxStep = (b - a) / 10;

    const [c0, d0] = [Math.min(this.b1y, this.b2y), Math.max(this.b1y, this.b2y)];
    const dy0 = (d0 - c0) / 25;
    const c = c0 - dy0;
    const d = d0 + dy0;
    const dyStep = (d - c) / 10;

    for (let x = a; x <= b + 0.01; x += dxStep) {
      this.insertVertex('border', x, c0 - dy0);
      this.insertVertex('border', x, d0 + dy0);
    }
    for (let y = c + dyStep; y <= d - dyStep + 0.01; y += dyStep) {
      this.insertVertex('border', a0 - dx0, y);
      this.insertVertex('border', b0 + dx0, y);
    }
  }

  /**
   * Insert a polygon obstacle into the CDT.
   * Samples vertices along edges, inserts CDT constraints, and marks
   * boundary vertices so Dijkstra penalizes paths through them.
   * Interior edges will be blocked via edgesInCluster.
   */
  insertPolygonObstacle(vertices: { x: number; y: number }[]): void {
    if (vertices.length < 3) return;

    const SAMPLE_INTERVAL = 5000; // sample a vertex every ~5000 units along edges
    const clusterId = this.nextObstacleClusterId++;

    // Build sampled boundary vertices for this polygon
    const boundaryVerts: Vertex[] = [];
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i];
      const b = vertices[(i + 1) % vertices.length];
      const edgeLen = Math.hypot(b.x - a.x, b.y - a.y);
      const samples = Math.max(1, Math.round(edgeLen / SAMPLE_INTERVAL));

      for (let s = 0; s < samples; s++) {
        const t = s / samples;
        const px = a.x + (b.x - a.x) * t;
        const py = a.y + (b.y - a.y) * t;
        const v = this.insertVertex('obstacle_boundary', px, py, 0, DEFAULT_CLEARANCE);
        v.cid = clusterId;
        boundaryVerts.push(v);
      }
    }

    // Insert CDT constraints between consecutive boundary vertices
    for (let i = 0; i < boundaryVerts.length; i++) {
      const v1 = boundaryVerts[i];
      const v2 = boundaryVerts[(i + 1) % boundaryVerts.length];
      this.cdt.insertConstraint(v1, v2);
    }

    // Store polygon info for marking interior edges after triangulation
    this.obstaclePolygons.push({ vertices: boundaryVerts, clusterId });
  }

  generateTestVertices(count: number): void {
    const size = Math.max(this.b2x - this.b1x, this.b2y - this.b1y);
    const cs = 3 * DEFAULT_PIN_RADIUS;
    const cell = new Set<string>();

    // Corner vertices
    for (const x of [this.b1x, this.b2x]) {
      for (const y of [this.b1y, this.b2y]) {
        this.insertVertex('corner', x, y);
        cell.add(`${Math.floor(x / cs)}_${Math.floor(y / cs)}`);
      }
    }

    let id = 4;
    let attempts = 0;
    while (id < count && attempts < count * 100) {
      attempts++;
      const margin = size / 100;
      const r1 = this.b1x + margin + Math.random() * (size - 2 * margin);
      const r2 = this.b1y + margin + Math.random() * (size - 2 * margin);
      const cellKey = `${Math.floor(r1 / cs)}_${Math.floor(r2 / cs)}`;
      if (!cell.has(cellKey)) {
        cell.add(cellKey);
        this.insertVertex('', r1, r2);
        id++;
      }
    }
  }

  generateNetlist(connections: { from: string; to: string; traceWidth?: number; traceClearance?: number }[]): void {
    this.netlist = [];
    for (const conn of connections) {
      const nd = new NetDesc(
        conn.from, conn.to,
        conn.traceWidth ?? DEFAULT_TRACE_WIDTH,
        conn.traceClearance ?? DEFAULT_CLEARANCE
      );
      // Calculate priority (distance squared)
      const v1 = this.vertices.find(v => v.name === conn.from);
      const v2 = this.vertices.find(v => v.name === conn.to);
      if (v1 && v2) {
        nd.pri = (v2.x - v1.x) ** 2 + (v2.y - v1.y) ** 2;
      }
      this.netlist.push(nd);
    }
  }

  sortNetlist(): void {
    this.netlist.sort((a, b) => a.pri - b.pri);
  }

  async finishInit(): Promise<void> {
    await this.cdt.triangulate();

    this.vertices = [];
    this.regions = [];

    this.cdt.forEach(v => {
      this.vertices.push(v);
    });

    // Create regions
    for (const v of this.vertices) {
      while (this.regions.length <= v.id) this.regions.push(null as any);
      this.regions[v.id] = new Region(v);
    }

    // Set up region neighbors from CDT edges
    for (const v of this.vertices) {
      const region = this.regions[v.id];
      if (!region) continue;
      for (const n of v.neighbors) {
        const nRegion = this.regions[n.id];
        if (nRegion && !region.neighbors.includes(nRegion)) {
          region.neighbors.push(nRegion);
        }
      }
    }

    // Set up cuts
    this.newcuts = new SymmetricMap();
    for (const v of this.vertices) {
      for (const n of v.neighbors) {
        if (!this.newcuts.has(v, n)) {
          this.newcuts.set(v, n, new Cut(v, n));
        }
      }
    }

    // Mark interior edges of obstacle polygons as blocked
    this.edgesInCluster = new SymmetricMap();
    this.cdt.edgesInConstrainedPolygons((v1, v2) => {
      this.edgesInCluster.set(v1, v2, true);
    });

    this.emitDebug({
      type: 'cdt',
      description: `CDT: ${this.vertices.length} vertices, ${this.vertices.reduce((s, v) => s + v.neighbors.length, 0) / 2 | 0} edges`
    });
  }

  generateRandomNetlist(netCount: number): void {
    const eligible = this.vertices.filter(v => v.name !== 'border' && v.name !== 'corner');
    const pairs = [];
    for (let i = 0; i < eligible.length; i += 2) {
      if (i + 1 < eligible.length) {
        pairs.push([eligible[i], eligible[i + 1]]);
      }
    }
    pairs.sort((a, b) => {
      const da = (a[0].x - a[1].x) ** 2 + (a[0].y - a[1].y) ** 2;
      const db = (b[0].x - b[1].x) ** 2 + (b[0].y - b[1].y) ** 2;
      return da - db;
    });

    this.netlist = [];
    for (let i = 0; i < Math.min(netCount, pairs.length); i++) {
      const [v1, v2] = pairs[i];
      v1.name = `${i}s`;
      v2.name = `${i}e`;
      v1.numInets++;
      v2.numInets++;
      const nd = new NetDesc(v1.name, v2.name);
      nd.pri = (v2.x - v1.x) ** 2 + (v2.y - v1.y) ** 2;
      this.netlist.push(nd);
    }
  }

  // Get neighbors in inner angle between a and b at n
  // Original Ruby: uses raw vertex coords (a.vertex, b.vertex, n.vertex)
  private newBorList(a: Region, b: Region, n: Region): Vertex[] {
    const av = a.vertex;
    const bv = b.vertex;
    const nv = n.vertex;
    // Original: a, b, n = a.vertex, b.vertex, n.vertex -- all raw coords
    const ax = av.x - nv.x;
    const ay = av.y - nv.y;
    const bx = bv.x - nv.x;
    const by = bv.y - nv.y;

    // Original: RBR::xboolean_really_smart_cross_product_2d_with_offset(aa, bb, nn)
    // where aa, bb, nn are the original Region objects -- uses rx, ry
    const turn = booleanCrossProduct2D(a.rx, a.ry, b.rx, b.ry, n.vertex.x, n.vertex.y);

    return nv.neighbors.filter(el => {
      if (el === av || el === bv) return false;
      const ex = el.x - nv.x;
      const ey = el.y - nv.y;
      if (turn) {
        return ax * ey > ay * ex && ex * by > ey * bx;
      } else {
        return ax * ey < ay * ex && ex * by < ey * bx;
      }
    });
  }

  // Split neighbor list into left and right of path
  // Returns [right_of_path, left_of_path]
  // Original Ruby: nx = n.vertex.x, v1x = a.rx - nx (raw vertex origin, rx for directions)
  private fullSplitNeighborList(a: Region, b: Region, n: Region): [Region[], Region[]] {
    const l: Region[] = [];
    const r: Region[] = [];
    const nx = n.vertex.x;
    const ny = n.vertex.y;
    const v1x = a.rx - nx;
    const v1y = a.ry - ny;
    const v2x = b.rx - nx;
    const v2y = b.ry - ny;
    const turn = booleanCrossProduct2D(a.rx, a.ry, b.rx, b.ry, nx, ny);

    for (const el of n.neighbors) {
      if (el === a || el === b) continue;
      const ex = el.rx - nx;
      const ey = el.ry - ny;
      if (turn ? (v1x * ey > v1y * ex && v2x * ey < v2y * ex) : (v1x * ey > v1y * ex || v2x * ey < v2y * ex)) {
        l.push(el);
      } else {
        r.push(el);
      }
    }
    return [r, l];
  }

  /**
   * Dijkstra's shortest path search along CDT edges
   * Modified with inner/outer lanes to prevent trace crossings
   */
  private dijkstra(
    startNode: Region,
    endNodeName: string,
    netDesc: NetDesc,
    maxDetourFactor: number = 2
  ): Region[] | null {
    type Key = string;
    const makeKey = (v: Region, u: Region | null, rgt: boolean): Key =>
      `${v.regionId}_${u?.regionId ?? 'null'}_${rgt}`;

    const q = new PriorityQueue<Key>();
    const distances = new Map<Key, number>();
    const parents = new Map<Key, Key>();
    const outerLane = new Map<Key, boolean>();
    const keyToRegion = new Map<Key, [Region, Region | null, boolean]>();

    const startCid = startNode.vertex.cid;

    // Initialize start
    for (const rgt of [true, false]) {
      const key = makeKey(startNode, null, rgt);
      distances.set(key, 0);
      keyToRegion.set(key, [startNode, null, rgt]);
    }

    // Initial steps
    startNode.qbors(null, (w, _useInner, _useOuter) => {
      const dist = (startCid !== -1 && w.vertex.cid === startCid) ? 0 :
        Math.hypot(w.vertex.x - startNode.vertex.x, w.vertex.y - startNode.vertex.y);

      for (const rgt of [true, false]) {
        const key = makeKey(w, startNode, rgt);
        keyToRegion.set(key, [w, startNode, rgt]);
        q.push(key, dist);
        parents.set(key, makeKey(startNode, null, false));
      }
    });

    let minKey: Key | null = null;
    let minRegion: [Region, Region | null, boolean] | null = null;

    while (true) {
      const result = q.pop();
      if (!result) return null;

      minKey = result.key;
      const oldDistance = result.priority;
      const [v, uu, prevRgt] = keyToRegion.get(minKey)!;

      if (!uu) continue;

      const hhRadius = (uu === startNode || (uu.vertex.cid === startCid && startCid !== -1))
        ? 0
        : uu.vertex.radius + Math.max(uu.vertex.separation, netDesc.traceClearance) + netDesc.traceWidth * 0.5;

      // Compute popom (parent of parent) — needed for both destination check and uv_blocked
      const parentKey = parents.get(minKey);
      const parentReg = parentKey ? keyToRegion.get(parentKey) : null;
      const popom = parentReg ? (parents.get(parentKey!) ? keyToRegion.get(parents.get(parentKey!)!)?.at(0) : null) : null;
      const popomVertex = (popom as Region | null | undefined)?.vertex ?? null;

      // Check if we reached destination
      if (v.vertex.name === endNodeName && v.incident) {
        const tangent = getTangents(
          uu.vertex.x, uu.vertex.y, hhRadius, prevRgt,
          v.vertex.x, v.vertex.y, 0, false
        );

        let blocked = false;
        const commonNeighbors = uu.vertex.neighbors.filter(n => v.vertex.neighbors.includes(n));
        for (const el of commonNeighbors) {
          // Ruby: el.cid == -1 || (el.cid != uu.vertex.cid && el.cid != v.vertex.cid) && el != popom
          // && binds tighter than || in Ruby, so: cid==-1 || ((cid!=uu_cid && cid!=v_cid) && el!=popom)
          if (el.cid === -1 || ((el.cid !== uu.vertex.cid && el.cid !== v.vertex.cid) && el !== popomVertex)) {
            const minDist = (el.radius + Math.max(el.separation, netDesc.traceClearance) + netDesc.traceWidth * 0.5) ** 2;
            if (normalDistanceLineSegmentPointSquared(
              tangent[0], tangent[1], tangent[2], tangent[3], el.x, el.y, MBD
            ) < minDist) {
              blocked = true;
              break;
            }
          }
        }
        if (blocked) continue;

        // Reject overly long paths
        if (oldDistance > 10 * AVD &&
          oldDistance > maxDetourFactor * Math.hypot(v.vertex.x - startNode.vertex.x, v.vertex.y - startNode.vertex.y)) {
          return null;
        }

        minRegion = [v, uu, prevRgt];
        break;
      }

      distances.set(minKey, oldDistance);
      const [x, y] = [v.vertex.x, v.vertex.y];

      // Build path set to prevent loops — Ruby uses Region identity, not vertex id
      const pathSet = new Set<Region>();
      let p: Key | undefined = minKey;
      while (p) {
        const reg = keyToRegion.get(p);
        if (reg) pathSet.add(reg[0]);
        p = parents.get(p);
      }

      // Check if u-v path touches vertices for inner/outer
      const uvBlocked: boolean[] = [false, false];
      let blockingVertex: Vertex | null = null; // Ruby line 1100

      for (let bi = 0; bi < 2; bi++) {
        const b = bi === 1;
        const tangent = getTangents(
          uu.vertex.x, uu.vertex.y, hhRadius, prevRgt,
          v.vertex.x, v.vertex.y,
          v.vertex.radius + Math.max(v.vertex.separation, netDesc.traceClearance) + netDesc.traceWidth * 0.5,
          b
        );
        const commonNeighbors = uu.vertex.neighbors.filter(n => v.vertex.neighbors.includes(n));
        for (const el of commonNeighbors) {
          if ((el.cid === -1 || (el.cid !== uu.vertex.cid && el.cid !== v.vertex.cid)) && el !== popomVertex) {
            const minDist = (el.radius + Math.max(el.separation, netDesc.traceClearance) + netDesc.traceWidth * 0.5) ** 2;
            if (normalDistanceLineSegmentPointSquared(
              tangent[0], tangent[1], tangent[2], tangent[3], el.x, el.y, MBD
            ) < minDist) {
              uvBlocked[bi] = true;
              // Ruby lines 1111-1114: track blocking vertex for relaxation
              if (blockingVertex) {
                blockingVertex = null; // both directions blocked, no relaxation
              } else {
                blockingVertex = el;
              }
              break;
            }
          }
        }
      }

      // Explore neighbors - original Ruby line 1124: v.qbors(u)
      // u is always the predecessor region, NEVER null (null only for initial start_node.qbors)
      v.qbors(uu, (w, useInner, useOuter) => {
        if (this.edgesInCluster.has(v.vertex, w.vertex)) return;
        if (pathSet.has(w)) return;
        const onlyOuter = !useInner;
        const vcid = v.vertex.cid;

        // Original: RBR::xboolean_really_smart_cross_product_2d_with_offset(u, w, v)
        // Uses rx,ry for directions but vertex.x,vertex.y for origin
        const lrTurn = booleanCrossProduct2D(uu.rx, uu.ry, w.rx, w.ry, v.vertex.x, v.vertex.y);
        const curRgt = lrTurn;

        // Free walk in start cluster
        if (startCid !== -1 && vcid === startCid && w.vertex.cid === startCid) {
          for (const rgtVal of [curRgt, !curRgt]) {
            const key = makeKey(w, v, rgtVal);
            keyToRegion.set(key, [w, v, rgtVal]);
            if (!distances.has(key)) {
              if (q.decreaseKey(key, oldDistance)) {
                parents.set(key, minKey!);
              }
            }
          }
          return;
        }

        if (onlyOuter && vcid > -1) return;

        let newDistance = oldDistance + Math.hypot(w.vertex.x - x, w.vertex.y - y);
        // Heavy penalty for routing through boundary or obstacle vertices
        if (w.vertex.name === 'border' || w.vertex.name === 'corner' || w.vertex.name === 'obstacle_boundary') {
          newDistance += MBD;
        }
        const outerDistance = newDistance;

        // Try inner path
        let canOut = onlyOuter;
        const wvRgtKey = makeKey(w, v, curRgt);
        keyToRegion.set(wvRgtKey, [w, v, curRgt]);

        if (!canOut && !distances.has(wvRgtKey)) {
          let blocked = false;
          const lcuts = this.newBorList(uu, w, v);

          // Check cluster corners — Ruby line 1176: two OR'd conditions
          if (vcid >= 0) {
            if (lcuts.find(el => el.cid === vcid) ||
                (uu.vertex.cid === vcid && w.vertex.cid === vcid && lcuts.length === 0)) {
              canOut = true;
              blocked = true;
            }
          }

          if (!blocked) {
            // Check incident nets
            for (const inet of v.vertex.incidentNets) {
              const step = inet.nstep || inet.pstep;
              if (step && lcuts.includes(step.vertex)) {
                if (vcid === -1) canOut = true;
                blocked = true;
                break;
              }
              if (step && !(step.nstep && step.pstep) && (curRgt !== prevRgt) && step.vertex === uu.vertex) {
                blocked = true;
                break;
              }
            }
          }

          // Ruby line 1188: uvBlocked check with blockingVertex relaxation
          if (!blocked && uvBlocked[curRgt ? 1 : 0] && blockingVertex !== w.vertex) {
            blocked = true;
          }

          if (!blocked) {
            // Check squeeze
            let squeeze = 0;
            for (const el of lcuts) {
              const cut = this.newcuts.get(v.vertex, el);
              if (!cut) continue;
              const h = cut.squeezeStrength(netDesc.traceWidth, netDesc.traceClearance);
              if (h >= MBD) { squeeze = MBD; break; }
              squeeze += h;
            }

            if (squeeze < MBD) {
              if (uu !== startNode && curRgt !== prevRgt) {
                const uvCut = this.newcuts.get(v.vertex, uu.vertex);
                if (uvCut) {
                  squeeze += uvCut.squeezeStrength(netDesc.traceWidth, netDesc.traceClearance);
                }
              }
            }

            if (squeeze < MBD) {
              // Ruby lines 1193-1210: distance shortcut optimization
              const pomDist = parentKey ? (distances.get(parentKey) ?? 0) : 0;
              const uwCut = this.newcuts.get(w.vertex, uu.vertex);
              if (uwCut) {
                const nd = (newDistance + pomDist + uwCut.cap) / 2;
                if (nd < newDistance) {
                  newDistance = Math.max(nd, oldDistance);
                }
              } else if (lcuts.length > 0) {
                // Find nearest vertex in inner angle
                let nv: Vertex | null = null;
                let nvCap = Infinity;
                for (const el of lcuts) {
                  const c = this.newcuts.get(v.vertex, el);
                  if (c && c.cap < nvCap) { nvCap = c.cap; nv = el; }
                }
                if (nv) {
                  let nd: number;
                  if (pointInTriangle(
                    uu.vertex.x, uu.vertex.y, v.vertex.x, v.vertex.y,
                    w.vertex.x, w.vertex.y, nv.x, nv.y
                  ) >= 0) {
                    nd = Math.hypot(uu.vertex.x - nv.x, uu.vertex.y - nv.y) +
                         Math.hypot(w.vertex.x - nv.x, w.vertex.y - nv.y);
                  } else {
                    nd = Math.hypot(uu.vertex.x - w.vertex.x, uu.vertex.y - w.vertex.y);
                  }
                  nd = (newDistance + pomDist + nd) / 2;
                  if (nd < newDistance) {
                    newDistance = Math.max(nd, oldDistance);
                  }
                }
              }

              if (curRgt !== prevRgt) newDistance += AVD;
              newDistance += squeeze;

              if (q.decreaseKey(wvRgtKey, newDistance)) {
                outerLane.set(wvRgtKey, false);
                parents.set(wvRgtKey, minKey!);
              }
            }
          }
        }

        // Try outer path
        if (useOuter) {
          const wvXrgtKey = makeKey(w, v, !curRgt);
          keyToRegion.set(wvXrgtKey, [w, v, !curRgt]);

          if (!distances.has(wvXrgtKey)) {
            let outerNewDistance = outerDistance;
            let blocked = false;

            // Check squeeze on outer side
            const lcuts = this.newBorList(uu, w, v);
            const outerCuts = v.vertex.neighbors.filter(
              n => !lcuts.includes(n) && n !== uu.vertex && n !== w.vertex
            );

            let squeeze = 0;
            for (const el of outerCuts) {
              const cut = this.newcuts.get(v.vertex, el);
              if (!cut) continue;
              const h = cut.squeezeStrength(netDesc.traceWidth, netDesc.traceClearance);
              if (h >= MBD) { squeeze = MBD; break; }
              squeeze += h;
            }

            if (squeeze >= MBD) blocked = true;

            if (!blocked && uu !== startNode && !curRgt !== prevRgt) {
              const uvCut = this.newcuts.get(v.vertex, uu.vertex);
              if (uvCut) {
                squeeze += uvCut.squeezeStrength(netDesc.traceWidth, netDesc.traceClearance);
                if (squeeze >= MBD) blocked = true;
              }
            }

            // Ruby line 1229: uvBlocked check with blockingVertex relaxation (outer uses !curRgt)
            if (!blocked && uvBlocked[curRgt ? 0 : 1] && blockingVertex !== w.vertex) {
              blocked = true;
            }

            if (!blocked) {
              // Check incident nets (Ruby lines 1231-1233)
              for (const inet of v.vertex.incidentNets) {
                const step = inet.nstep || inet.pstep;
                if (step && outerCuts.includes(step.vertex)) {
                  blocked = true;
                  break;
                }
                // Ruby line 1233: check for single-ended incident net
                if (step && !(step.nstep && step.pstep) && (!curRgt !== prevRgt) && step.vertex === uu.vertex) {
                  blocked = true;
                  break;
                }
              }
            }

            if (!blocked) {
              if (!curRgt !== prevRgt) outerNewDistance += AVD;
              outerNewDistance += squeeze;

              if (q.decreaseKey(wvXrgtKey, outerNewDistance)) {
                outerLane.set(wvXrgtKey, true);
                parents.set(wvXrgtKey, minKey!);
              }
            }
          }
        }
      });
    }

    if (!minRegion) return null;

    // Reconstruct path - matching original Ruby lines 1245-1255
    // Original: n[0].outer = outer_lane[p]; n[0].lr_turn = p[2] == outer_lane[p]
    // n = parents[p] (parent key), n[0] = parent's region
    // p[2] = current rgt, outer_lane[p] = current's outer flag
    const path: Region[] = [];
    let p: Key | undefined = minKey!;
    while (p) {
      const pReg = keyToRegion.get(p);
      if (pReg) {
        const n = parents.get(p); // parent key
        if (n) {
          const nReg = keyToRegion.get(n);
          if (nReg) {
            // Assign to PARENT region, using CURRENT key's data
            const pOuter = outerLane.get(p) ?? false;
            nReg[0].outer = pOuter;
            nReg[0].lrTurn = (pReg[2] === pOuter); // p[2] == outer_lane[p]
          }
        }
        path.push(pReg[0]);
      }
      p = parents.get(p);
    }

    // Strip start cluster edges
    const cid = path[path.length - 1]?.vertex.cid;
    if (cid !== undefined && cid !== -1) {
      while (path.length > 2 && path[path.length - 2]?.vertex.cid === cid) {
        path.pop();
      }
    }

    this.dijkstraUsePath(path, netDesc);
    return path;
  }

  private dijkstraUsePath(path: Region[], netDesc: NetDesc): void {
    for (let i = 0; i < path.length - 2; i++) {
      const u = path[i];
      const v = path[i + 1];
      const w = path[i + 2];

      let lcuts: Vertex[];
      if (u.vertex === w.vertex) {
        lcuts = [];
      } else {
        lcuts = this.newBorList(u, w, v);
      }

      if (v.outer) {
        lcuts = v.vertex.neighbors.filter(
          n => !lcuts.includes(n) && n !== u.vertex && n !== w.vertex
        );
      }

      for (const el of lcuts) {
        const cut = this.newcuts.get(v.vertex, el);
        if (cut) cut.use(netDesc.traceWidth, netDesc.traceClearance);
      }

      if (i > 0 && (u.outer === u.lrTurn) !== (v.outer === v.lrTurn)) {
        const uvCut = this.newcuts.get(u.vertex, v.vertex);
        if (uvCut) uvCut.use(netDesc.traceWidth, netDesc.traceClearance);
      }
    }

    if (path.length > 0) {
      path[0].outer = null;
      path[0].lrTurn = null;
    }
    if (path.length > 1) {
      path[path.length - 1].outer = null;
      path[path.length - 1].lrTurn = null;
    }
  }

  /**
   * Route a net - the main routing function
   * Finds path via Dijkstra, then splits regions along the path
   */
  route(netId: number, maxDetourFactor: number = 2): boolean {
    if (netId < 0 || netId >= this.netlist.length) return false;
    const netDesc = this.netlist[netId];
    const from = netDesc.t1Name;
    const to = netDesc.t2Name;

    const startNode = this.regions.find(r => r && r.incident && r.vertex.name === from);
    if (!startNode) return false;

    const path = this.dijkstra(startNode, to, netDesc, maxDetourFactor);
    if (!path) return false;

    // Emit debug: dijkstra found path
    this.emitDebug({
      type: 'dijkstra_found',
      description: `Net ${netId} (${from}\u2192${to}): Dijkstra found path through ${path.length} vertices`,
      highlight: {
        path: path.map(r => ({ x: r.vertex.x, y: r.vertex.y })),
        vertices: path.map(r => ({ x: r.vertex.x, y: r.vertex.y, color: '#ffeb3b', label: r.vertex.name }))
      }
    });

    const first = path[path.length - 1];
    const last = path[0];
    if (first === last) return false;

    // Record direction info
    if (path.length > 2) {
      first.idirs.push([path[path.length - 2].rx - first.vertex.x, path[path.length - 2].ry - first.vertex.y]);
      last.idirs.push([path[1].rx - last.vertex.x, path[1].ry - last.vertex.y]);
    }

    // Split regions along the path
    let r1: Region | null = null;
    let r2: Region | null = null;
    const reversedPath = [...path].reverse();

    for (let idx = 0; idx < reversedPath.length - 2; idx++) {
      const prv = reversedPath[idx];
      const cur = reversedPath[idx + 1];
      const nxt = reversedPath[idx + 2];

      const [ne, neComp] = this.fullSplitNeighborList(prv, nxt, cur);
      ne.push(nxt);
      neComp.push(nxt);

      if (r1) {
        const r2idx = ne.indexOf(r2!);
        if (r2idx >= 0) ne.splice(r2idx, 1);
        const r1idx = neComp.indexOf(r1);
        if (r1idx >= 0) neComp.splice(r1idx, 1);
      } else {
        ne.push(prv);
        neComp.push(prv);
      }

      // Remove cur from regions
      const curIdx = this.regions.indexOf(cur);
      if (curIdx >= 0) this.regions.splice(curIdx, 1);

      // Create split regions
      r1 = new Region(cur.vertex);
      r2 = new Region(cur.vertex);
      r1.idirs = [...cur.idirs];
      r2.idirs = [...cur.idirs];
      r1.odirs = [...cur.odirs];
      r2.odirs = [...cur.odirs];
      r1.incident = cur.incident;
      r2.incident = cur.incident;

      // Compute offset perpendicular to path
      let dx1 = 0, dy1 = 0, dx2 = 0, dy2 = 0;
      if (prv === first) {
        dx2 = cur.rx - prv.rx;
        dy2 = cur.ry - prv.ry;
        const h = Math.hypot(dx2, dy2);
        if (h > 0) { dx2 /= h; dy2 /= h; }
      }
      if (nxt === last) {
        dx1 = nxt.rx - cur.rx;
        dy1 = nxt.ry - cur.ry;
        const h = Math.hypot(dx1, dy1);
        if (h > 0) { dx1 /= h; dy1 /= h; }
      }

      if (prv === first || nxt === last) {
        r1.g = r2.g = cur.g * 0.5;
        let dy = dx1 + dx2;
        let dx = -(dy1 + dy2);
        const h = Math.hypot(dx, dy) / cur.g;
        if (h > 0) {
          dx /= h;
          dy /= h;
          r1.ox = cur.ox + dx;
          r1.oy = cur.oy + dy;
          r2.ox = cur.ox - dx;
          r2.oy = cur.oy - dy;
        } else {
          r1.ox = cur.ox;
          r1.oy = cur.oy;
          r2.ox = cur.ox;
          r2.oy = cur.oy;
        }
        r1.rx = r1.vertex.x + r1.ox;
        r1.ry = r1.vertex.y + r1.oy;
        r2.rx = r2.vertex.x + r2.ox;
        r2.ry = r2.vertex.y + r2.oy;
      } else {
        r1.ox = cur.ox;
        r1.oy = cur.oy;
        r2.ox = cur.ox;
        r2.oy = cur.oy;
        r1.rx = cur.rx;
        r1.ry = cur.ry;
        r2.rx = cur.rx;
        r2.ry = cur.ry;
      }

      this.regions.push(r1, r2);

      // Update neighbor connections
      for (const el of cur.neighbors) {
        const idx2 = el.neighbors.indexOf(cur);
        if (idx2 >= 0) el.neighbors.splice(idx2, 1);
      }
      for (const el of ne) {
        el.neighbors.push(r1);
        r1.neighbors.push(el);
      }
      for (const el of neComp) {
        el.neighbors.push(r2);
        r2.neighbors.push(el);
      }

      // Set incident based on turn/outer
      if (cur.lrTurn !== cur.outer) {
        r1.incident = false;
      } else {
        r2.incident = false;
      }

      // Track outer directions
      if (cur.outer) {
        // Compute perpendicular direction
        const dxP = nxt.rx - cur.rx;
        const dyP = nxt.ry - cur.ry;
        const dxM = cur.rx - prv.rx;
        const dyM = cur.ry - prv.ry;
        const hP = Math.hypot(dxP + dxM, dyP + dyM);
        if (hP > 0) {
          const perpDx = -(dyP + dyM) / hP;
          const perpDy = (dxP + dxM) / hP;
          if (cur.lrTurn) {
            r2.odirs.push([perpDx, perpDy]);
          } else {
            r1.odirs.push([-perpDx, -perpDy]);
          }
        }
      }
    }

    // Emit debug: region split complete
    this.emitDebug({
      type: 'region_split',
      description: `Net ${netId}: Split ${path.length - 2} regions along path`
    });

    // Create steps for the path
    let pstep: Step | null = null;
    for (let i = 0; i < path.length; i++) {
      const cur = path[i];
      const nxt = i < path.length - 1 ? path[i + 1] : null;
      const prv = i > 0 ? path[i - 1] : null;
      const nv = nxt?.vertex ?? null;
      const pv = prv?.vertex ?? null;
      const cv = cur.vertex;

      const step = new Step(pv, nv, this.pathId);
      step.outer = cur.outer ?? false;
      step.lrTurn = !(cur.lrTurn ?? false);
      step.netDesc = netDesc;
      step.vertex = cv;
      step.pstep = pstep;
      pstep = step;

      if (prv && nxt) {
        cv.update(step);
        cv.unfriendlyResize();
        // Ruby: step.rgt = step.outer != cur.lr_turn (XOR)
        // step.lrTurn is !(cur.lrTurn), so step.outer !== step.lrTurn is XNOR
        // Fix: use cur.lrTurn directly for the XOR
        step.rgt = (step.outer !== (cur.lrTurn ?? false));
        step.xt = !step.outer;
        cv.attachedNets.push(step);
      } else {
        step.rgt = false;
        cv.incidentNets.push(step);
      }
    }

    this.pathId++;

    // Link steps
    while (pstep?.pstep) {
      pstep.pstep.nstep = pstep;
      pstep = pstep.pstep;
    }

    return true;
  }

  // Sort attached nets for all vertices
  sortAttachedNets(): void {
    for (const v of this.vertices) {
      v.sortAttachedNets();
    }
    this.emitDebug({
      type: 'sort_attached',
      description: `Sorted attached nets at ${this.vertices.filter(v => v.attachedNets.length > 1).length} vertices`
    });
  }

  // Prepare step radii
  prepareSteps(): void {
    for (const vert of this.vertices) {
      if (vert.attachedNets.length === 0) continue;
      vert.resetInitialSize();
      for (const b of [true, false]) {
        for (const step of vert.attachedNets) {
          if (step.xt === b) continue;
          const net = step.netDesc;
          const traceSep = Math.max(vert.separation, net.traceClearance);
          vert.radius += traceSep + net.traceWidth;
          step.radius = vert.radius - net.traceWidth * 0.5;
          vert.separation = net.traceClearance;
        }
      }
    }
    this.generateDrawnSegments();
    this.emitDebug({
      type: 'prepare_steps',
      description: `Prepared step radii for ${this.vertices.filter(v => v.attachedNets.length > 0).length} vertices`
    });
  }

  // Check if tangents cross (for concave collapse)
  private convexKkk(prevStep: Step, step: Step, nxtStep: Step): [number, number] | null {
    const pv = step.prev!;
    const cv = step.vertex;
    const nv = step.next!;

    const [x1, y1, x2, y2] = getTangents(pv.x, pv.y, prevStep.radius, prevStep.rgt, cv.x, cv.y, step.radius, step.rgt);
    const [x3, y3, x4, y4] = getTangents(cv.x, cv.y, step.radius, step.rgt, nv.x, nv.y, nxtStep.radius, nxtStep.rgt);

    // Line-line intersection (inline)
    const d = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1);
    if (d === 0) return null;
    const ua = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / d;
    const ub = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / d;
    const ix = x1 + ua * (x2 - x1);
    const iy = y1 + ua * (y2 - y1);

    if ((ua > 0 && ua < 1) || (ub > 0 && ub < 1)) {
      return [ix, iy];
    }
    return null;
  }

  /**
   * Rubberband optimization: adjust step radii, collapse concave bends
   */
  nubly(collapse: boolean = false): void {
    let nublyPass = 0;
    let replaced = true;
    while (replaced) {
      replaced = false;
      nublyPass++;
      for (const cv of this.vertices) {
        for (let si = cv.attachedNets.length - 1; si >= 0; si--) {
          const step = cv.attachedNets[si];
          if (!step) continue;
          const prevStep = step.pstep;
          const nxtStep = step.nstep;
          if (!prevStep || !nxtStep) continue;
          if (!step.prev || !step.next) continue;

          const pv = step.prev;
          const nv = step.next;

          // Check if radius difference is too large for distance
          let d = Math.hypot(cv.x - pv.x, cv.y - pv.y) - Math.abs(prevStep.radius - step.radius) * 1.02;
          if (d < 0) {
            if (step.radius < prevStep.radius) {
              step.radius -= d;
              replaced = true;
            }
            continue;
          }
          d = Math.hypot(cv.x - nv.x, cv.y - nv.y) - Math.abs(nxtStep.radius - step.radius) * 1.02;
          if (d < 0) {
            if (step.radius < nxtStep.radius) {
              step.radius -= d;
              replaced = true;
            }
            continue;
          }

          const kkk = this.convexKkk(prevStep, step, nxtStep);
          step.xt = kkk !== null;

          if (collapse && step.xt && kkk) {
            // Full nubly collapse with Apollonius hull (Ruby lines 1853-1906)
            const pv = step.prev!;
            const nv = step.next!;
            const hv0 = new Vertex(kkk[0], kkk[1]);
            replaced = true;
            const pvx = pv.x, pvy = pv.y, nvx = nv.x, nvy = nv.y;

            let ppv: Vertex;
            const pp = prevStep.pstep;
            if (pp) {
              const ppKkk = this.convexKkk(pp, prevStep, step);
              ppv = ppKkk ? new Vertex(ppKkk[0], ppKkk[1]) : pv;
            } else { ppv = pv; }

            let nnv: Vertex;
            const nn = nxtStep.nstep;
            if (nn) {
              const nnKkk = this.convexKkk(step, nxtStep, nn);
              nnv = nnKkk ? new Vertex(nnKkk[0], nnKkk[1]) : nv;
            } else { nnv = nv; }

            let hx = nvx - pvx, hy = nvy - pvy;
            let vec_x: number, vec_y: number;
            if (step.rgt) { vec_x = hy; vec_y = -hx; }
            else { vec_x = -hy; vec_y = hx; }
            const hv3 = new Vertex(pvx + hx * 0.5 + vec_x, pvy + hy * 0.5 + vec_y);
            hx *= 2; hy *= 2; vec_x *= 2; vec_y *= 2;
            const hv4 = new Vertex(pvx - hx + vec_x, pvy - hy + vec_y);
            const hv5 = new Vertex(nvx + hx + vec_x, nvy + hy + vec_y);

            let rep = verticesInPolygon(
              [ppv, hv0, nnv, hv3],
              this.vertices
            ).filter(v => v !== pv && v !== nv && v !== ppv && v !== cv && v !== nnv && v !== hv3);

            // Debug: emit collapse step with polygon and candidates
            if (this.onDebugStep) {
              this.generateDrawnSegments();
              const polyVerts = [ppv, hv0, nnv, hv3].map(v => ({ x: v.x, y: v.y, color: '#ff0' }));
              const candidateVerts = rep.map(v => ({ x: v.x, y: v.y, color: '#0ff', label: v.name }));
              this.emitDebug({
                type: 'nubly_collapse',
                description: `Collapse at ${cv.name || cv.id}: tangents cross, ${rep.length} candidates in polygon. prev=${pv.name||pv.id}, next=${nv.name||nv.id}`,
                highlight: {
                  vertices: [
                    { x: cv.x, y: cv.y, color: '#f00', label: 'collapse' },
                    { x: pv.x, y: pv.y, color: '#0f0', label: 'prev' },
                    { x: nv.x, y: nv.y, color: '#0f0', label: 'next' },
                    { x: kkk[0], y: kkk[1], color: '#ff0', label: 'tangent crossing' },
                    ...polyVerts,
                    ...candidateVerts,
                  ],
                  edges: [
                    // Search polygon outline
                    { x1: ppv.x, y1: ppv.y, x2: hv0.x, y2: hv0.y, color: '#ff0' },
                    { x1: hv0.x, y1: hv0.y, x2: nnv.x, y2: nnv.y, color: '#ff0' },
                    { x1: nnv.x, y1: nnv.y, x2: hv3.x, y2: hv3.y, color: '#ff0' },
                    { x1: hv3.x, y1: hv3.y, x2: ppv.x, y2: ppv.y, color: '#ff0' },
                  ]
                }
              });
            }

            if (rep.length > 0) {
              const net = step.netDesc;
              for (const v of rep) {
                v.trgt = !step.rgt;
                v.tradius = v.radius + Math.max(net.traceClearance, v.separation) + net.traceWidth * 0.5;
              }
              pv.trgt = prevStep.rgt;
              pv.tradius = prevStep.radius;
              nv.trgt = nxtStep.rgt;
              nv.tradius = nxtStep.radius;
              const hullInput = [...rep];
              rep = this.newConvexVertices(rep, pv, nv, hv4, hv5);

              // Debug: emit Apollonius hull result
              if (this.onDebugStep) {
                this.emitDebug({
                  type: 'apollonius_hull',
                  description: `Apollonius hull: ${hullInput.length} input -> ${rep.length} hull vertices`,
                  highlight: {
                    vertices: [
                      ...hullInput.map(v => ({ x: v.x, y: v.y, color: '#888', label: `r=${Math.round(v.tradius)}` })),
                      ...rep.map(v => ({ x: v.x, y: v.y, color: '#0ff', label: 'hull' })),
                      { x: pv.x, y: pv.y, color: '#0f0', label: 'prev' },
                      { x: nv.x, y: nv.y, color: '#0f0', label: 'next' },
                    ]
                  }
                });
              }
            }
            this.smartReplace(step, rep);
          }
        }
      }
      if (replaced) {
        this.generateDrawnSegments();
        this.emitDebug({
          type: 'nubly',
          description: `Rubberband pass ${nublyPass}: nubly(collapse=${collapse})`
        });
      }
    }
  }

  /**
   * Compute new convex vertices using Apollonius hull.
   * Port of Ruby new_convex_vertices (router.rb line 975-987).
   *
   * Takes candidate vertices, prev/next vertices (with tradius/trgt set),
   * and two helper boundary vertices. Computes the tangent line between
   * prev and next, adds tangent endpoints and helpers to the candidate set,
   * runs Apollonius convex hull, removes helpers, and sorts the result
   * along the tangent direction.
   */
  private newConvexVertices(vertices: Vertex[], prev: Vertex, nxt: Vertex, hv1: Vertex, hv2: Vertex): Vertex[] {
    if (vertices.length === 0) return vertices;

    // Compute tangent line between prev and next
    const [x1, y1, x2, y2] = getTangents(prev.x, prev.y, prev.tradius, prev.trgt, nxt.x, nxt.y, nxt.tradius, nxt.trgt);

    // Create tangent endpoint vertices
    const v1 = new Vertex(x1, y1, 0, 0);
    v1.tradius = 0;
    v1.trgt = false;
    const v2 = new Vertex(x2, y2, 0, 0);
    v2.tradius = 0;
    v2.trgt = false;

    // Set tradius for helper vertices (they have zero radius by default)
    hv1.tradius = 0;
    hv1.trgt = false;
    hv2.tradius = 0;
    hv2.trgt = false;

    // Add tangent endpoints and helpers to candidate set
    const allVerts = [...vertices, v1, v2, hv1, hv2];

    // Compute Apollonius convex hull
    const hullResult = apolloniusConvexHull(allVerts);

    // Remove helpers and tangent endpoints from result
    const excludeSet = new Set<Vertex>([v1, v2, hv1, hv2]);
    const filtered = hullResult.filter(v => !excludeSet.has(v));

    // Sort remaining hull vertices along the tangent line direction
    const dx = x2 - x1;
    const dy = y2 - y1;
    filtered.sort((a, b) => {
      const projA = (a.x - x1) * dx + (a.y - y1) * dy;
      const projB = (b.x - x1) * dx + (b.y - y1) * dy;
      return projA - projB;
    });

    return filtered;
  }

  private smartReplace(step: Step, list: Vertex[]): void {
    if (step.prev === step.next) {
      if (step.pstep && step.nstep?.nstep) {
        step.pstep.nstep = step.nstep.nstep;
        step.pstep.next = step.nstep.next;
        step.nstep.nstep.pstep = step.pstep;
        step.nstep.nstep.prev = step.prev;
        step.next?.deleteNet(step.nstep);
      }
    } else if (list.length === 0) {
      const ps = step.pstep;
      const ns = step.nstep;
      if (ps && ns) {
        ps.next = step.next;
        ns.prev = step.prev;
        ps.nstep = ns;
        ns.pstep = ps;
      }
    } else {
      let pstep = step.pstep!;
      let pv = step.prev;
      for (const v of list) {
        const n = new Step(pv, null, step.id);
        n.netDesc = step.netDesc;
        n.vertex = v;
        n.pstep = pstep;
        pstep.nstep = n;
        pstep.next = v;
        pstep = n;
        pv = v;
        n.rgt = !step.rgt;
        n.xt = true;
        n.outer = true;
        v.update(n);
        v.attachedNets.push(n);
      }
      pstep.next = step.next;
      pstep.nstep = step.nstep;
      if (pstep.nstep) {
        pstep.nstep.prev = pv;
        pstep.nstep.pstep = pstep;
      }
    }
    step.vertex.deleteNet(step);
  }

  /**
   * Generate all drawn segments for rendering
   */
  generateDrawnSegments(): DrawnSegment[] {
    this.drawnSegments = [];

    for (const vert of this.vertices) {
      for (const n of vert.incidentNets) {
        if (!n.next) continue;

        const thi = n.netDesc.traceWidth;
        let lr = 0;
        let lastx = 0, lasty = 0;
        let toVertex = n.next;
        let toNet = n.nstep;
        let lastNet: Step | null = null;

        while (toVertex && toNet) {
          lastNet = toNet.pstep;
          if (!lastNet) break;
          const last = lastNet.vertex;
          const radius = toNet.radius;

          if (last.x !== toVertex.x || last.y !== toVertex.y) {
            const t = getTangents(last.x, last.y, lr, lastNet.rgt, toVertex.x, toVertex.y, radius, toNet.rgt);
            this.drawnSegments.push({
              type: 'line',
              x1: t[0], y1: t[1], x2: t[2], y2: t[3],
              width: thi,
              netId: n.id,
              layer: 0
            });

            if (lr > 0) {
              let startAngle = Math.atan2(lasty - last.y, lastx - last.x);
              let endAngle = Math.atan2(t[1] - last.y, t[0] - last.x);
              if (!lastNet.rgt) [startAngle, endAngle] = [endAngle, startAngle];

              this.drawnSegments.push({
                type: 'arc',
                x1: t[0], y1: t[1], x2: t[2], y2: t[3],
                cx: last.x, cy: last.y,
                r: lr,
                startAngle, endAngle,
                width: thi,
                netId: n.id,
                layer: 0
              });
            }

            lastx = t[2];
            lasty = t[3];
          }

          lr = radius;
          toNet = toNet.nstep;
          if (toNet) {
            toVertex = toNet.vertex;
          } else {
            toVertex = null as any;
          }
        }
      }
    }

    return this.drawnSegments;
  }

  /**
   * Fix crossing pairs by swapping radius (ring position) at shared vertices.
   * Works iteratively: generate segments, find crossings, try swaps, repeat.
   */
  fixCrossingPairs(): number {
    let totalSwaps = 0;
    for (const vert of this.vertices) {
      if (vert.attachedNets.length < 2) continue;
      const steps = vert.attachedNets;

      // Helper: compute all tangent segments for a step at this vertex
      const stepTangents = (s: Step): [number, number, number, number][] => {
        if (!s.prev || !s.next || !s.pstep || !s.nstep) return [];
        const t1 = getTangents(s.prev.x, s.prev.y, s.pstep.radius, s.pstep.rgt, vert.x, vert.y, s.radius, s.rgt);
        const t2 = getTangents(vert.x, vert.y, s.radius, s.rgt, s.next.x, s.next.y, s.nstep.radius, s.nstep.rgt);
        return [t1, t2];
      };

      // Count total crossings involving this vertex's steps
      const totalCrossings = (): number => {
        let c = 0;
        for (let i = 0; i < steps.length; i++) {
          const ti = stepTangents(steps[i]);
          for (let j = i + 1; j < steps.length; j++) {
            if (steps[i].netDesc === steps[j].netDesc) continue;
            const tj = stepTangents(steps[j]);
            for (const a of ti)
              for (const b of tj)
                if (segmentsIntersect(a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3])) c++;
          }
        }
        return c;
      };

      // Try all pairwise radius swaps, keep ones that reduce total crossings
      let improved = true;
      let maxIter = steps.length * 3;
      while (improved && maxIter-- > 0) {
        improved = false;
        const before = totalCrossings();
        if (before === 0) break;

        for (let i = 0; i < steps.length && !improved; i++) {
          for (let j = i + 1; j < steps.length && !improved; j++) {
            if (steps[i].netDesc === steps[j].netDesc) continue;
            if (!steps[i].prev || !steps[j].prev) continue;

            // Swap radii
            const tmp = steps[i].radius;
            steps[i].radius = steps[j].radius;
            steps[j].radius = tmp;

            const after = totalCrossings();
            if (after < before) {
              improved = true;
              totalSwaps++;
            } else {
              // Revert
              steps[j].radius = steps[i].radius;
              steps[i].radius = tmp;
            }
          }
        }
      }
    }
    this.generateDrawnSegments();
    this.emitDebug({
      type: 'fix_crossings',
      description: `Fix crossings: ${totalSwaps} swaps, ${this.countCrossings()} crossings remaining`
    });
    return totalSwaps;
  }

  /** Capture minimal rendering state for debug snapshot */
  captureState(): Pick<DebugSnapshot, 'vertices' | 'edges' | 'regions' | 'segments' | 'cuts' | 'triangles'> {
    const vertices = this.vertices
      .filter(v => v.name !== 'border')
      .map(v => ({
        x: v.x, y: v.y, name: v.name, radius: v.core,
        isObstacle: v.name === 'obstacle_boundary' || v.cid >= 0
      }));

    const edges: { x1: number; y1: number; x2: number; y2: number }[] = [];
    for (const v of this.vertices) {
      for (const n of v.neighbors) {
        if (v.id < n.id) {
          edges.push({ x1: v.x, y1: v.y, x2: n.x, y2: n.y });
        }
      }
    }

    // Capture cut capacities
    const cuts: DebugSnapshot['cuts'] = [];
    const seenCuts = new Set<string>();
    for (const v of this.vertices) {
      for (const n of v.neighbors) {
        const key = Math.min(v.id, n.id) + '_' + Math.max(v.id, n.id);
        if (seenCuts.has(key)) continue;
        seenCuts.add(key);
        const cut = this.newcuts.get(v, n);
        if (cut) {
          cuts.push({
            x1: v.x, y1: v.y, x2: n.x, y2: n.y,
            cap: cut.cap, freeCap: cut.freeCap, usage: cut.cl.length
          });
        }
      }
    }

    const regions = this.regions.filter(r => r != null).map(r => ({
      x: r.vertex.x, y: r.vertex.y,
      rx: r.rx, ry: r.ry,
      incident: r.incident,
      neighborCount: r.neighbors.length,
      name: r.vertex.name || String(r.vertex.id),
      regionId: (r as any).regionId ?? r.vertex.id,
    }));

    // Reconstruct triangles from CDT edges for Voronoi-style region rendering
    const triangles: { x1: number; y1: number; x2: number; y2: number; x3: number; y3: number }[] = [];
    for (const v of this.vertices) {
      for (let i = 0; i < v.neighbors.length; i++) {
        const a = v.neighbors[i];
        for (let j = i + 1; j < v.neighbors.length; j++) {
          const b = v.neighbors[j];
          if (a.neighbors.includes(b) && v.id < a.id && v.id < b.id) {
            triangles.push({ x1: v.x, y1: v.y, x2: a.x, y2: a.y, x3: b.x, y3: b.y });
          }
        }
      }
    }

    const segments = this.drawnSegments.slice();

    return { vertices, edges, regions, segments, cuts, triangles };
  }

  /** Emit a debug step if callback is set */
  private emitDebug(partial: Partial<DebugSnapshot>): void {
    if (this.onDebugStep) {
      const state = this.captureState();
      this.onDebugStep({ ...state, ...partial } as Partial<DebugSnapshot>);
    }
  }

  getVertices(): Vertex[] {
    return this.vertices;
  }

  getRegions(): Region[] {
    return this.regions.filter(r => r != null);
  }

  getCuts(): SymmetricMap<Cut> {
    return this.newcuts;
  }

  /**
   * Count segment-segment crossings between different nets.
   * Only checks line segments (not arcs) for simplicity.
   */
  countCrossings(): number {
    const lines = this.drawnSegments.filter(s => s.type === 'line');
    let crossings = 0;
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        const a = lines[i];
        const b = lines[j];
        if (a.netId === b.netId) continue;
        if (segmentsIntersect(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1, b.x2, b.y2)) {
          crossings++;
        }
      }
    }
    return crossings;
  }
}
