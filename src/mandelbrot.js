import { makePalette } from './palette.js';
import { overlay } from './overlay.js';
import { share } from './share.js';
import { ViewHistory } from './history.js';
import { requestGPUDevice, attachCanvas } from './renderer.js';
import { FractalPanel, buildUniformData } from './fractalPanel.js';

class MandelbrotApp {
  static MIN_SCALE = 1e-14;
  static MAX_SCALE = 4.0;
  static MIN_ITER = 1;
  static MAX_ITER = 8192;
  static WHEEL_HISTORY_MS = 250;
  static SETTINGS_KEY = 'isghe-mandelbrot-settings';
  static SETTINGS_SAVE_MS = 400;
  // Visibility toggling operates on DOM elements that exist from page load,
  // independent of whether a panel's FractalPanel/JS wrapper has been
  // instantiated yet (the Julia one is created lazily — see createJuliaPanel).
  // This table is what makes updatePanelVisibility() generic instead of one
  // hardcoded branch per panel.
  static PANEL_VISIBILITY = [
    { canvasId: "gfx", overlayId: "overlay", uiSectionId: "uiMandelbrot", showField: "showMandelbrot" },
    { canvasId: "gfxJulia", overlayId: "overlayJulia", uiSectionId: "uiJulia", showField: "showJulia" },
  ];

  // State (JS = f64). maxIter/paletteType/smoothColoring/progressiveMode/
  // gridOverlay/centerMarker live per-panel (this.mandelbrotPanel.X /
  // this.juliaPanel.X) — see FractalPanel. juliaSeed is the one piece of
  // "Julia-family" state that isn't a canvas's own view (it's the constant
  // the Julia set is drawn for), so it stays app-global here.
  juliaSeed = new DOMPointReadOnly(-0.8, 0.156);

  // overlay display preference that's genuinely app-level: the marker points
  // at where juliaSeed sits on the Mandelbrot plane, meaningless on the Julia
  // panel's own view — see drawOverlayForPanel's showJuliaMarker.
  juliaMarker = 0;

  // Panel visibility (display preferences, not view history — mirrors the
  // overlay toggles above): the Mandelbrot panel and Julia panel are each
  // independently shown/hidden. Both on = split screen; either alone =
  // that panel full-screen; both off = a black screen. The Julia panel is
  // created lazily the first time it's shown, then just hidden/shown by
  // CSS afterward.
  showMandelbrot = 1;
  showJulia = 0;

  // The Julia panel's own independent pan/zoom, persisted separately from
  // `juliaSeed` (the constant the Julia set is drawn for). Backing fields for
  // the juliaPanelCenter/juliaPanelScale accessors below: null means "not
  // restored, not yet dragged/zoomed" — createJuliaPanel() then falls back
  // to centering on the current juliaSeed at the default scale, same as before
  // this persistence existed.
  _juliaPanelCenter = null;
  _juliaPanelScale = null;

  // Set once the shared WebGPU device is lost; blocks further render
  // attempts on both panels (the device, not the canvas, was lost).
  deviceLost = false;

  // view history (Back / Forward)
  history = new ViewHistory(MandelbrotApp.WHEEL_HISTORY_MS, () => this.updateHistoryButtons());
  pendingZoomSnapshot = null;
  pendingIterSnapshot = null;
  saveSettingsTimer = null;
  shareBtnResetTimer = null;

  // render scheduling
  rafPending = false;

  // Reads/writes go straight to the live juliaPanel once it exists (the
  // panel is never destroyed once created, just hidden by CSS — see
  // createJuliaPanel), so this stays live for saveSettings()/buildShareUrl()
  // even while the Julia panel is currently hidden.
  get juliaPanelCenter() { return this.juliaPanel ? this.juliaPanel.center : (this._juliaPanelCenter ?? this.juliaSeed); }
  set juliaPanelCenter(v) { if (this.juliaPanel) this.juliaPanel.center = v; else this._juliaPanelCenter = v; }
  get juliaPanelScale() { return this.juliaPanel ? this.juliaPanel.scale : (this._juliaPanelScale ?? FractalPanel.DEFAULT_SCALE); }
  set juliaPanelScale(v) { if (this.juliaPanel) this.juliaPanel.scale = v; else this._juliaPanelScale = v; }

