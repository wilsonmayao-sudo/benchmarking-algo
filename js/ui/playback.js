/**
 * Slow-motion playback of a finished benchmark.
 *
 * This is a *replay* of the traversal traces the algorithms already returned — the
 * algorithms are not re-run, so animating can never affect the measurements. `solve()`
 * records the order in which it expanded nodes (`exploredNodes`), and that array is what
 * gets revealed over time.
 *
 * The timeline has two phases:
 *
 *   progress 0 ────────────── 0.8 ────────────── 1
 *            │  search phase   │  route phase   │
 *            │  expanded nodes │  route drawn   │
 *            │  appear one by  │  vertex by     │
 *            │  one            │  vertex        │
 *
 * Each algorithm reveals its OWN expansion list against the same clock, so when the
 * search phase ends both have finished — regardless of how many nodes each needed. That
 * is exactly the comparison you want to watch: A*'s cloud keeps growing long after the
 * custom algorithm's has stopped.
 *
 * Speed is expressed in expanded nodes per second, which is far more intuitive than a
 * multiplier: at 50 nodes/s you can follow individual frontier growth, at 8000 nodes/s
 * the 6 000-node networks finish in well under a second.
 */

/** Fraction of the timeline spent expanding nodes; the rest traces the route. */
export const SEARCH_SHARE = 0.8;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Pure timeline maths — kept separate from the animation loop so it can be verified.
 *
 * @param {number} progress 0..1
 * @param {Array<{id:string, color:string, nodes:number[], path:number[]}>} layers
 * @returns {{progress:number, phase:'idle'|'search'|'route'|'done',
 *            searchShare:number, traceShare:number, revealed:Map<string, object>}}
 */
export function computeReveal(progress, layers) {
  const p = clamp01(progress);
  const searchShare = Math.min(1, p / SEARCH_SHARE);
  const traceShare = p <= SEARCH_SHARE ? 0 : (p - SEARCH_SHARE) / (1 - SEARCH_SHARE);

  let phase = 'search';
  if (p <= 0) phase = 'idle';
  else if (p >= 1) phase = 'done';
  else if (p > SEARCH_SHARE) phase = 'route';

  const revealed = new Map();
  let nodesShown = 0;
  let nodesTotal = 0;

  for (const layer of layers) {
    const nodeCount = layer.nodes.length;
    const pathCount = layer.path.length;
    const revealedNodes = Math.round(searchShare * nodeCount);
    revealed.set(layer.id, {
      id: layer.id,
      name: layer.short || layer.id,
      color: layer.color,
      // Each layer advances through its own list, so all searches finish together.
      revealedNodes,
      revealedPath: Math.round(traceShare * pathCount),
      nodeCount,
    });
    nodesShown += revealedNodes;
    nodesTotal += nodeCount;
  }

  return { progress: p, phase, searchShare, traceShare, revealed, nodesShown, nodesTotal };
}

export class Playback {
  /**
   * @param {{onReveal:Function, onStateChange:Function}} handlers
   */
  constructor({ onReveal = () => {}, onStateChange = () => {} }) {
    this._onReveal = onReveal;
    this._onStateChange = onStateChange;

    /** @type {Array<{id:string,color:string,short:string,nodes:number[],path:number[]}>} */
    this._layers = [];
    this._speed = 200;       // expanded nodes per second
    this._progress = 1;
    this._playing = false;
    this._rafId = 0;
    this._lastTime = 0;
    this._maxNodes = 1;
    this._maxPath = 1;
  }

  get playing() {
    return this._playing;
  }

  get progress() {
    return this._progress;
  }

  get ready() {
    return this._layers.length > 0;
  }

  /** Load the results of a finished benchmark and jump to the end. */
  load(results) {
    this.pause();
    this._layers = (results || [])
      .filter((r) => (r.exploredNodes && r.exploredNodes.length > 0) || (r.path && r.path.length > 1))
      .map((r) => ({
        id: r.id,
        color: r.color,
        short: r.short || r.name,
        nodes: r.exploredNodes || [],
        path: r.path || [],
      }));

    this._maxNodes = Math.max(1, ...this._layers.map((l) => l.nodes.length));
    this._maxPath = Math.max(1, ...this._layers.map((l) => l.path.length));
    this._progress = 1;
    this._emit();
  }

  /** Drop the timeline (no results yet, or the scenario changed). */
  clear() {
    this.pause();
    this._layers = [];
    this._progress = 1;
    this._emit();
  }

  setSpeed(nodesPerSecond) {
    const value = Number(nodesPerSecond);
    if (Number.isFinite(value) && value > 0) this._speed = value;
  }

  play() {
    if (!this.ready) return;
    if (this._progress >= 1) this._progress = 0; // pressing play at the end replays
    if (this._playing) return;

    this._playing = true;
    this._lastTime = performance.now();
    this._emitState();
    this._rafId = requestAnimationFrame(this._tick);
  }

  pause() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
    if (!this._playing) return;
    this._playing = false;
    this._emitState();
  }

  toggle() {
    if (this._playing) this.pause();
    else this.play();
  }

  /** Jump to a position in 0..1. */
  seek(progress) {
    this._progress = clamp01(progress);
    this._emit();
  }

  /** Re-apply the current reveal, after the view layers were rebuilt. */
  refresh() {
    if (!this.ready) return;
    this._emit();
  }

  // -------------------------------------------------------------- internals

  _tick = (now) => {
    if (!this._playing) return;
    const dt = Math.min(0.25, (now - this._lastTime) / 1000); // cap after a tab switch
    this._lastTime = now;

    // Convert "nodes per second" into timeline progress. The search phase spans the
    // largest expansion list, so the slowest-to-finish algorithm sets the pace.
    const perSecond = this._progress < SEARCH_SHARE
      ? (this._speed * SEARCH_SHARE) / this._maxNodes
      : (this._speed * (1 - SEARCH_SHARE)) / this._maxPath;

    this._progress = Math.min(1, this._progress + dt * perSecond);
    this._emit();

    if (this._progress >= 1) {
      this._playing = false;
      this._rafId = 0;
      this._emitState();
      return;
    }
    this._rafId = requestAnimationFrame(this._tick);
  };

  _emit() {
    if (!this.ready) {
      this._onReveal(new Map(), 'Run the benchmark to replay it', {
        phase: 'idle', progress: 1, searchShare: 0, traceShare: 0, revealed: new Map(),
      });
      this._emitState();
      return;
    }
    const frame = computeReveal(this._progress, this._layers);
    this._onReveal(frame.revealed, describe(frame), frame);
    this._emitState();
  }

  _emitState() {
    this._onStateChange({
      ready: this.ready,
      playing: this._playing,
      progress: this._progress,
    });
  }
}

/** Human-readable status line for the playback bar. */
export function describe(frame) {
  if (frame.phase === 'idle') return 'Ready — press Play';
  if (frame.phase === 'done') return 'Complete';

  if (frame.phase === 'search') {
    const perLayer = [...frame.revealed.values()]
      .map((r) => `${r.name} ${r.revealedNodes.toLocaleString('en-US')}/${r.nodeCount.toLocaleString('en-US')}`)
      .join('  ·  ');
    return `Expanding nodes — ${Math.round(frame.searchShare * 100)} %  ·  ${perLayer}`;
  }
  return `Tracing route — ${Math.round(frame.traceShare * 100)} %`;
}
