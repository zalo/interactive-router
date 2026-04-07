// Constrained Delaunay Triangulation using cdt2d (pure JS)
// Following the pattern from polyanya-ts

import cdt2d from 'cdt2d';
import { Vertex } from './types.ts';

export class CDT {
  private vertices: Vertex[] = [];
  private constraintEdges: [number, number][] = [];
  private constraints: Set<string> = new Set();

  private constraintKey(a: number, b: number): string {
    return a < b ? `${a}_${b}` : `${b}_${a}`;
  }

  insert(v: Vertex): void {
    this.vertices.push(v);
  }

  insertConstraint(v1: Vertex, v2: Vertex): void {
    const i1 = this.vertices.indexOf(v1);
    const i2 = this.vertices.indexOf(v2);
    if (i1 >= 0 && i2 >= 0) {
      this.constraintEdges.push([i1, i2]);
      this.constraints.add(this.constraintKey(v1.id, v2.id));
    }
  }

  async triangulate(): Promise<void> {
    const n = this.vertices.length;
    if (n < 3) return;

    // Clear existing neighbors
    for (const v of this.vertices) {
      v.neighbors = [];
    }

    // Build points array for cdt2d
    const points: [number, number][] = this.vertices.map(v => [v.x, v.y]);

    // Run constrained Delaunay triangulation
    // exterior: true to include all triangles (with no constraints, all are "exterior")
    const triangles = cdt2d(points, this.constraintEdges);

    // Extract edges from triangles and build neighbor lists
    const edgeSet = new Set<string>();
    for (const [a, b, c] of triangles) {
      const triEdges: [number, number][] = [[a, b], [b, c], [c, a]];
      for (const [i, j] of triEdges) {
        if (i >= n || j >= n) continue;
        const key = i < j ? `${i}_${j}` : `${j}_${i}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          const va = this.vertices[i];
          const vb = this.vertices[j];
          if (!va.neighbors.includes(vb)) va.neighbors.push(vb);
          if (!vb.neighbors.includes(va)) vb.neighbors.push(va);
        }
      }
    }
  }

  edgesInConstrainedPolygons(callback: (v1: Vertex, v2: Vertex) => void): void {
    for (const v of this.vertices) {
      for (const nb of v.neighbors) {
        if (v.id < nb.id) {
          if (v.cid >= 0 && v.cid === nb.cid &&
              !this.constraints.has(this.constraintKey(v.id, nb.id))) {
            callback(v, nb);
          }
        }
      }
    }
  }

  getVertices(): Vertex[] { return this.vertices; }
  forEach(callback: (v: Vertex) => void): void { this.vertices.forEach(callback); }
  neighborVertices(v: Vertex): Vertex[] { return v.neighbors; }
}