  constructor(canvas) {
    this.mandelbrotPanel = new FractalPanel(canvas, document.getElementById("overlay"));

    this.initialState = {
      mandelbrotPanelCenter: this.mandelbrotPanel.center,
      mandelbrotPanelScale: this.mandelbrotPanel.scale,
      maxIter: this.mandelbrotPanel.maxIter,
      juliaSeed: this.juliaSeed,
      juliaPanelCenter: this.juliaPanelCenter,
      juliaPanelScale: this.juliaPanelScale,
      paletteType: this.mandelbrotPanel.paletteType,
      progressiveMode: this.mandelbrotPanel.progressiveMode,
      smoothColoring: this.mandelbrotPanel.smoothColoring,
    };
    // Tier 2 ("display preferences"): captured pre-restore too, same as
    // initialState above, so Reset always goes back to the app's built-in
    // defaults rather than whatever was last persisted.
    this.initialDisplayPrefs = this.captureDisplayPrefs();

    this.restoreSettings();

    this.selectionBox = document.getElementById("selectionBox");
    this.noVizMessage = document.getElementById("noVizMessage");
    this.errorBox = document.getElementById("gpuError");
    this.errorMessage = document.getElementById("gpuErrorMessage");
    this.reloadBtn = document.getElementById("gpuReloadBtn");
    this.reloadBtn.onclick = () => location.reload();

    // UI
    this.uiToggleBtn = document.getElementById("uiToggleBtn");
    this.uiPanel = document.getElementById("ui");
    this.iterSlider = document.getElementById("iterSlider");
    this.iterLabel  = document.getElementById("iterLabel");
    this.iterSlider.min = Math.log10(MandelbrotApp.MIN_ITER);
    this.iterSlider.max = Math.log10(MandelbrotApp.MAX_ITER);
    this.zoomSlider = document.getElementById("zoomSlider");
    this.zoomLabel  = document.getElementById("zoomLabel");
    this.zoomSlider.min = Math.log10(MandelbrotApp.MIN_SCALE);
    this.zoomSlider.max = Math.log10(MandelbrotApp.MAX_SCALE);
    this.paletteSel = document.getElementById("paletteType");
    this.showMandelbrotChk = document.getElementById("showMandelbrot");
    this.showJuliaChk = document.getElementById("showJulia");
    this.progressiveChk = document.getElementById("progressiveMode");
    this.smoothColoringChk = document.getElementById("smoothColoring");
    this.gridOverlayChk = document.getElementById("gridOverlay");
    this.centerMarkerChk = document.getElementById("centerMarker");
    this.juliaMarkerChk = document.getElementById("juliaMarker");

    // Julia's own controls, independent of the Mandelbrot ones above —
    // synced to a fresh juliaPanel's field values inside createJuliaPanel(),
    // the one place (constructor restore or later checkbox toggle) where
    // that panel object becomes ready.
    this.iterSliderJulia = document.getElementById("iterSliderJulia");
    this.iterLabelJulia  = document.getElementById("iterLabelJulia");
    this.iterSliderJulia.min = Math.log10(MandelbrotApp.MIN_ITER);
    this.iterSliderJulia.max = Math.log10(MandelbrotApp.MAX_ITER);
    this.zoomSliderJulia = document.getElementById("zoomSliderJulia");
    this.zoomLabelJulia  = document.getElementById("zoomLabelJulia");
    this.zoomSliderJulia.min = Math.log10(MandelbrotApp.MIN_SCALE);
    this.zoomSliderJulia.max = Math.log10(MandelbrotApp.MAX_SCALE);
    this.paletteSelJulia = document.getElementById("paletteTypeJulia");
    this.progressiveChkJulia = document.getElementById("progressiveModeJulia");
    this.smoothColoringChkJulia = document.getElementById("smoothColoringJulia");
    this.gridOverlayChkJulia = document.getElementById("gridOverlayJulia");
    this.centerMarkerChkJulia = document.getElementById("centerMarkerJulia");

    const checkboxFields = [
      ["juliaMarkerChk", "juliaMarker"],
      ["showJuliaChk", "showJulia"],
      ["showMandelbrotChk", "showMandelbrot"],
    ];
    checkboxFields.forEach(([chk, field]) => { this[chk].checked = !!this[field]; });
    const panelCheckboxFields = [
      ["centerMarkerChk", "centerMarker"],
      ["gridOverlayChk", "gridOverlay"],
      ["progressiveChk", "progressiveMode"],
      ["smoothColoringChk", "smoothColoring"],
    ];
    panelCheckboxFields.forEach(([chk, field]) => { this[chk].checked = !!this.mandelbrotPanel[field]; });
    // Apply the restored panel-visibility CSS classes *before* resizing
    // anything below: resizeCanvas()/resizeOverlayCanvas() read the current
    // CSS box size, so if dual-view's 50vw split isn't already in effect,
    // a share URL/localStorage restore that starts in dual view would size
    // both backing stores to the old (100vw) layout and stay stretched
    // until the next window resize or panel toggle.
    this.updatePanelVisibility();
    // A shared/localStorage URL may have restored showJulia=1 before WebGPU
    // finished initializing; create the panel now (attachCanvas happens
    // later in initGPU() once the device is ready, same as onPanelVisibilityChange).
    if (this.showJulia) this.createJuliaPanel();
    // mandelbrotPanel was constructed at the very top of the constructor,
    // before the CSS classes above were known — resize it now that they are.
    if (this.showMandelbrot) {
      this.resizeCanvas();
      this.resizeOverlayCanvas();
    }
    this.paletteSel.value = this.mandelbrotPanel.paletteType;
    this.backBtn    = document.getElementById("backBtn");
    this.forwardBtn = document.getElementById("forwardBtn");
    this.resetBtn   = document.getElementById("resetBtn");
    this.shareBtn   = document.getElementById("shareBtn");

    this.iterSlider.oninput = this.onIterInput;
    this.iterSlider.onchange = () => {
      if (this.pendingIterSnapshot) {
        this.pushHistory(this.pendingIterSnapshot);
        this.pendingIterSnapshot = null;
      }
    };
    this.zoomSlider.oninput = this.onZoomInput;
    this.zoomSlider.onchange = () => {
      if (this.pendingZoomSnapshot) {
        this.pushHistory(this.pendingZoomSnapshot);
        this.pendingZoomSnapshot = null;
      }
    };
    this.paletteSel.onchange = this.onPaletteChange;
    this.showMandelbrotChk.onchange = this.onPanelVisibilityChange;
    this.showJuliaChk.onchange = this.onPanelVisibilityChange;
    this.progressiveChk.onchange = this.onProgressiveChange;
    this.smoothColoringChk.onchange = this.onSmoothColoringChange;
    this.gridOverlayChk.onchange = this.onGridOverlayChange;
    this.centerMarkerChk.onchange = this.onCenterMarkerChange;
    this.juliaMarkerChk.onchange = this.onJuliaMarkerChange;

    // Julia's own controls: direct mutation + render, no history bookkeeping
    // (Julia's own view/quality isn't in undo history yet — see Mossa 3).
    this.iterSliderJulia.oninput = this.onJuliaIterInput;
    this.zoomSliderJulia.oninput = this.onJuliaZoomInput;
    this.paletteSelJulia.onchange = this.onJuliaPaletteChange;
    this.progressiveChkJulia.onchange = this.onJuliaProgressiveChange;
    this.smoothColoringChkJulia.onchange = this.onJuliaSmoothColoringChange;
    this.gridOverlayChkJulia.onchange = this.onJuliaGridOverlayChange;
    this.centerMarkerChkJulia.onchange = this.onJuliaCenterMarkerChange;

    this.backBtn.onclick    = this.onBack;
    this.forwardBtn.onclick = this.onForward;
    this.resetBtn.onclick   = this.onReset;
    this.shareBtn.onclick   = this.onShare;
    this.uiToggleBtn.onclick = this.onUiToggle;

    this.attachPanelEvents({
      panel: this.mandelbrotPanel,
      hooks: {
        pushHistory: (s) => this.pushHistory(s),
        armWheelHistory: () => this.history.armWheel(() => this.snapshotView()),
        onScaleChange: () => this.syncZoomSliderUI(),
        // Only the Mandelbrot panel's genuine click sets the shared Julia
        // constant — see attachPanelEvents' hooks param.
        onGenuineClick: (fractalPoint) => {
          this.juliaSeed = fractalPoint;
          // Only the Julia panel's render actually depends on juliaSeed
          // (its escape set changes; the Mandelbrot panel's own image
          // doesn't) — reset just Julia's progressive ramp, not Mandelbrot's.
          if (this.showJulia && this.juliaPanel) this.resetProgressive(this.juliaPanel);
        },
      },
    });
    window.addEventListener("resize", this.onResize);
    window.addEventListener("keydown", this.onKeyDown);

    this.setScale(this.mandelbrotPanel.scale);
    this.setMaxIter(this.mandelbrotPanel.maxIter);
    this.mandelbrotPanel.palette256 = makePalette(this.mandelbrotPanel.paletteType);

    this.drawOverlay();
  }

