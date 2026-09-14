/**
 * Binary min-heap priority queue.
 *
 * Shared by every algorithm so that frontier overhead is identical across the
 * benchmark. Keys are doubles, values are non-negative integers (node ids).
 *
 * Note: `pop()` returns the *value* only and performs no allocation. Algorithms that
 * need the key can call `peekKey()` before popping. Stale-duplicate entries are handled
 * by the caller with a `closed` byte array (the standard lazy-deletion pattern).
 */
export class MinHeap {
  /** @param {number} capacity initial capacity */
  constructor(capacity = 1024) {
    const cap = Math.max(16, capacity | 0);
    this._keys = new Float64Array(cap);
    this._vals = new Int32Array(cap);
    this._seq = new Int32Array(cap); // insertion order → deterministic tie-breaking
    this._size = 0;
    this._counter = 0;
  }

  get size() {
    return this._size;
  }

  clear() {
    this._size = 0;
    this._counter = 0;
  }

  /** Insert `value` with priority `key`. Lower keys pop first. */
  push(key, value) {
    if (this._size === this._keys.length) this._grow();
    const i0 = this._size++;
    this._keys[i0] = key;
    this._vals[i0] = value;
    this._seq[i0] = this._counter++;

    let i = i0;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this._less(i, p)) {
        this._swap(i, p);
        i = p;
      } else break;
    }
  }

  /** Remove and return the smallest value, or `null` when empty. */
  pop() {
    if (this._size === 0) return null;
    const top = this._vals[0];
    const last = --this._size;
    if (last > 0) {
      this._keys[0] = this._keys[last];
      this._vals[0] = this._vals[last];
      this._seq[0] = this._seq[last];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= this._size) break;
        const r = l + 1;
        const m = r < this._size && this._less(r, l) ? r : l;
        if (this._less(m, i)) {
          this._swap(m, i);
          i = m;
        } else break;
      }
    }
    return top;
  }

  /** Key of the smallest entry without removing it. */
  peekKey() {
    return this._size > 0 ? this._keys[0] : Infinity;
  }

  // -------------------------------------------------------------- internals

  _less(a, b) {
    const ka = this._keys[a];
    const kb = this._keys[b];
    if (ka < kb) return true;
    if (ka > kb) return false;
    return this._seq[a] < this._seq[b];
  }

  _swap(a, b) {
    const k = this._keys[a]; this._keys[a] = this._keys[b]; this._keys[b] = k;
    const v = this._vals[a]; this._vals[a] = this._vals[b]; this._vals[b] = v;
    const s = this._seq[a]; this._seq[a] = this._seq[b]; this._seq[b] = s;
  }

  _grow() {
    const cap = this._keys.length * 2;
    const keys = new Float64Array(cap); keys.set(this._keys);
    const vals = new Int32Array(cap); vals.set(this._vals);
    const seq = new Int32Array(cap); seq.set(this._seq);
    this._keys = keys;
    this._vals = vals;
    this._seq = seq;
  }
}
