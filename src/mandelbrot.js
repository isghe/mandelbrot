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
  // Bridges the flat mandelbrotPanelX/juliaPanelX/showX schema field names
  // (URL/localStorage, see share.js) to their live location on the model
  // named "mandelbrot"/"julia" (this.modelNamed) — used by
  // restoreSettings()'s generic dispatch below. Third element is true for
  // the handful of fields that live directly on the model object (e.g.
  // `.show`) rather than on `.panel`.
  static PANEL_FIELD_MAP = {
    mandelbrotPanelCenter: ["mandelbrot", "center"],
    mandelbrotPanelScale: ["mandelbrot", "scale"],
    mandelbrotPanelMaxIter: ["mandelbrot", "maxIter"],
    mandelbrotPanelPaletteType: ["mandelbrot", "paletteType"],
    mandelbrotPanelProgressiveMode: ["mandelbrot", "progressiveMode"],
    mandelbrotPanelSmoothColoring: ["mandelbrot", "smoothColoring"],
    mandelbrotPanelGridOverlay: ["mandelbrot", "gridOverlay"],
    mandelbrotPanelCenterMarker: ["mandelbrot", "centerMarker"],
    juliaPanelCenter: ["julia", "center"],
    juliaPanelScale: ["julia", "scale"],
    juliaPanelMaxIter: ["julia", "maxIter"],
    juliaPanelPaletteType: ["julia", "paletteType"],
    juliaPanelProgressiveMode: ["julia", "progressiveMode"],
    juliaPanelSmoothColoring: ["julia", "smoothColoring"],
    juliaPanelGridOverlay: ["julia", "gridOverlay"],
    juliaPanelCenterMarker: ["julia", "centerMarker"],
    showMandelbrot: ["mandelbrot", "show", true],
    showJulia: ["julia", "show", true],
  };
  // State (JS = f64). maxIter/paletteType/smoothColoring/progressiveMode/
  // gridOverlay/centerMarker live per-model (model.panel.X, see
  // modelNamed()) — see FractalPanel. juliaSeed is the one piece of
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
  // that panel full-screen; both off = a black screen. Both panels' JS
  // wrappers always exist (constructed eagerly); visibility is just a CSS
  // class toggled by updatePanelVisibility(). Both shown by default
  // (split-screen) so the two GPU contexts constructed eagerly are both
  // actually put to use from the first frame. Lives as `.show` on each
  // model (see constructor), not a flat field here.

  // Set once the shared WebGPU device is lost; blocks further render
  // attempts on both panels (the device, not the canvas, was lost).
  deviceLost = false;

  // view history (Back / Forward)
  history = new ViewHistory(MandelbrotApp.WHEEL_HISTORY_MS, () => this.updateHistoryButtons());
  saveSettingsTimer = null;
  shareBtnResetTimer = null;

  // render scheduling
  rafPending = false;

  constructor() {
    // juliaMode/showJuliaMarker/onGenuineClick are the only three facts that
    // distinguish Mandelbrot from Julia anywhere in this file — supplied
    // once here, at the one call site that has to know which is which.
    // Everything downstream (event wiring, rendering, visibility,
    // snapshotting) operates on this.models generically.
    this.models = [
      this.createModel("mandelbrot", { juliaMode: 0, showJuliaMarker: true, onGenuineClick: (p) => this.setJuliaSeed(p) }),
      this.createModel("julia", { juliaMode: 1, showJuliaMarker: false }),
    ];
    // Julia's view center keeps FractalPanel's own default (same as
    // Mandelbrot's), rather than starting centered on the Julia seed — the
    // seed is a distinct concept (the fractal's "c" constant, see juliaSeed
    // above) from where the view is panned to. Sharing the same default
    // center/scale as Mandelbrot also keeps both panels' grid overlays
    // aligned at reset. restoreSettings() overrides this if the
    // URL/localStorage carries a juliaPanelCenter. pivot follows in
    // restoreSettings() below.

    // Captured via snapshotView() itself: both panels are freshly constructed
    // here, using FractalPanel's own class defaults, so this captures the
    // app's built-in default view without hand-duplicating those defaults.
    this.initialState = this.snapshotView();
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

    // The Julia-seed-marker checkbox is app-level, not per-model (it toggles
    // this.juliaMarker, meaningless on Julia's own view — see
    // drawOverlayForPanel), even though it physically sits in the Mandelbrot
    // fieldset in index.html.
    this.juliaMarkerChk = document.getElementById("juliaMarker");
    this.juliaMarkerChk.checked = !!this.juliaMarker;
    this.juliaMarkerChk.onchange = this.onJuliaMarkerChange;

    // [UI control key, FractalPanel field name] — mostly identical, except
    // "progressive" (UI) vs "progressiveMode" (FractalPanel), kept short on
    // the UI side since model.progressive already reads unambiguously as
    // the progressive-mode control.
    const panelCheckboxFields = [
      ["centerMarker", "centerMarker"],
      ["gridOverlay", "gridOverlay"],
      ["progressive", "progressiveMode"],
      ["smoothColoring", "smoothColoring"],
    ];
    for (const model of this.models) {
      model.showChk.checked = !!model.show;
      panelCheckboxFields.forEach(([field, panelField]) => { model[field].chk.checked = !!model.panel[panelField]; });
      model.palette.sel.value = model.panel.paletteType;
    }
    // Apply the restored panel-visibility CSS classes *before* resizing
    // anything below: resizeVisiblePanels() reads each panel's current CSS
    // box size, so if dual-view's 50vw split isn't already in effect, a
    // share URL/localStorage restore that starts in dual view would size
    // both backing stores to the old (100vw) layout and stay stretched
    // until the next window resize or panel toggle.
    this.updatePanelVisibility();
    // Both panels were constructed before the CSS visibility classes above
    // were known — resize each shown panel's backing store now that they are.
    // GPU renderers attach later in initGPU().
    this.resizeVisiblePanels();

    this.backBtn    = document.getElementById("backBtn");
    this.forwardBtn = document.getElementById("forwardBtn");
    this.resetBtn   = document.getElementById("resetBtn");
    this.shareBtn   = document.getElementById("shareBtn");

    this.backBtn.onclick    = this.onBack;
    this.forwardBtn.onclick = this.onForward;
    this.resetBtn.onclick   = this.onReset;
    this.shareBtn.onclick   = this.onShare;
    this.uiToggleBtn.onclick = this.onUiToggle;

    // Event wiring, initial zoom/iter/palette sync, and pan/zoom/click
    // gesture wiring — symmetric for both models; the only per-side facts
    // (onScaleChange's target, onGenuineClick) already live on each model.
    for (const model of this.models) {
      model.iter.slider.oninput = () => this.onIterInput(model);
      model.iter.slider.onchange = () => this.commitPendingSnapshot(model, "iter");
      model.zoom.slider.oninput = () => this.onZoomInput(model);
      model.zoom.slider.onchange = () => this.commitPendingSnapshot(model, "zoom");
      model.palette.sel.onchange = () => this.onPaletteChange(model);
      model.showChk.onchange = this.onPanelVisibilityChange;
      model.progressive.chk.onchange = () => this.onProgressiveChange(model);
      model.smoothColoring.chk.onchange = () => this.onSmoothColoringChange(model);
      model.gridOverlay.chk.onchange = () => this.onGridOverlayChange(model);
      model.centerMarker.chk.onchange = () => this.onCenterMarkerChange(model);

      this.attachPanelEvents({
        panel: model.panel,
        hooks: {
          pushHistory: (s) => this.history.push(s),
          armWheelHistory: () => this.history.armWheel(() => this.snapshotView()),
          onScaleChange: () => this.syncZoomSliderUI(model),
          onGenuineClick: model.onGenuineClick,
        },
      });

      this.setPanelScale(model, model.panel.scale);
      this.setMaxIter(model, model.panel.maxIter);
      model.panel.palette256 = makePalette(model.panel.paletteType);
    }

    window.addEventListener("resize", this.onResize);
    window.addEventListener("keydown", this.onKeyDown);

    this.drawOverlay();
  }

  // Builds one side's FractalPanel plus its DOM control refs and slider
  // ranges. `name` composes every DOM id mechanically (`${name}Gfx`,
  // `show${Cap}`, `${name}IterSlider`, ...) — index.html has no exceptions
  // to this beyond the Julia-seed-marker checkbox, which is app-level (see
  // constructor). juliaMode/showJuliaMarker/onGenuineClick are stored right
  // on the model so every later consumer (event wiring, rendering,
  // visibility) can stay agnostic about which side it's looking at.
  createModel(name, { juliaMode, showJuliaMarker, onGenuineClick }) {
    const cap = name[0].toUpperCase() + name.slice(1);
    const model = {
      name,
      panel: new FractalPanel(document.getElementById(`${name}Gfx`), document.getElementById(`${name}Overlay`)),
      show: 1,
      juliaMode,
      showJuliaMarker,
      onGenuineClick,
      iter: { slider: document.getElementById(`${name}IterSlider`), label: document.getElementById(`${name}IterLabel`) },
      zoom: { slider: document.getElementById(`${name}ZoomSlider`), label: document.getElementById(`${name}ZoomLabel`) },
      palette: { sel: document.getElementById(`${name}PaletteType`) },
      progressive: { chk: document.getElementById(`${name}ProgressiveMode`) },
      smoothColoring: { chk: document.getElementById(`${name}SmoothColoring`) },
      gridOverlay: { chk: document.getElementById(`${name}GridOverlay`) },
      centerMarker: { chk: document.getElementById(`${name}CenterMarker`) },
      pendingSnapshot: { iter: null, zoom: null },
      showChk: document.getElementById(`show${cap}`),
      uiSection: document.getElementById(`ui${cap}`),
    };
    model.iter.slider.min = Math.log10(MandelbrotApp.MIN_ITER);
    model.iter.slider.max = Math.log10(MandelbrotApp.MAX_ITER);
    model.zoom.slider.min = Math.log10(MandelbrotApp.MIN_SCALE);
    model.zoom.slider.max = Math.log10(MandelbrotApp.MAX_SCALE);
    return model;
  }

  setPanelScale(model, next) {
    model.panel.setScale(next, MandelbrotApp.MIN_SCALE, MandelbrotApp.MAX_SCALE);
    this.syncZoomSliderUI(model);
  }

  syncZoomSliderUI(model) {
    model.zoom.slider.value = Math.log10(model.panel.scale);
    model.zoom.label.textContent = model.panel.scale;
  }

  // Tier 1 ("navigable view", undo/redo): both panels' own view+quality,
  // symmetric — History A, see the plan doc. juliaSeed isn't a canvas's own
  // view (it's the Julia-family constant), so it stays a separate top-level
  // field rather than living inside either panel's sub-object.
  snapshotView() {
    const mandelbrot = this.modelNamed("mandelbrot");
    const julia = this.modelNamed("julia");
    return {
      mandelbrotPanel: {
        center: mandelbrot.panel.center,
        scale: mandelbrot.panel.scale,
        maxIter: mandelbrot.panel.maxIter,
        paletteType: mandelbrot.panel.paletteType,
        smoothColoring: mandelbrot.panel.smoothColoring,
        progressiveMode: mandelbrot.panel.progressiveMode,
      },
      juliaPanel: {
        center: julia.panel.center,
        scale: julia.panel.scale,
        maxIter: julia.panel.maxIter,
        paletteType: julia.panel.paletteType,
        smoothColoring: julia.panel.smoothColoring,
        progressiveMode: julia.panel.progressiveMode,
      },
      juliaSeed: this.juliaSeed,
    };
  }

  // share.js expects this flat shape (schema v5), distinct from
  // snapshotView()'s nested Tier 1 shape used for undo-history/Reset — see
  // flattenSnapshotForShare() below for the bridge between the two.
  shareState() {
    const mandelbrot = this.modelNamed("mandelbrot");
    const julia = this.modelNamed("julia");
    return {
      mandelbrotPanelCenter: mandelbrot.panel.center,
      mandelbrotPanelScale: mandelbrot.panel.scale,
      mandelbrotPanelMaxIter: mandelbrot.panel.maxIter,
      mandelbrotPanelPaletteType: mandelbrot.panel.paletteType,
      mandelbrotPanelProgressiveMode: mandelbrot.panel.progressiveMode,
      mandelbrotPanelSmoothColoring: mandelbrot.panel.smoothColoring,
      mandelbrotPanelGridOverlay: mandelbrot.panel.gridOverlay,
      mandelbrotPanelCenterMarker: mandelbrot.panel.centerMarker,
      juliaSeed: this.juliaSeed,
      juliaPanelCenter: julia.panel.center,
      juliaPanelScale: julia.panel.scale,
      juliaPanelMaxIter: julia.panel.maxIter,
      juliaPanelPaletteType: julia.panel.paletteType,
      juliaPanelProgressiveMode: julia.panel.progressiveMode,
      juliaPanelSmoothColoring: julia.panel.smoothColoring,
      juliaPanelGridOverlay: julia.panel.gridOverlay,
      juliaPanelCenterMarker: julia.panel.centerMarker,
      juliaMarker: this.juliaMarker,
      showMandelbrot: mandelbrot.show,
      showJulia: julia.show,
    };
  }

  // Tier 2 ("display preferences"): overlay toggles (per panel) and panel
  // visibility — persisted (see shareState() above) but deliberately outside
  // undo history, unlike snapshotView()'s Tier 1. juliaMarker stays a single
  // app-level flag (it marks where juliaSeed sits on the Mandelbrot plane,
  // meaningless on Julia's own view — see drawOverlayForPanel).
  captureDisplayPrefs() {
    const mandelbrot = this.modelNamed("mandelbrot");
    const julia = this.modelNamed("julia");
    return {
      mandelbrotPanelGridOverlay: mandelbrot.panel.gridOverlay,
      mandelbrotPanelCenterMarker: mandelbrot.panel.centerMarker,
      juliaPanelGridOverlay: julia.panel.gridOverlay,
      juliaPanelCenterMarker: julia.panel.centerMarker,
      juliaMarker: this.juliaMarker,
      showMandelbrot: mandelbrot.show,
      showJulia: julia.show,
    };
  }

  restoreDisplayPrefs(p) {
    const mandelbrot = this.modelNamed("mandelbrot");
    const julia = this.modelNamed("julia");
    mandelbrot.panel.gridOverlay = p.mandelbrotPanelGridOverlay;
    mandelbrot.gridOverlay.chk.checked = !!p.mandelbrotPanelGridOverlay;
    mandelbrot.panel.centerMarker = p.mandelbrotPanelCenterMarker;
    mandelbrot.centerMarker.chk.checked = !!p.mandelbrotPanelCenterMarker;
    julia.panel.gridOverlay = p.juliaPanelGridOverlay;
    julia.gridOverlay.chk.checked = !!p.juliaPanelGridOverlay;
    julia.panel.centerMarker = p.juliaPanelCenterMarker;
    julia.centerMarker.chk.checked = !!p.juliaPanelCenterMarker;
    this.juliaMarker = p.juliaMarker;
    this.juliaMarkerChk.checked = !!p.juliaMarker;

    mandelbrot.show = p.showMandelbrot;
    mandelbrot.showChk.checked = !!p.showMandelbrot;
    julia.show = p.showJulia;
    julia.showChk.checked = !!p.showJulia;
    this.updatePanelVisibility();
    this.resizeVisiblePanels();
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

  // share.js's buildShareUrl diffs against the same flat shape shareState()
  // produces — this.initialState is snapshotView()'s nested Tier 1 shape
  // (for applySnapshot/Reset), so it needs flattening here, same as
  // shareState() flattens the *live* panels instead of delegating to
  // snapshotView() directly. Only Tier 1 fields are needed (gridOverlay/
  // centerMarker are Tier 2, not part of snapshotView()'s shape, and
  // buildShareUrl includes them unconditionally rather than diffing them —
  // see shareState()'s call site in buildShareUrl()).
  flattenSnapshotForShare(s) {
    return {
      mandelbrotPanelCenter: s.mandelbrotPanel.center,
      mandelbrotPanelScale: s.mandelbrotPanel.scale,
      mandelbrotPanelMaxIter: s.mandelbrotPanel.maxIter,
      mandelbrotPanelPaletteType: s.mandelbrotPanel.paletteType,
      mandelbrotPanelProgressiveMode: s.mandelbrotPanel.progressiveMode,
      mandelbrotPanelSmoothColoring: s.mandelbrotPanel.smoothColoring,
      juliaSeed: s.juliaSeed,
      juliaPanelCenter: s.juliaPanel.center,
      juliaPanelScale: s.juliaPanel.scale,
      juliaPanelMaxIter: s.juliaPanel.maxIter,
      juliaPanelPaletteType: s.juliaPanel.paletteType,
      juliaPanelProgressiveMode: s.juliaPanel.progressiveMode,
      juliaPanelSmoothColoring: s.juliaPanel.smoothColoring,
    };
  }

  buildShareUrl() {
    return share.buildShareUrl(this.shareState(), this.flattenSnapshotForShare(this.initialState), location.origin, location.pathname);
  }

  restoreSettings() {
    const shared = share.parseShareParams(location.search);
    const s = shared || this.loadSettings();
    if (!s) return;

    const setPanelField = (flatName, value) => {
      const mapped = MandelbrotApp.PANEL_FIELD_MAP[flatName];
      if (mapped) {
        const [side, key, onModel] = mapped;
        const model = this.modelNamed(side);
        if (onModel) model[key] = value;
        else model.panel[key] = value;
      } else {
        this[flatName] = value;
      }
    };
    const restoreNumber = (field) => {
      if (typeof s[field] === "number") setPanelField(field, s[field]);
    };
    const restorePoint = (field) => {
      const p = s[field];
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        setPanelField(field, new DOMPointReadOnly(p.x, p.y));
      }
    };
    const pointFields = ["juliaSeed", "juliaPanelCenter", "mandelbrotPanelCenter"];
    // mandelbrotPanelX / juliaPanelX / showX names are the flat URL/
    // localStorage schema field names (see share.js) — setPanelField() above
    // routes them through PANEL_FIELD_MAP to modelNamed(side).panel (or, for
    // showMandelbrot/showJulia, directly onto modelNamed(side)). juliaSeed/
    // juliaMarker are the only truly flat app-level fields left, and fall
    // through to plain this[flatName] = value.
    const numberFields = [
      "juliaMarker", "showJulia", "showMandelbrot",
      "mandelbrotPanelScale", "mandelbrotPanelMaxIter", "mandelbrotPanelPaletteType",
      "mandelbrotPanelProgressiveMode", "mandelbrotPanelSmoothColoring",
      "mandelbrotPanelGridOverlay", "mandelbrotPanelCenterMarker",
      "juliaPanelScale", "juliaPanelMaxIter", "juliaPanelPaletteType",
      "juliaPanelProgressiveMode", "juliaPanelSmoothColoring",
      "juliaPanelGridOverlay", "juliaPanelCenterMarker",
    ];
    pointFields.forEach(restorePoint);
    numberFields.forEach(restoreNumber);

    for (const model of this.models) model.panel.pivot = model.panel.center;

    if (shared) this.saveSettings();
  }

  updateHistoryButtons() {
    this.backBtn.disabled = !this.history.canGoBack;
    this.forwardBtn.disabled = !this.history.canGoForward;
  }

  // Explicit, side-effecting writes (not a plain field assignment) because
  // this also has to update sliders/checkboxes/the GPU palette texture —
  // see setPanelScale/setMaxIter/applyPalette above.
  applyPanelSnapshot(model, snap) {
    model.panel.center = snap.center;
    model.panel.pivot = snap.center;
    model.panel.pivotScreen = new DOMPointReadOnly(0.5, 0.5);
    this.setPanelScale(model, snap.scale);
    this.setMaxIter(model, snap.maxIter);
    this.applyPalette(model, snap.paletteType);
    model.palette.sel.value = snap.paletteType;
    model.panel.progressiveMode = snap.progressiveMode;
    model.progressive.chk.checked = !!snap.progressiveMode;
    model.panel.smoothColoring = snap.smoothColoring;
    model.smoothColoring.chk.checked = !!snap.smoothColoring;
    this.resetProgressive(model.panel);
  }

  applySnapshot(s) {
    for (const model of this.models) this.applyPanelSnapshot(model, s[`${model.name}Panel`]);
    this.juliaSeed = s.juliaSeed;
    this.scheduleRender();
  }

  // History bookkeeping (pushHistory) is done by the caller (see the
  // sliders' onchange/pendingSnapshot handling and applySnapshot above) —
  // symmetric with setPanelScale above, one method for both panels.
  setMaxIter(model, next) {
    const clamped = Math.round(Math.min(MandelbrotApp.MAX_ITER, Math.max(MandelbrotApp.MIN_ITER, next)));
    model.panel.maxIter = clamped;
    model.iter.slider.value = Math.log10(clamped);
    model.iter.label.textContent = clamped;
  }

  resizeVisiblePanels() {
    for (const { panel } of this.panels) {
      panel.resizeCanvas();
      panel.resizeOverlayCanvas();
    }
  }

  onResize = () => {
    this.resizeVisiblePanels();
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
    const renderers = await Promise.all(
      this.models.map((model) => attachCanvas(this.gpuDevice, model.panel.canvas, model.panel.palette256))
    );
    this.models.forEach((model, i) => { model.panel.renderer = renderers[i]; });
    this.scheduleRender();
  }

  // Resets one panel's own progressive-reveal ramp.
  resetProgressive(panel) {
    panel.progressiveIter = 1;
  }

  // Only the Mandelbrot model's genuine click sets the shared Julia seed —
  // see createModel's onGenuineClick hook.
  setJuliaSeed(fractalPoint) {
    this.juliaSeed = fractalPoint;
    // Only the Julia panel's render actually depends on juliaSeed (its
    // escape set changes; the Mandelbrot panel's own image doesn't) — reset
    // just Julia's progressive ramp, not Mandelbrot's.
    const julia = this.modelNamed("julia");
    if (julia.show) this.resetProgressive(julia.panel);
  }

  // Each panel owns its own GPU palette texture (attachCanvas is per-canvas),
  // so the two panels can show different palettes simultaneously.
  applyPalette(model, type) {
    const palette256 = makePalette(type);
    model.panel.paletteType = type;
    model.panel.palette256 = palette256;
    if (model.panel.renderer) model.panel.renderer.writePalette(palette256);
  }

  // Iterations/zoom sliders debounce history on release (see the sliders'
  // onchange -> commitPendingSnapshot wiring in the constructor): the first
  // input of a drag snapshots the pre-change view, subsequent inputs reuse
  // it, and onchange pushes that one snapshot instead of one per tick.
  onIterInput(model) {
    if (!model.pendingSnapshot.iter) model.pendingSnapshot.iter = this.snapshotView();
    this.setMaxIter(model, 10 ** Number(model.iter.slider.value));
    this.resetProgressive(model.panel);
    this.scheduleRender();
  }

  onZoomInput(model) {
    if (!model.pendingSnapshot.zoom) model.pendingSnapshot.zoom = this.snapshotView();
    this.setPanelScale(model, 10 ** Number(model.zoom.slider.value));
    this.scheduleRender();
  }

  commitPendingSnapshot(model, key) {
    if (model.pendingSnapshot[key]) {
      this.history.push(model.pendingSnapshot[key]);
      model.pendingSnapshot[key] = null;
    }
  }

  onPaletteChange(model) {
    this.history.push(this.snapshotView());
    this.applyPalette(model, Number(model.palette.sel.value));
    this.scheduleRender();
  }

  // Panel visibility is a display preference, not view state (mirrors the
  // overlay toggles below) — no pushHistory. Both panels are always live
  // (just hidden by CSS), so toggling never needs to attach WebGPU.
  onPanelVisibilityChange = () => {
    for (const model of this.models) model.show = model.showChk.checked ? 1 : 0;
    this.updatePanelVisibility();
    // The CSS width of a shown panel changes (100vw <-> 50vw) the instant
    // its visibility changes; refresh its backing store now rather than
    // waiting for the next window resize, or the image stays stretched.
    this.resizeVisiblePanels();
    this.scheduleRender();
  };

  updatePanelVisibility() {
    document.body.classList.toggle("dual-view", this.models.every((model) => model.show));
    let anyVisible = false;
    for (const model of this.models) {
      const show = !!model.show;
      anyVisible = anyVisible || show;
      model.panel.canvas.classList.toggle("panel-hidden", !show);
      model.panel.overlayCanvas.classList.toggle("panel-hidden", !show);
      model.uiSection.classList.toggle("panel-hidden", !show);
    }
    // Generic over however many visualization modes eventually exist, not
    // just these two: show the placeholder whenever none of them are on.
    this.noVizMessage.style.display = anyVisible ? "none" : "block";
  }

  // Currently-shown models — what onResize/drawOverlay/renderOnce loop
  // over. Both models always exist; only visibility (`.show`) gates
  // inclusion here.
  get panels() {
    return this.models.filter((model) => model.show);
  }

  // The one place a caller needs "the model called X" instead of "every
  // model" — used by PANEL_FIELD_MAP's dispatch (restoreSettings) and
  // setJuliaSeed, both genuinely side-specific. Throws on a bad name (e.g. a
  // typo in PANEL_FIELD_MAP or createModel's call sites) instead of handing
  // back undefined for a confusing failure several lines later.
  modelNamed(name) {
    const model = this.models.find((m) => m.name === name);
    if (!model) throw new Error(`No model named "${name}"`);
    return model;
  }

  // Quality controls — Tier 1, pushHistory immediately (unlike the overlay
  // display preferences below).
  onProgressiveChange(model) {
    this.history.push(this.snapshotView());
    model.panel.progressiveMode = model.progressive.chk.checked ? 1 : 0;
    this.resetProgressive(model.panel);
    this.scheduleRender();
  }

  onSmoothColoringChange(model) {
    this.history.push(this.snapshotView());
    model.panel.smoothColoring = model.smoothColoring.chk.checked ? 1 : 0;
    this.scheduleRender();
  }

  // Overlay display preferences are not part of view history: they don't
  // change what the fractal render pass produces, only what's drawn on that
  // panel's own overlay canvas, so no pushHistory here (unlike the toggles above).
  onGridOverlayChange(model) {
    model.panel.gridOverlay = model.gridOverlay.chk.checked ? 1 : 0;
    this.scheduleRender();
  }

  onCenterMarkerChange(model) {
    model.panel.centerMarker = model.centerMarker.chk.checked ? 1 : 0;
    this.scheduleRender();
  }

  onJuliaMarkerChange = () => {
    this.juliaMarker = this.juliaMarkerChk.checked ? 1 : 0;
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
    for (const model of this.models) {
      model.pendingSnapshot.iter = null;
      model.pendingSnapshot.zoom = null;
    }
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
  // genuine click on *this* panel should do. Used for both panels, wired in
  // the constructor — the difference between the two lives entirely in which
  // hooks are passed in (only Mandelbrot's genuine click sets juliaSeed), not
  // in two separate copies of this wiring.
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
    // Gated on deviceLost, not on any single panel's renderer — renderPanel
    // already skips a panel whose own renderer isn't attached yet, so a
    // missing Mandelbrot renderer shouldn't also block an already-ready
    // Julia panel from rendering.
    if (this.deviceLost) {
      this.anyProgressiveBelowCap = false;
      return;
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
      // Exposed for e2e observation of "what's currently rendered".
      panel.lastDisplayIter = displayIter;
    }

    this.anyProgressiveBelowCap = anyBelowCap;
  };
}

const app = new MandelbrotApp();
window.app = app; // exposed for e2e test assertions on internal state (tests/)
try {
  await app.init();
} catch (e) {
  app.showError(`Failed to initialize WebGPU: ${e.message}`);
}