  setScale(next) {
    this.mandelbrotPanel.setScale(next, MandelbrotApp.MIN_SCALE, MandelbrotApp.MAX_SCALE);
    this.syncZoomSliderUI();
  }

  syncZoomSliderUI() {
    this.zoomSlider.value = Math.log10(this.mandelbrotPanel.scale);
    this.zoomLabel.textContent = this.mandelbrotPanel.scale;
  }

  syncJuliaZoomSliderUI() {
    this.zoomSliderJulia.value = Math.log10(this.juliaPanel.scale);
    this.zoomLabelJulia.textContent = this.juliaPanel.scale;
  }

  snapshotView() {
    return {
      mandelbrotPanelCenter: this.mandelbrotPanel.center,
      mandelbrotPanelScale: this.mandelbrotPanel.scale,
      maxIter: this.mandelbrotPanel.maxIter,
      juliaSeed: this.juliaSeed,
      paletteType: this.mandelbrotPanel.paletteType,
      progressiveMode: this.mandelbrotPanel.progressiveMode,
      smoothColoring: this.mandelbrotPanel.smoothColoring,
    };
  }

  // share.js's functions take a plain state object (no `this`) — this
  // assembles the shape they expect from wherever each field actually
  // lives now (mandelbrotPanel vs app-global fields).
  shareState() {
    return {
      ...this.snapshotView(),
      juliaPanelCenter: this.juliaPanelCenter,
      juliaPanelScale: this.juliaPanelScale,
      gridOverlay: this.mandelbrotPanel.gridOverlay,
      centerMarker: this.mandelbrotPanel.centerMarker,
      juliaMarker: this.juliaMarker,
      showMandelbrot: this.showMandelbrot,
      showJulia: this.showJulia,
    };
  }

