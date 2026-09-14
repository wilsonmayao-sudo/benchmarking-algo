/**
 * Disjoint-set union (union-find) with union by size and path halving.
 * Used for connectivity guarantees when generating or importing road networks.
 */
export class DSU {
  constructor(n) {
    this.parent = new Int32Array(n).fill(-1);
  }

  find(x) {
    let root = x;
    while (this.parent[root] >= 0) {
      if (this.parent[this.parent[root]] >= 0) this.parent[root] = this.parent[this.parent[root]];
      root = this.parent[root];
    }
    return root;
  }

  /** @returns {boolean} true when the two elements were in different sets */
  union(a, b) {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return false;
    if (this.parent[ra] > this.parent[rb]) {
      const t = ra;
      ra = rb;
      rb = t;
    }
    this.parent[ra] += this.parent[rb];
    this.parent[rb] = ra;
    return true;
  }

  componentSize(x) {
    return -this.parent[this.find(x)];
  }
}
