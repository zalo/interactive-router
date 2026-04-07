// Priority Queue with decrease-key support for Dijkstra
// Replaces Boost Fibonacci Queue from the Ruby version

export class PriorityQueue<K> {
  private heap: { key: K; priority: number }[] = [];
  private index: Map<K, number> = new Map();

  get size(): number {
    return this.heap.length;
  }

  push(key: K, priority: number): void {
    if (this.index.has(key)) {
      this.decreaseKey(key, priority);
      return;
    }
    const i = this.heap.length;
    this.heap.push({ key, priority });
    this.index.set(key, i);
    this._bubbleUp(i);
  }

  /**
   * Try to decrease the key's priority. Returns true if decreased.
   * Equivalent to Ruby's q.inc?(key, priority)
   */
  decreaseKey(key: K, priority: number): boolean {
    const i = this.index.get(key);
    if (i === undefined) {
      this.push(key, priority);
      return true;
    }
    if (priority < this.heap[i].priority) {
      this.heap[i].priority = priority;
      this._bubbleUp(i);
      return true;
    }
    return false;
  }

  pop(): { key: K; priority: number } | null {
    if (this.heap.length === 0) return null;
    const min = this.heap[0];
    const last = this.heap.pop()!;
    this.index.delete(min.key);
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.index.set(last.key, 0);
      this._sinkDown(0);
    }
    return min;
  }

  has(key: K): boolean {
    return this.index.has(key);
  }

  clear(): void {
    this.heap = [];
    this.index.clear();
  }

  private _bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[i].priority < this.heap[parent].priority) {
        this._swap(i, parent);
        i = parent;
      } else break;
    }
  }

  private _sinkDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.heap[left].priority < this.heap[smallest].priority) smallest = left;
      if (right < n && this.heap[right].priority < this.heap[smallest].priority) smallest = right;
      if (smallest !== i) {
        this._swap(i, smallest);
        i = smallest;
      } else break;
    }
  }

  private _swap(a: number, b: number): void {
    const tmp = this.heap[a];
    this.heap[a] = this.heap[b];
    this.heap[b] = tmp;
    this.index.set(this.heap[a].key, a);
    this.index.set(this.heap[b].key, b);
  }
}