  // Tier 2 ("display preferences"): overlay toggles, panel visibility, and
  // the Julia panel's own independent pan/zoom — persisted (see shareState()
  // above) but deliberately outside undo history, unlike snapshotView()'s
  // Tier 1. Captured/restored as one unit so Reset doesn't need to remember
  // each field separately (that per-field bookkeeping in onReset used to be
  // exactly how the Julia panel's own view got left out of Reset — see the
  // `c2889b3` fix).
  captureDisplayPrefs() {
    return {
      gridOverlay: this.mandelbrotPanel.gridOverlay,
      centerMarker: this.mandelbrotPanel.centerMarker,
      juliaMarker: this.juliaMarker,
      showMandelbrot: this.showMandelbrot,
      showJulia: this.showJulia,
      juliaPanelCenter: this.juliaPanelCenter,
      juliaPanelScale: this.juliaPanelScale,
    };
  }

  restoreDisplayPrefs(p) {
    this.mandelbrotPanel.gridOverlay = p.gridOverlay;
    this.gridOverlayChk.checked = !!p.gridOverlay;
    this.mandelbrotPanel.centerMarker = p.centerMarker;
    this.centerMarkerChk.checked = !!p.centerMarker;
    this.juliaMarker = p.juliaMarker;
    this.juliaMarkerChk.checked = !!p.juliaMarker;

    this.showMandelbrot = p.showMandelbrot;
    this.showMandelbrotChk.checked = !!p.showMandelbrot;
    this.showJulia = p.showJulia;
    this.showJuliaChk.checked = !!p.showJulia;
    this.updatePanelVisibility();
    this.resizeCanvas();
    this.resizeOverlayCanvas();

    this.juliaPanelCenter = p.juliaPanelCenter;
    this.juliaPanelScale = p.juliaPanelScale;
    if (this.juliaPanel) {
      this.juliaPanel.pivot = this.juliaPanel.center;
      this.juliaPanel.pivotScreen = new DOMPointReadOnly(0.5, 0.5);
    }
  }

  saveSettings() {
    const data = share.settingsData(this.shareState());
    try {
      localStorage.setItem(MandelbrotApp.SETTINGS_KEY, JSON.stringify(data));
    } catch {
      // localStorage unavailable (private browsing, quota, etc.) — ignore
    }
    history.replaceState(null, '', this.buildShareUrl());
  }

  loadSettings() {
    try {
      const raw = localStorage.getItem(MandelbrotApp.SETTINGS_KEY);
      return raw ? share.loadSettingsData(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  scheduleSaveSettings = () => {
    clearTimeout(this.saveSettingsTimer);
    this.saveSettingsTimer = setTimeout(() => this.saveSettings(), MandelbrotApp.SETTINGS_SAVE_MS);
  };

  buildShareUrl() {
    return share.buildShareUrl(this.shareState(), this.initialState, location.origin, location.pathname);
  }

  restoreSettings() {
    const shared = share.parseShareParams(location.search);
    const s = shared || this.loadSettings();
    if (!s) return;

    const restoreNumber = (field) => {
      if (typeof s[field] === "number") this[field] = s[field];
    };
    const restorePoint = (field) => {
      const p = s[field];
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        this[field] = new DOMPointReadOnly(p.x, p.y);
      }
    };
    const restorePanelNumber = (field) => {
      if (typeof s[field] === "number") this.mandelbrotPanel[field] = s[field];
    };

    // "mandelbrotPanelCenter"/"mandelbrotPanelScale" (and the per-panel
    // quality/look fields below) live on mandelbrotPanel, not as plain own
    // fields on `this` (unlike the rest of these), so the generic
    // this[field] = ... loop can't reach them — assign explicitly instead.
    if (s.mandelbrotPanelCenter && Number.isFinite(s.mandelbrotPanelCenter.x) && Number.isFinite(s.mandelbrotPanelCenter.y)) {
      this.mandelbrotPanel.center = new DOMPointReadOnly(s.mandelbrotPanelCenter.x, s.mandelbrotPanelCenter.y);
    }
    if (typeof s.mandelbrotPanelScale === "number") this.mandelbrotPanel.scale = s.mandelbrotPanelScale;

    const pointFields = ["juliaSeed", "juliaPanelCenter"];
    const numberFields = ["juliaMarker", "juliaPanelScale", "showJulia", "showMandelbrot"];
    const panelNumberFields = [
      "centerMarker", "gridOverlay", "maxIter", "paletteType", "progressiveMode", "smoothColoring",
    ];
    pointFields.forEach(restorePoint);
    numberFields.forEach(restoreNumber);
    panelNumberFields.forEach(restorePanelNumber);

    this.mandelbrotPanel.pivot = this.mandelbrotPanel.center;

    if (shared) this.saveSettings();
  }

  pushHistory(snapshot) {
    this.history.push(snapshot);
  }

  flushPendingWheelHistory() {
    this.history.flushPendingWheel();
  }

  updateHistoryButtons() {
    this.backBtn.disabled = !this.history.canGoBack;
    this.forwardBtn.disabled = !this.history.canGoForward;
  }

  applySnapshot(s) {
    this.mandelbrotPanel.center = s.mandelbrotPanelCenter;
    this.mandelbrotPanel.pivot = s.mandelbrotPanelCenter;
    this.mandelbrotPanel.pivotScreen = new DOMPointReadOnly(0.5, 0.5);
    this.setScale(s.mandelbrotPanelScale);
    this.setMaxIter(s.maxIter);

    this.juliaSeed = s.juliaSeed;

    this.applyPalette(s.paletteType);
    this.paletteSel.value = s.paletteType;

    this.mandelbrotPanel.progressiveMode = s.progressiveMode;
    this.progressiveChk.checked = !!s.progressiveMode;

    this.mandelbrotPanel.smoothColoring = s.smoothColoring;
    this.smoothColoringChk.checked = !!s.smoothColoring;

    this.resetProgressive(this.mandelbrotPanel);
    this.scheduleRender();
  }

  setMaxIter(next) {
    const clamped = Math.round(Math.min(MandelbrotApp.MAX_ITER, Math.max(MandelbrotApp.MIN_ITER, next)));
    this.mandelbrotPanel.maxIter = clamped;
    this.iterSlider.value = Math.log10(clamped);
    this.iterLabel.textContent = clamped;
  }

  // Julia's own Iterations slider — independent of Mandelbrot's, no history
  // bookkeeping (see Mossa 3 for when Julia's view/quality joins undo history).
  setJuliaMaxIter(next) {
    const clamped = Math.round(Math.min(MandelbrotApp.MAX_ITER, Math.max(MandelbrotApp.MIN_ITER, next)));
    this.juliaPanel.maxIter = clamped;
    this.iterSliderJulia.value = Math.log10(clamped);
    this.iterLabelJulia.textContent = clamped;
  }

  resizeCanvas() {
    this.mandelbrotPanel.resizeCanvas();
  }

  resizeOverlayCanvas() {
    this.mandelbrotPanel.resizeOverlayCanvas();
  }

  onResize = () => {
    for (const { panel } of this.panels) {
      panel.resizeCanvas();
      panel.resizeOverlayCanvas();
    }
    this.scheduleRender();
  };

  // Renders on the next animation frame at most once per call burst
  // (rafPending guard); progressive mode re-arms itself each frame
  // until the ramp completes or panning starts.
  scheduleRender = () => {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      // Drawn before renderOnce() so the overlay still shows up even if
      // WebGPU init failed (renderOnce() is a no-op/throws in that case).
      this.drawOverlay();
      this.renderOnce();
      this.scheduleSaveSettings();
      // renderOnce() already skips advancing a panel's own ramp while it's
      // being dragged (see anyProgressiveBelowCap there) — a drag on one
      // panel shouldn't stall the other panel's independent progressive reveal.
      if (this.anyProgressiveBelowCap) {
        this.scheduleRender();
      }
    });
  };

