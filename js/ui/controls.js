/**
 * UI wiring: scenario picker, custom scenario panel, benchmark settings, cost-model
 * weights and the display toggles.
 *
 * This module owns the DOM only — it holds no benchmark state. Every interaction is
 * forwarded to a handler supplied by `main.js`.
 */

export function initControls(handlers) {
  const $ = (id) => document.getElementById(id);

  const els = {
    status: $('status'),
    scenarioSelect: $('scenarioSelect'),
    scenarioDesc: $('scenarioDesc'),
    applyScenario: $('applyScenario'),
    progressBar: $('progressBar'),
    progressLabel: $('progressLabel'),
    runBtn: $('runBtn'),
    repeats: $('repeats'),
    warmup: $('warmup'),
    routeMode: $('routeMode'),
    stopCount: $('stopCount'),
    stopCountField: $('stopCountField'),
    routeModeNote: $('routeModeNote'),
    custom: {
      type: $('cNetType'),
      nodes: $('cNodes'),
      elevation: $('cElev'),
      traffic: $('cTraffic'),
      closures: $('cClosures'),
      seed: $('cSeed'),
    },
    customNetworkNote: $('customNetworkNote'),
    applyCustom: $('applyCustom'),
    algoSettingsGroup: $('algoSettingsGroup'),
    algoTunables: $('algoTunables'),
    playBtn: $('playBtn'),
    playSpeed: $('playSpeed'),
    playScrub: $('playScrub'),
    playLabel: $('playLabel'),
    mapFile: $('mapFile'),
    mapDropzone: $('mapDropzone'),
    mapFileLabel: $('mapFileLabel'),
    mapPath: $('mapPath'),
    mapPathLoad: $('mapPathLoad'),
    mapFolder: $('mapFolder'),
    mapStatus: $('mapStatus'),
    viewMode: $('viewMode'),
    viewReset: $('viewReset'),
    display: {
      explored: $('optExplored'),
      closed: $('optClosed'),
      traffic: $('optTraffic'),
      elevation: $('optElev'),
    },
    weights: {
      time: $('wTime'),
      distance: $('wDistance'),
      climb: $('wClimb'),
      descent: $('wDescent'),
    },
    applyWeights: $('applyWeights'),
  };

  // ------------------------------------------------------------ scenarios
  els.scenarioSelect.addEventListener('change', () => {
    handlers.onScenarioChange(els.scenarioSelect.value);
  });

  if (els.applyScenario) {
    els.applyScenario.addEventListener('click', () => {
      handlers.onScenarioChange(els.scenarioSelect.value);
    });
  }

  // ------------------------------------------------------- custom scenario
  els.applyCustom.addEventListener('click', () => {
    handlers.onCustomScenario(readCustomConfig());
  });

  for (const input of Object.values(els.custom)) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') handlers.onCustomScenario(readCustomConfig());
    });
  }

  // ------------------------------------------------------------ city map
  // Three independent ways in, because a native file picker is not available in every
  // environment (embedded browsers and webviews in particular):
  //   1. the file input (click the drop zone, or drop onto it)
  //   2. drag & drop anywhere on the window
  //   3. a path served by the local HTTP server, e.g. "data/mycity.geojson"

  els.mapFile.addEventListener('change', () => {
    const picked = Array.from(els.mapFile.files || []);
    els.mapFile.value = ''; // allow the same file to be picked again later
    readFiles(picked);
  });

  els.mapPathLoad.addEventListener('click', () => {
    handlers.onCityMapPath(els.mapPath.value);
  });
  els.mapPath.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') handlers.onCityMapPath(els.mapPath.value);
  });

  els.mapFolder.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-file]');
    if (chip) handlers.onCityMapPath(`data/${chip.dataset.file}`);
  });

  // Whole-window drop target. A depth counter keeps the overlay from flickering as the
  // pointer moves between child elements.
  let dragDepth = 0;
  const hasFiles = (event) =>
    !!event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files');

  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    dragDepth += 1;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove('dragging');
  });
  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    readFiles(Array.from(event.dataTransfer.files || []));
  });

  async function readFiles(fileList) {
    const list = Array.from(fileList || []);
    if (list.length === 0) return;

    els.mapFileLabel.textContent = list.length === 1 ? list[0].name : `${list.length} files`;
    setMapStatus('Reading…', 'pending');

    const files = [];
    for (const file of list) {
      try {
        files.push({ name: file.name, text: await file.text() });
      } catch (error) {
        setMapStatus(`Could not read ${file.name}: ${error.message}`, 'error');
        return;
      }
    }
    handlers.onCityMap(files);
  }

  // ------------------------------------------------------------- playback
  // `playbackState` mirrors what main.js last reported, so the scrubber knows whether
  // grabbing it should pause the animation first.
  let playbackState = { ready: false, playing: false, progress: 1 };
  let scrubbing = false;

  els.playBtn.addEventListener('click', () => handlers.onPlayToggle());
  els.playSpeed.addEventListener('change', () => handlers.onPlaySpeed(Number(els.playSpeed.value)));

  els.playScrub.addEventListener('pointerdown', () => {
    scrubbing = true;
    if (playbackState.playing) handlers.onPlayToggle(); // pause while scrubbing
  });
  window.addEventListener('pointerup', () => { scrubbing = false; });
  els.playScrub.addEventListener('input', () => {
    handlers.onPlaySeek(Number(els.playScrub.value) / 1000);
  });
  els.playScrub.addEventListener('keydown', () => {
    if (playbackState.playing) handlers.onPlayToggle();
  });

  // --------------------------------------------------- algorithm tunables
  els.algoTunables.addEventListener('input', (event) => {
    if (event.target.type !== 'range') return;
    // Live readout while dragging; the value is only committed on release.
    writeReadout(event.target);
  });

  els.algoTunables.addEventListener('change', (event) => {
    const input = event.target;
    if (input.type !== 'range') return;
    writeReadout(input);
    handlers.onTunableChange(input.dataset.algo, input.dataset.tunable, Number(input.value));
  });

  // ------------------------------------------------------------ run button
  els.runBtn.addEventListener('click', () => {
    handlers.onRun(readRunConfig());
  });

  // -------------------------------------------------------------- display
  for (const input of Object.values(els.display)) {
    input.addEventListener('change', () => handlers.onDisplay(readDisplay()));
  }

  els.viewMode.addEventListener('change', () => handlers.onViewMode(els.viewMode.value));
  els.viewReset.addEventListener('click', () => handlers.onViewReset());

  els.routeMode.addEventListener('change', () => {
    syncRouteMode();
    handlers.onRouteMode(els.routeMode.value);
  });
  syncRouteMode();

  /** The pickup-point field and its explanation only apply to a collection round. */
  function syncRouteMode() {
    const isRound = els.routeMode.value === 'round';
    els.stopCountField.hidden = !isRound;
    els.routeModeNote.hidden = !isRound;
  }

  // -------------------------------------------------------------- weights
  for (const input of Object.values(els.weights)) {
    input.addEventListener('change', () => handlers.onWeights(readWeights()));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') handlers.onWeights(readWeights());
    });
  }

  if (els.applyWeights) {
    els.applyWeights.addEventListener('click', () => {
      handlers.onWeights(readWeights());
    });
  }

  // ------------------------------------------------------------------ API
  return {
    /** Populate the scenario dropdown. */
    setScenarioList(scenarios, activeId) {
      els.scenarioSelect.innerHTML = scenarios
        .map((s) => `<option value="${s.id}">${s.name}</option>`)
        .join('');
      els.scenarioSelect.value = activeId;
    },

    setScenarioDescription(text) {
      els.scenarioDesc.textContent = text || '';
    },

    setRepeats(value) {      els.repeats.value = String(value);
    },

    setStatus(text, kind = '') {
      els.status.textContent = text;
      els.status.className = `pill ${kind}`.trim();
    },

    /** @param {number} fraction 0..1 */
    setProgress(fraction, label = '') {
      const pct = Math.max(0, Math.min(1, fraction)) * 100;
      els.progressBar.style.width = `${pct}%`;
      if (label) els.progressLabel.textContent = label;
    },

    setBusy(busy) {
      els.runBtn.disabled = busy;
      if (els.applyCustom) els.applyCustom.disabled = busy;
      if (els.applyScenario) els.applyScenario.disabled = busy;
      if (els.applyWeights) els.applyWeights.disabled = busy;
      els.runBtn.textContent = busy ? 'Running…' : 'Run benchmark';
    },

    setCustomValues(config) {
      els.custom.type.value = config.type ?? 'grid';
      els.custom.nodes.value = String(config.targetNodes ?? 4000);
      els.custom.elevation.value = String(config.elevationAmplitude ?? 60);
      els.custom.traffic.value = String(Math.round((config.trafficLevel ?? 0.4) * 100));
      els.custom.closures.value = String(config.closures ?? 25);
      els.custom.seed.value = String(config.seed ?? 20260913);
    },

    readWeights,
    readDisplay,
    setMapStatus,
    setMapLabel,
    setFolderFiles,
    setNetworkInputsEnabled,
    setPlayback,
    setPlaybackLabel,
    setTunables,
    getRepeats: () => readPositiveInt(els.repeats, 7, 1, 200),
  };

  /**
   * Render one slider per declared tunable.
   * @param {Array<{algorithmId:string, algorithmName:string, tunables:Array<object>}>} groups
   */
  function setTunables(groups) {
    const list = Array.isArray(groups) ? groups : [];
    if (list.length === 0) {
      els.algoSettingsGroup.hidden = true;
      els.algoTunables.innerHTML = '';
      return;
    }

    els.algoSettingsGroup.hidden = false;
    els.algoTunables.innerHTML = list.map((group) => {
      const header = list.length > 1
        ? `<div class="tunable-algo">${escapeHtml(group.algorithmName)}</div>`
        : '';
      const controls = group.tunables.map((tunable) => {
        const digits = Number.isFinite(tunable.digits) ? tunable.digits : 2;
        return `
          <label class="field tunable">
            <span>${escapeHtml(tunable.label)} &mdash; <b>${Number(tunable.value).toFixed(digits)}</b></span>
            <input type="range"
                   data-algo="${escapeHtml(group.algorithmId)}"
                   data-tunable="${escapeHtml(tunable.id)}"
                   data-digits="${digits}"
                   min="${tunable.min}" max="${tunable.max}" step="${tunable.step}"
                   value="${tunable.value}" />
          </label>
          ${tunable.hint ? `<p class="hint">${escapeHtml(tunable.hint)}</p>` : ''}`;
      }).join('');
      return `<div class="tunable-group">${header}${controls}</div>`;
    }).join('');
  }

  function writeReadout(input) {
    const readout = input.parentElement.querySelector('b');
    if (!readout) return;
    const digits = Number(input.dataset.digits) || 2;
    readout.textContent = Number(input.value).toFixed(digits);
  }

  /**
   * Update the playback bar.
   * @param {{ready?:boolean, playing?:boolean, progress?:number}} state
   */
  function setPlayback(state) {
    playbackState = { ...playbackState, ...state };
    els.playBtn.disabled = !playbackState.ready;
    els.playScrub.disabled = !playbackState.ready;

    if (playbackState.playing) {
      els.playBtn.textContent = '\u23F8 Pause';
    } else if (playbackState.ready && playbackState.progress >= 1) {
      els.playBtn.textContent = '\u21BB Replay';
    } else {
      els.playBtn.textContent = '\u25B6 Play';
    }

    // Never fight the user while they are dragging the scrubber.
    if (!scrubbing) {
      els.playScrub.value = String(Math.round(playbackState.progress * 1000));
    }
  }

  function setPlaybackLabel(text) {
    els.playLabel.textContent = text;
  }

  /**
   * The four network-shape inputs only mean something when the app generates a road
   * network. Once a city map is loaded its own roads are used, so greying them out stops
   * them from looking like they do something.
   */
  function setNetworkInputsEnabled(enabled) {
    for (const input of [els.custom.type, els.custom.nodes]) {
      input.disabled = !enabled;
    }
    els.customNetworkNote.hidden = enabled;
    els.customNetworkNote.textContent = enabled
      ? ''
      : 'Network shape comes from the imported map, so these two are ignored — traffic, elevation, closures and seed still apply to it.';
  }

  // ------------------------------------------------------------ map status
  /** @param {'ok'|'error'|'pending'|''} kind */
  function setMapStatus(text, kind = '', detail = '') {
    els.mapStatus.className = `hint ${kind}`.trim();
    els.mapStatus.textContent = text;
    els.mapStatus.title = detail;
  }

  function setMapLabel(text) {
    els.mapFileLabel.textContent = text;
  }

  /**
   * Best-effort list of map files sitting in the served `data/` folder, so a map can be
   * loaded with one click when the file picker is unavailable. Hidden entirely when the
   * server does not expose directory listings.
   */
  function setFolderFiles(names) {
    const list = Array.isArray(names) ? names : [];
    if (list.length === 0) {
      els.mapFolder.hidden = true;
      els.mapFolder.innerHTML = '';
      return;
    }
    els.mapFolder.hidden = false;
    els.mapFolder.innerHTML =
      '<span class="folder-label">Found in data/:</span>' +
      list
        .map((name) => `<button type="button" class="chip" data-file="${escapeHtml(name)}">${escapeHtml(name)}</button>`)
        .join('');
  }

  // ------------------------------------------------------------- readers
  function readRunConfig() {
    return {
      repeats: readPositiveInt(els.repeats, 7, 1, 200),
      warmup: readPositiveInt(els.warmup, 3, 0, 20),
      mode: els.routeMode.value === 'round' ? 'round' : 'trip',
      stopCount: readPositiveInt(els.stopCount, 12, 2, 80),
    };
  }

  function readCustomConfig() {
    return {
      type: els.custom.type.value,
      targetNodes: readPositiveInt(els.custom.nodes, 4000, 50, 20000),
      elevationAmplitude: readPositiveInt(els.custom.elevation, 60, 0, 400),
      trafficLevel: readPositiveInt(els.custom.traffic, 40, 0, 100) / 100,
      closures: readPositiveInt(els.custom.closures, 25, 0, 1000),
      seed: readPositiveInt(els.custom.seed, 20260913, 1, 99999999),
      repeat: readPositiveInt(els.repeats, 7, 1, 200),
    };
  }

  function readDisplay() {
    return {
      explored: els.display.explored.checked,
      closed: els.display.closed.checked,
      traffic: els.display.traffic.checked,
      elevation: els.display.elevation.checked,
    };
  }

  function readWeights() {
    return {
      time: readFloat(els.weights.time, 1),
      distance: readFloat(els.weights.distance, 0),
      climb: readFloat(els.weights.climb, 0.5),
      descent: readFloat(els.weights.descent, 0.15),
    };
  }
}

function readPositiveInt(input, fallback, min, max) {
  const v = Math.round(Number(input.value));
  if (!Number.isFinite(v)) {
    input.value = String(fallback);
    return fallback;
  }
  const clamped = Math.max(min, Math.min(max, v));
  if (clamped !== v) input.value = String(clamped);
  return clamped;
}

function readFloat(input, fallback) {
  const v = Number(input.value);
  if (!Number.isFinite(v)) {
    input.value = String(fallback);
    return fallback;
  }
  return v;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}