  // `showJuliaMarker` is false for the Julia panel itself: the marker
  // points at where juliaSeed sits on the *Mandelbrot* plane, which is
  // meaningless overlaid on the Julia panel's own view.
  drawOverlayForPanel(panel, { showJuliaMarker }) {
    const ctx = panel.overlayCtx;
    const w = panel.overlayCssWidth;
    const h = panel.overlayCssHeight;
    const aspect = panel.canvas.width / panel.canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (panel.gridOverlay) overlay.drawGrid(ctx, w, h, panel.center, panel.scale, aspect);
    if (panel.centerMarker) overlay.drawCenterMarker(ctx, w, h, panel.center, panel.scale, aspect);
    if (showJuliaMarker && this.juliaMarker) overlay.drawJuliaMarker(ctx, w, h, this.juliaSeed, panel.center, panel.scale, aspect);
  }

  drawOverlay = () => {
    for (const { panel, showJuliaMarker } of this.panels) {
      this.drawOverlayForPanel(panel, { showJuliaMarker });
    }
  };

  showError(msg) {
    this.errorMessage.textContent = msg;
    this.errorBox.style.display = "block";
  }

  // Device loss (especially a real DEVICE_REMOVED, not just a transient
  // hang) isn't reliably recoverable from within the page — sometimes the
  // browser's own GPU process needs to restart, which page-level JS can't
  // force. Rather than retry and risk cascading into more errors, show the
  // problem and a one-click reload instead of requiring a manual refresh.
  showFatalError(msg) {
    this.showError(msg);
    this.reloadBtn.style.display = "inline-block";
  }

  async init() {
    if (!navigator.gpu) {
      this.showError("WebGPU is not supported in this browser.");
      return;
    }
    await this.initGPU();
  }

  async initGPU() {
    this.gpuDevice = await requestGPUDevice({
      onDeviceLost: (info) => {
        this.deviceLost = true;
        this.showFatalError(`WebGPU device lost (${info.reason}): ${info.message}`);
      },
      onUncapturedError: (message) => this.showError(`WebGPU error: ${message}`),
    });
    if (!this.gpuDevice) {
      this.showError("No WebGPU adapter available.");
      return;
    }
    this.mandelbrotPanel.renderer = await attachCanvas(this.gpuDevice, this.mandelbrotPanel.canvas, this.mandelbrotPanel.palette256);
    // Dual view may have been toggled on before WebGPU finished
    // initializing; attach the Julia panel now if it's still waiting.
    if (this.juliaPanel && !this.juliaPanel.renderer) {
      this.juliaPanel.renderer = await attachCanvas(this.gpuDevice, this.juliaPanel.canvas, this.juliaPanel.palette256);
    }
    this.scheduleRender();
  }

  // Resets one panel's own progressive-reveal ramp.
  resetProgressive(panel) {
    panel.progressiveIter = 1;
  }

  applyPalette(type) {
    const palette256 = makePalette(type);
    this.mandelbrotPanel.paletteType = type;
    this.mandelbrotPanel.palette256 = palette256;
    if (this.mandelbrotPanel.renderer) this.mandelbrotPanel.renderer.writePalette(palette256);
  }

  // Julia's own Palette control — its own GPU palette texture (attachCanvas
  // is per-canvas), independent of Mandelbrot's.
  applyJuliaPalette(type) {
    const palette256 = makePalette(type);
    this.juliaPanel.paletteType = type;
    this.juliaPanel.palette256 = palette256;
    if (this.juliaPanel.renderer) this.juliaPanel.renderer.writePalette(palette256);
  }

  // Screen-normalized [0,1] point -> fractal-space point, anchored at `anchor`.
  toFractal(normPoint, anchor) {
    return this.mandelbrotPanel.toFractal(normPoint, anchor);
  }

  onIterInput = () => {
    if (!this.pendingIterSnapshot) this.pendingIterSnapshot = this.snapshotView();
    this.setMaxIter(10 ** Number(this.iterSlider.value));
    this.resetProgressive(this.mandelbrotPanel);
    this.scheduleRender();
  };

  onZoomInput = () => {
    if (!this.pendingZoomSnapshot) this.pendingZoomSnapshot = this.snapshotView();
    this.setScale(10 ** Number(this.zoomSlider.value));
    this.scheduleRender();
  };

  onPaletteChange = () => {
    this.pushHistory(this.snapshotView());
    this.applyPalette(Number(this.paletteSel.value));
    this.scheduleRender();
  };

  onJuliaIterInput = () => {
    this.setJuliaMaxIter(10 ** Number(this.iterSliderJulia.value));
    this.resetProgressive(this.juliaPanel);
    this.scheduleRender();
  };

  onJuliaZoomInput = () => {
    this.juliaPanel.setScale(10 ** Number(this.zoomSliderJulia.value), MandelbrotApp.MIN_SCALE, MandelbrotApp.MAX_SCALE);
    this.syncJuliaZoomSliderUI();
    this.scheduleRender();
  };

  onJuliaPaletteChange = () => {
    this.applyJuliaPalette(Number(this.paletteSelJulia.value));
    this.scheduleRender();
  };

  // Panel visibility is a display preference, not view state (mirrors the
  // overlay toggles below) — no pushHistory. The Julia panel is created
  // lazily the first time it's shown and then kept alive (just hidden by
  // CSS) so toggling back on doesn't need to re-attach WebGPU.
  onPanelVisibilityChange = () => {
    this.showMandelbrot = this.showMandelbrotChk.checked ? 1 : 0;
    this.showJulia = this.showJuliaChk.checked ? 1 : 0;
    this.updatePanelVisibility();
    // The CSS width of a shown panel changes (100vw <-> 50vw) the instant
    // its visibility changes; refresh its backing store now rather than
    // waiting for the next window resize, or the image stays stretched.
    if (this.showMandelbrot) {
      this.resizeCanvas();
      this.resizeOverlayCanvas();
    }
    if (this.showJulia && !this.juliaPanel) this.createJuliaPanel();
    if (this.showJulia && this.juliaPanel) {
      this.juliaPanel.resizeCanvas();
      this.juliaPanel.resizeOverlayCanvas();
    }
    this.scheduleRender();
  };

  updatePanelVisibility() {
    document.body.classList.toggle("dual-view", !!(this.showMandelbrot && this.showJulia));
    let anyVisible = false;
    for (const { canvasId, overlayId, uiSectionId, showField } of MandelbrotApp.PANEL_VISIBILITY) {
      const show = !!this[showField];
      anyVisible = anyVisible || show;
      document.getElementById(canvasId).classList.toggle("panel-hidden", !show);
      document.getElementById(overlayId).classList.toggle("panel-hidden", !show);
      document.getElementById(uiSectionId).classList.toggle("panel-hidden", !show);
    }
    // Generic over however many visualization modes eventually exist, not
    // just these two: show the placeholder whenever none of them are on.
    this.noVizMessage.style.display = anyVisible ? "none" : "block";
  }

  // Currently-shown panels that actually have a FractalPanel instance to
  // operate on (unlike PANEL_VISIBILITY above, this needs the live JS
  // object, not just a DOM id) — what onResize/drawOverlay/renderOnce loop
  // over. mandelbrotPanel always exists; juliaPanel is lazy (see
  // createJuliaPanel), so it's only included once created.
  get panels() {
    const list = [];
    if (this.showMandelbrot) {
      list.push({ panel: this.mandelbrotPanel, juliaMode: 0, showJuliaMarker: true });
    }
    if (this.showJulia && this.juliaPanel) {
      list.push({ panel: this.juliaPanel, juliaMode: 1, showJuliaMarker: false });
    }
    return list;
  }

  createJuliaPanel() {
    const panel = new FractalPanel(document.getElementById("gfxJulia"), document.getElementById("overlayJulia"));
    // this.juliaPanel isn't assigned yet, so these getters read the
    // restored/persisted pan+zoom (or fall back to centering on juliaSeed at
    // the default scale, same as before this state was persisted).
    panel.center = this.juliaPanelCenter;
    panel.pivot = panel.center;
    panel.scale = this.juliaPanelScale;
    // maxIter/paletteType/smoothColoring/progressiveMode/gridOverlay/
    // centerMarker start at FractalPanel's own class defaults — Julia isn't
    // persisted yet (see Mossa 4), so there's nothing to restore here.
    panel.palette256 = makePalette(panel.paletteType);
    this.juliaPanel = panel;

    // Sync Julia's own controls to the panel's (default) values.
    this.setJuliaMaxIter(panel.maxIter);
    this.syncJuliaZoomSliderUI();
    this.paletteSelJulia.value = panel.paletteType;
    this.progressiveChkJulia.checked = !!panel.progressiveMode;
    this.smoothColoringChkJulia.checked = !!panel.smoothColoring;
    this.gridOverlayChkJulia.checked = !!panel.gridOverlay;
    this.centerMarkerChkJulia.checked = !!panel.centerMarker;

    // No onGenuineClick/history hooks: clicking inside the Julia panel only
    // moves its own pivot/zoom anchor, it never sets juliaSeed (only a click on
    // the Mandelbrot panel does that), and its pan/zoom isn't pushed to the
    // shared undo history yet — see Mossa 3. onScaleChange is real, though:
    // it just syncs Julia's own zoom slider, no history involved.
    const noHistory = () => {};
    this.attachPanelEvents({
      panel,
      hooks: {
        pushHistory: noHistory,
        armWheelHistory: noHistory,
        onScaleChange: () => this.syncJuliaZoomSliderUI(),
      },
    });
    if (this.gpuDevice) {
      attachCanvas(this.gpuDevice, panel.canvas, panel.palette256)
        .then((renderer) => {
          panel.renderer = renderer;
          this.scheduleRender();
        })
        .catch((e) => this.showError(`Failed to initialize the Julia panel: ${e.message}`));
    }
  }

  onProgressiveChange = () => {
    this.pushHistory(this.snapshotView());
    this.mandelbrotPanel.progressiveMode = this.progressiveChk.checked ? 1 : 0;
    this.resetProgressive(this.mandelbrotPanel);
    this.scheduleRender();
  };

  onSmoothColoringChange = () => {
    this.pushHistory(this.snapshotView());
    this.mandelbrotPanel.smoothColoring = this.smoothColoringChk.checked ? 1 : 0;
    this.scheduleRender();
  };

  // Overlay display preferences are not part of view history: they don't
  // change what the fractal render pass produces, only what's drawn on the
  // separate #overlay canvas, so no pushHistory here (unlike the toggles above).
  onGridOverlayChange = () => {
    this.mandelbrotPanel.gridOverlay = this.gridOverlayChk.checked ? 1 : 0;
    this.scheduleRender();
  };

  onCenterMarkerChange = () => {
    this.mandelbrotPanel.centerMarker = this.centerMarkerChk.checked ? 1 : 0;
    this.scheduleRender();
  };

  onJuliaMarkerChange = () => {
    this.juliaMarker = this.juliaMarkerChk.checked ? 1 : 0;
    this.scheduleRender();
  };

  // Julia's own quality/look controls — independent, no history bookkeeping
  // (Julia isn't in undo history yet — see Mossa 3).
  onJuliaProgressiveChange = () => {
    this.juliaPanel.progressiveMode = this.progressiveChkJulia.checked ? 1 : 0;
    this.resetProgressive(this.juliaPanel);
    this.scheduleRender();
  };

  onJuliaSmoothColoringChange = () => {
    this.juliaPanel.smoothColoring = this.smoothColoringChkJulia.checked ? 1 : 0;
    this.scheduleRender();
  };

  onJuliaGridOverlayChange = () => {
    this.juliaPanel.gridOverlay = this.gridOverlayChkJulia.checked ? 1 : 0;
    this.scheduleRender();
  };

  onJuliaCenterMarkerChange = () => {
    this.juliaPanel.centerMarker = this.centerMarkerChkJulia.checked ? 1 : 0;
    this.scheduleRender();
  };

  // Panel visibility is a display preference, not view state — no pushHistory (mirrors overlay toggles above).
  onUiToggle = () => {
    this.uiPanel.classList.toggle("hidden");
  };

  onShare = async () => {
    const url = this.buildShareUrl();
    const originalLabel = this.shareBtn.textContent;
    try {
      await navigator.clipboard.writeText(url);
      this.shareBtn.textContent = "Copied!";
    } catch {
      window.prompt("Copy this link:", url);
    }
    clearTimeout(this.shareBtnResetTimer);
    this.shareBtnResetTimer = setTimeout(() => {
      this.shareBtn.textContent = originalLabel;
    }, 1500);
  };

  onKeyDown = (e) => {
    if (e.key !== "h" && e.key !== "H") return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    this.onUiToggle();
  };

  onReset = () => {
    this.pendingIterSnapshot = null;
    this.pendingZoomSnapshot = null;
    this.history.reset();
    // Tier 2 (display preferences) and Tier 1 (navigable view) are restored
    // as two independent units — see captureDisplayPrefs/restoreDisplayPrefs
    // and snapshotView/applySnapshot respectively.
    this.restoreDisplayPrefs(this.initialDisplayPrefs);
    this.applySnapshot(this.initialState);
  };

  onBack = () => {
    const prev = this.history.back(this.snapshotView());
    if (prev) this.applySnapshot(prev);
  };

  onForward = () => {
    const next = this.history.forward(this.snapshotView());
    if (next) this.applySnapshot(next);
  };

  // PAN / CLICK / SELECT / WHEEL: delegated to FractalPanel, which owns the
  // pointer math; `hooks` supplies the app-global side effects a panel can't
  // own itself (history, render scheduling, zoom-slider sync) and what a
  // genuine click on *this* panel should do. Used for both the Mandelbrot
  // panel (real hooks, wired in the constructor) and the Julia panel
  // (no-op history/onGenuineClick hooks, wired in createJuliaPanel) — the
  // difference between the two panels lives entirely in which hooks are
  // passed in, not in two separate copies of this wiring.
  attachPanelEvents({ panel, hooks }) {
    const { pushHistory, armWheelHistory, onScaleChange, onGenuineClick } = hooks;
    panel.canvas.addEventListener("pointerdown", (e) => {
      panel.onPointerDown(e, { selectionBox: this.selectionBox, snapshotView: () => this.snapshotView() });
    });
    panel.canvas.addEventListener("pointermove", (e) => {
      panel.onPointerMove(e, { selectionBox: this.selectionBox });
    });
    const onUp = (e) => {
      panel.onPointerUp(e, {
        selectionBox: this.selectionBox,
        minScale: MandelbrotApp.MIN_SCALE,
        maxScale: MandelbrotApp.MAX_SCALE,
        snapshotView: () => this.snapshotView(),
        pushHistory,
        resetProgressive: () => this.resetProgressive(panel),
        scheduleRender: () => this.scheduleRender(),
        onScaleChange,
        onGenuineClick,
      });
    };
    panel.canvas.addEventListener("pointerup", onUp);
    panel.canvas.addEventListener("pointercancel", onUp);
    panel.canvas.addEventListener("pointerleave", () => {
      panel.onPointerLeave({ selectionBox: this.selectionBox });
    });
    panel.canvas.addEventListener("wheel", (e) => {
      panel.onWheel(e, {
        minScale: MandelbrotApp.MIN_SCALE,
        maxScale: MandelbrotApp.MAX_SCALE,
        armWheelHistory,
        resetProgressive: () => this.resetProgressive(panel),
        scheduleRender: () => this.scheduleRender(),
        onScaleChange,
      });
    }, { passive: false });
  }

  // Renders one panel with the given juliaMode/displayIter — each panel's
  // own maxIter/smoothColoring/progressiveMode/progressiveIter, computed by
  // renderOnce below.
  renderPanel(panel, juliaMode, displayIter) {
    if (!panel.renderer) return;
    const data = buildUniformData({
      center: panel.center,
      scale: panel.scale,
      juliaSeed: this.juliaSeed,
      displayIter,
      canvasWidth: panel.canvas.width,
      canvasHeight: panel.canvas.height,
      juliaMode,
      smoothColoring: panel.smoothColoring,
    });
    panel.renderer.render(data);
  }

  // RENDER. Each visible panel ramps toward its own maxIter independently;
  // scheduleRender's re-arm check (this.anyProgressiveBelowCap) re-arms while
  // at least one panel's ramp hasn't yet reached its own cap.
  renderOnce = () => {
    if (this.deviceLost || !this.mandelbrotPanel.renderer) {
      this.anyProgressiveBelowCap = false;
      return Infinity;
    }

    let anyBelowCap = false;

    for (const { panel, juliaMode } of this.panels) {
      let displayIter = panel.maxIter;
      // Each panel's own drag gates only its own ramp — dragging Mandelbrot
      // doesn't stall Julia's independent progressive reveal, and vice versa.
      if (panel.progressiveMode && !panel.isDragging) {
        displayIter = Math.min(panel.progressiveIter, panel.maxIter);
        if (panel.progressiveIter < panel.maxIter) {
          panel.progressiveIter = Math.min(panel.maxIter, Math.ceil(panel.progressiveIter * 1.08 + 1));
          anyBelowCap = true;
        }
      }
      this.renderPanel(panel, juliaMode, displayIter);
      // Exposed for e2e observation of "what's currently rendered"; tracks
      // whichever panel was rendered last this frame, not just Mandelbrot's
      // (each panel also gets its own copy for dual-view inspection).
      panel.lastDisplayIter = displayIter;
      this.lastDisplayIter = displayIter;
    }

    this.anyProgressiveBelowCap = anyBelowCap;
    return this.lastDisplayIter;
  };
}

const app = new MandelbrotApp(document.getElementById("gfx"));
window.app = app; // exposed for e2e test assertions on internal state (tests/)
try {
  await app.init();
} catch (e) {
  app.showError(`Failed to initialize WebGPU: ${e.message}`);
}
