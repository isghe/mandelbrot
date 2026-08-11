import { makePalette, paletteBandCount, PALETTE_GROUPS } from './palette.js';
import { MANDELBROT_LANDMARKS } from './landmarks.js';
import { overlay } from './overlay.js';
import { ViewHistory } from './history.js';
import { requestGPUDevice, attachCanvas } from './renderer.js';
import { FractalPanel, buildUniformData } from './fractalPanel.js';
import { settings } from './settings.js';

// Exported so tests/unit/mandelbrotApp.stateShapes.test.js can `new
// MandelbrotApp()` directly against a mocked DOM, instead of only through
// the real app instance the top-level bootstrap below constructs (see the
// __MANDELBROT_TEST__ guard at the bottom of this file).
export class MandelbrotApp {
  static SCALE = { min: 1e-14, max: 4.0 };
  static ITER = { min: 1, max: 8192 };
  static WHEEL_HISTORY_MS = 250;
  static SETTINGS_KEY = 'isghe-mandelbrot-settings';
  static SETTINGS_SAVE_MS = 400;
  // Which per-panel schema.view logical keys (see createModel()) hold a
  // DOMPointReadOnly rather than a plain number — used by restoreSettings()
  // below to pick the right validator/constructor per field.
  static POINT_KEYS = new Set(["center"]);
  // Logical keys each model's schema declares, shared by both sides —
  // createModel() derives the flat per-side names from these (see below).
  // Order matters: it's the key order of every object these produce.
  static VIEW_KEYS = ["center", "scale", "maxIter", "paletteType", "progressiveMode", "smoothColoring"];
  static DISPLAY_PREF_KEYS = ["gridOverlay", "centerMarker"];
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

  // Same reasoning as juliaMarker above: marks MANDELBROT_LANDMARKS'
  // positions on the Mandelbrot plane, meaningless on Julia's own z-plane
  // view — see drawOverlayForPanel's showLandmarks.
  landmarksOverlay = 0;

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
  renderHalted = false;
  // Timestamp of the last resizeVisiblePanels() call (window resize, panel
  // visibility toggle, or initial layout) — used only to enrich the deformed-
  // frame diagnostic below with "how recently did the layout change".
  lastResizeAt = 0;

  // view history (Back / Forward)
  history = new ViewHistory(MandelbrotApp.WHEEL_HISTORY_MS, () => this.updateHistoryButtons());
  saveSettingsTimer = null;
  shareBtnResetTimer = null;

  // render scheduling
  rafPending = false;

  constructor() {
    // juliaMode/showJuliaMarker/showLandmarks/onGenuineClick are the only
    // facts that distinguish Mandelbrot from Julia anywhere in this file —
    // supplied once here, at the one call site that has to know which is
    // which. Everything downstream (event wiring, rendering, visibility,
    // snapshotting) operates on this.models generically. Each model's flat
    // URL/localStorage field names (see share.js) are derived from `name`
    // inside createModel() itself, not passed in here — see its comment.
    // Declaration order below is arbitrary: every consumer resolves models
    // by name (modelNamed()) or loops all of them uniformly, never by
    // position — verified by swapping this order and rerunning the suite.
    this.models = [
      this.createModel("julia", { juliaMode: 1, showJuliaMarker: false, showLandmarks: false }),
      this.createModel("mandelbrot", {
        juliaMode: 0, showJuliaMarker: true, showLandmarks: true, onGenuineClick: (p) => this.setJuliaSeed(p),
      }),
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

    // Landmarks menu: curated jump-to points in the Mandelbrot (c-plane)
    // view (see landmarks.js) — meaningless on Julia's own z-plane view, so
    // it's wired directly to the Mandelbrot model here rather than through
    // createModel()'s per-side symmetry, same reasoning as juliaMarkerChk
    // above.
    this.landmarksSel = this.populateLandmarksMenu(document.getElementById("mandelbrotLandmarks"));
    this.landmarksSel.onchange = () => this.onLandmarkChange(this.modelNamed("mandelbrot"));

    // Same app-level pattern as juliaMarkerChk above: draws MANDELBROT_LANDMARKS'
    // positions on the Mandelbrot panel, meaningless on Julia's own view.
    this.landmarksOverlayChk = document.getElementById("landmarksOverlay");
    this.landmarksOverlayChk.checked = !!this.landmarksOverlay;
    this.landmarksOverlayChk.onchange = this.onLandmarksOverlayChange;

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
      model.iter.minus.onclick = () => this.onIterStep(model, -1);
      model.iter.plus.onclick = () => this.onIterStep(model, 1);
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
      this.applyPalette(model, model.panel.paletteType); // builds the initial palette256/bandCount
    }

    window.addEventListener("resize", this.onResize);
    window.addEventListener("keydown", this.onKeyDown);

    this.drawOverlay();
  }

  // Shared by populatePaletteMenu/populateLandmarksMenu: creates one
  // <option>, appends it to `parent` (a <select> or <optgroup>), and
  // returns it.
  addOption(parent, value, label, { title, selected } = {}) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    if (title) option.title = title;
    if (selected) option.selected = true;
    parent.appendChild(option);
    return option;
  }

  // Builds the palette <select>'s <optgroup>/<option> tree from
  // PALETTE_GROUPS (see palette.js) so the two panels' menus can't drift
  // out of sync with each other or with the palette registry.
  populatePaletteMenu(sel) {
    for (const group of PALETTE_GROUPS) {
      const optgroup = document.createElement("optgroup");
      optgroup.label = group.label;
      for (const palette of group.palettes) {
        this.addOption(optgroup, palette.id, palette.label);
      }
      sel.appendChild(optgroup);
    }
    return sel;
  }

  // Builds the Landmarks <select> from MANDELBROT_LANDMARKS (see
  // landmarks.js) — flat (no groups) and indexed by array position rather
  // than a stable id, since landmarks are a curated list, not persisted
  // state (see onLandmarkChange). The placeholder option is what the
  // <select> shows again right after a jump.
  populateLandmarksMenu(sel) {
    this.addOption(sel, "", "Jump to…", { selected: true });
    MANDELBROT_LANDMARKS.forEach((landmark, i) => {
      this.addOption(sel, i, landmark.name, { title: landmark.description });
    });
    return sel;
  }

  // Builds one side's FractalPanel plus its DOM control refs and slider
  // ranges. `name` composes every DOM id mechanically (`${name}Gfx`,
  // `show${Cap}`, `${name}IterSlider`, ...) — index.html has no exceptions
  // to this beyond the Julia-seed-marker and landmarks-overlay checkboxes,
  // both app-level (see constructor). juliaMode/showJuliaMarker/
  // showLandmarks/onGenuineClick are stored right on the model so every
  // later consumer (event wiring, rendering, visibility) can stay agnostic
  // about which side it's looking at. `schema`
  // — the model's flat URL/localStorage field names (see share.js), consumed
  // by snapshotView()/shareState()/captureDisplayPrefs()/
  // restoreDisplayPrefs()/restoreSettings() below — is derived from `name`
  // the same mechanical way as the DOM ids above, not passed in: every flat
  // name is `${name}Panel${Cap(key)}` (show is `show${cap}`, already
  // computed below for showChk) with zero exceptions, so writing it out by
  // hand twice per model was a fourth copy of a formula already applied
  // three other places (this method's DOM ids, share.js's own field names,
  // and the pinning test's literal key lists).
  createModel(name, { juliaMode, showJuliaMarker, showLandmarks, onGenuineClick }) {
    const cap = name[0].toUpperCase() + name.slice(1);
    const prefix = `${name}Panel`;
    const flat = (key) => prefix + key[0].toUpperCase() + key.slice(1);
    const schema = {
      panel: prefix,
      view: Object.fromEntries(MandelbrotApp.VIEW_KEYS.map((key) => [key, flat(key)])),
      displayPrefs: Object.fromEntries(MandelbrotApp.DISPLAY_PREF_KEYS.map((key) => [key, flat(key)])),
      show: `show${cap}`,
    };
    const model = {
      name,
      panel: new FractalPanel(document.getElementById(`${name}Gfx`), document.getElementById(`${name}Overlay`)),
      show: 1,
      juliaMode,
      showJuliaMarker,
      showLandmarks,
      onGenuineClick,
      schema,
      iter: {
        slider: document.getElementById(`${name}IterSlider`),
        label: document.getElementById(`${name}IterLabel`),
        minus: document.getElementById(`${name}IterMinus`),
        plus: document.getElementById(`${name}IterPlus`),
      },
      zoom: { slider: document.getElementById(`${name}ZoomSlider`), label: document.getElementById(`${name}ZoomLabel`) },
      palette: { sel: this.populatePaletteMenu(document.getElementById(`${name}PaletteType`)) },
      progressive: { chk: document.getElementById(`${name}ProgressiveMode`) },
      smoothColoring: { chk: document.getElementById(`${name}SmoothColoring`) },
      gridOverlay: { chk: document.getElementById(`${name}GridOverlay`) },
      centerMarker: { chk: document.getElementById(`${name}CenterMarker`) },
      pendingSnapshot: { iter: null, zoom: null },
      showChk: document.getElementById(`show${cap}`),
      uiSection: document.getElementById(`ui${cap}`),
    };
    for (const [obj, bounds] of [[model.iter, MandelbrotApp.ITER], [model.zoom, MandelbrotApp.SCALE]]) {
      obj.slider.min = Math.log10(bounds.min);
      obj.slider.max = Math.log10(bounds.max);
    }
    return model;
  }

  setPanelScale(model, next) {
    model.panel.setScale(next, MandelbrotApp.SCALE);
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
    return settings.snapshotView(this);
  }

  // share.js expects this flat shape (schema v5): exactly the union of
  // Tier 1 (flattened) and Tier 2 — every field either function already
  // produces, so this is their composition rather than a third hand-written
  // copy of the same field list. See settings.js for the implementation.
  shareState() {
    return settings.shareState(this);
  }

  // Tier 2 ("display preferences"): overlay toggles (per panel) and panel
  // visibility — persisted (see shareState() above) but deliberately outside
  // undo history, unlike snapshotView()'s Tier 1. See settings.js for the
  // implementation.
  captureDisplayPrefs() {
    return settings.captureDisplayPrefs(this);
  }

  restoreDisplayPrefs(p) {
    for (const model of this.models) {
      for (const [key, flatName] of Object.entries(model.schema.displayPrefs)) {
        model.panel[key] = p[flatName];
        model[key].chk.checked = !!p[flatName];
      }
      model.show = p[model.schema.show];
      model.showChk.checked = !!p[model.schema.show];
    }
    this.juliaMarker = p.juliaMarker;
    this.juliaMarkerChk.checked = !!p.juliaMarker;
    this.landmarksOverlay = p.landmarksOverlay;
    this.landmarksOverlayChk.checked = !!p.landmarksOverlay;

    this.updatePanelVisibility();
    this.resizeVisiblePanels();
  }

  saveSettings() {
    settings.saveSettings(this);
  }

  loadSettings() {
    return settings.loadSettings(this);
  }

  scheduleSaveSettings = () => {
    settings.scheduleSaveSettings(this);
  };

  // share.js's buildShareUrl diffs the live shareState() against this same
  // flat shape applied to this.initialState (snapshotView()'s nested Tier 1
  // shape, used for applySnapshot/Reset) — hence the bridge. See settings.js
  // for the implementation and the disambiguation from share.js's own
  // buildShareUrl.
  flattenSnapshotForShare(s) {
    return settings.flattenSnapshotForShare(this, s);
  }

  buildShareUrl() {
    return settings.buildShareUrl(this);
  }

  restoreSettings() {
    settings.restoreSettings(this);
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
    for (const model of this.models) this.applyPanelSnapshot(model, s[model.schema.panel]);
    this.juliaSeed = s.juliaSeed;
    this.scheduleRender();
  }

  static clampMaxIter(next) {
    return Math.round(Math.min(MandelbrotApp.ITER.max, Math.max(MandelbrotApp.ITER.min, next)));
  }

  // History bookkeeping (pushHistory) is done by the caller (see the
  // sliders' onchange/pendingSnapshot handling and applySnapshot above) —
  // symmetric with setPanelScale above, one method for both panels.
  setMaxIter(model, next) {
    const clamped = MandelbrotApp.clampMaxIter(next);
    model.panel.maxIter = clamped;
    model.iter.slider.value = Math.log10(clamped);
    model.iter.label.textContent = clamped;
  }

  resizeVisiblePanels() {
    this.lastResizeAt = Date.now();
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

  // `showJuliaMarker`/`showLandmarks` are false for the Julia panel itself:
  // both mark points on the *Mandelbrot* plane, meaningless overlaid on the
  // Julia panel's own view.
  drawOverlayForPanel(panel, { showJuliaMarker, showLandmarks }) {
    const ctx = panel.overlayCtx;
    const w = panel.overlayCssWidth;
    const h = panel.overlayCssHeight;
    const aspect = panel.canvas.width / panel.canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (panel.gridOverlay) overlay.drawGrid(ctx, w, h, panel.center, panel.scale, aspect);
    if (panel.centerMarker) overlay.drawCenterMarker(ctx, w, h, panel.center, panel.scale, aspect);
    if (showJuliaMarker && this.juliaMarker) overlay.drawJuliaMarker(ctx, w, h, this.juliaSeed, panel.center, panel.scale, aspect);
    if (showLandmarks && this.landmarksOverlay) overlay.drawLandmarks(ctx, w, h, panel.center, panel.scale, aspect);
  }

  drawOverlay = () => {
    for (const { panel, showJuliaMarker, showLandmarks } of this.panels) {
      this.drawOverlayForPanel(panel, { showJuliaMarker, showLandmarks });
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

  // Every panel's scale/maxIter/canvas size at the moment of a fatal GPU
  // error — the raw WebGPU/driver message alone doesn't say what the app was
  // doing when it was flagged (which panel, how deep the zoom, how many
  // iterations — see the double-single precision floor), so this gets logged
  // alongside it, letting a recurrence be root-caused instead of just
  // re-observed.
  appStateSnapshot() {
    const snapshot = this.models.map((model) => ({
      name: model.name,
      show: !!model.show,
      scale: model.panel.scale,
      maxIter: model.panel.maxIter,
      canvas: `${model.panel.canvas.width}x${model.panel.canvas.height}`,
    }));
    return `devicePixelRatio=${window.devicePixelRatio || 1}, `
      + `msSinceLastResize=${Date.now() - this.lastResizeAt}, panels=${JSON.stringify(snapshot)}`;
  }

  // Not just a banner: an uncaptured GPU error means the device already
  // signaled a problem, so any frame rendered from here on (until reload)
  // can't be trusted — e.g. the transient X-squashed Mandelbrot seen during
  // a deep, high-iteration zoom coincided with one of these. Same
  // fatal/halt treatment as onDeviceLost, not a lesser one. Extracted from
  // initGPU's device wiring so it's testable without a real/mocked GPU
  // device.
  handleUncapturedError(message) {
    this.renderHalted = true;
    console.error(`WebGPU uncaptured error at ${new Date().toISOString()}: ${message}\nContext: ${this.appStateSnapshot()}`);
    this.showFatalError(`WebGPU error: ${message}`);
  }

  // A real device loss (e.g. a driver-level DEVICE_HUNG/TDR after too long a
  // shader pass at extreme zoom/iteration counts) can leave the swapchain's
  // last presented frame visibly corrupted — the frame frozen behind this
  // banner, not just this message, is evidence worth capturing.
  handleDeviceLost(info) {
    this.deviceLost = true;
    console.error(`WebGPU device lost at ${new Date().toISOString()} (${info.reason}): ${info.message}\nContext: ${this.appStateSnapshot()}`);
    this.showFatalError(`WebGPU device lost (${info.reason}): ${info.message}`);
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
      onDeviceLost: (info) => this.handleDeviceLost(info),
      onUncapturedError: (message) => this.handleUncapturedError(message),
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
    model.panel.bandCount = paletteBandCount(type);
    // Bands take precedence over smooth coloring in the shader (see
    // mandelbrot.wgsl) - disable the checkbox so the GUI doesn't promise an
    // effect that isn't there.
    model.smoothColoring.chk.disabled = model.panel.bandCount > 0;
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

  onIterStep(model, delta) {
    // Skip the history push (and re-render) entirely when already at
    // ITER.min/ITER.max — otherwise a step at the clamp boundary is a no-op
    // that still pollutes Back/Forward with a state identical to the last.
    const clamped = MandelbrotApp.clampMaxIter(model.panel.maxIter + delta);
    if (clamped === model.panel.maxIter) return;
    this.history.push(this.snapshotView());
    this.setMaxIter(model, clamped);
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

  // Recenters the Mandelbrot panel on a curated landmark, keeping its
  // current zoom/iterations so the jump composes with whatever quality
  // settings are already in effect — same center/pivot bookkeeping as a
  // drag-end or selection-rect recenter (fractalPanel.js's onPointerUp),
  // not a genuine click (which only moves pivot, not center). Not part of
  // any model's schema: it's a one-shot navigation action, not persisted
  // state, so the <select> resets to its placeholder right after.
  onLandmarkChange(model) {
    // Guards both "no selection" and the placeholder itself: Number("") is
    // 0, which would otherwise resolve to MANDELBROT_LANDMARKS[0] instead
    // of a no-op.
    if (this.landmarksSel.value === "") return;
    const landmark = MANDELBROT_LANDMARKS[Number(this.landmarksSel.value)];
    if (!landmark) return;
    this.history.push(this.snapshotView());
    model.panel.center = new DOMPointReadOnly(landmark.x, landmark.y);
    model.panel.pivot = model.panel.center;
    model.panel.pivotScreen = new DOMPointReadOnly(0.5, 0.5);
    this.resetProgressive(model.panel);
    this.landmarksSel.value = "";
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
  // model" — used by setJuliaSeed, genuinely side-specific (the other former
  // user, restoreSettings(), now drives its dispatch off model.schema in a
  // loop over this.models instead). Throws on a bad name (e.g. a typo in a
  // createModel() call site) instead of handing back undefined for a
  // confusing failure several lines later.
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
    this.drawOverlay();
    this.scheduleSaveSettings();
  }

  onCenterMarkerChange(model) {
    model.panel.centerMarker = model.centerMarker.chk.checked ? 1 : 0;
    this.drawOverlay();
    this.scheduleSaveSettings();
  }

  onJuliaMarkerChange = () => {
    this.juliaMarker = this.juliaMarkerChk.checked ? 1 : 0;
    this.drawOverlay();
    this.scheduleSaveSettings();
  };

  onLandmarksOverlayChange = () => {
    this.landmarksOverlay = this.landmarksOverlayChk.checked ? 1 : 0;
    this.drawOverlay();
    this.scheduleSaveSettings();
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
        scaleBounds: MandelbrotApp.SCALE,
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
        scaleBounds: MandelbrotApp.SCALE,
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
  // Guards against writing a visibly deformed frame (e.g. an X-squashed
  // Mandelbrot) caused by a stale/torn canvas backing-store size — seen once
  // in the wild coinciding with a WebGPU error during a deep, high-iteration
  // zoom (getBoundingClientRect() read mid-layout-thrash leaving the backing
  // store's X/Y ratio out of sync with the canvas's actual on-screen shape).
  // The shader only applies aspect correction to X (mandelbrot.wgsl), so any
  // such mismatch shows up as an X-only squash/stretch. Rather than let a
  // corrupt frame reach the screen, halt all rendering and surface the
  // reason, same as a fatal device loss.
  isDeformedFrame(panel) {
    const { width: bw, height: bh } = panel.canvas;
    const rect = panel.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false; // panel hidden/collapsed, not a render pass
    const backingAspect = bw / bh;
    const cssAspect = rect.width / rect.height;
    if (!Number.isFinite(backingAspect) || !Number.isFinite(cssAspect)) return true;
    return Math.abs(backingAspect - cssAspect) / cssAspect > 0.01;
  }

  // Logs the diagnostic and halts the whole app (not just this panel) on a
  // detected deformation — see isDeformedFrame's comment for why.
  reportDeformedFrame(panel) {
    const { width: bw, height: bh } = panel.canvas;
    const rect = panel.canvas.getBoundingClientRect();
    // Diagnostic context beyond the raw mismatch, so a recurrence can be
    // root-caused rather than just re-confirmed: how recently the layout
    // changed (resize/panel-toggle — the suspected trigger), the zoom
    // depth/iteration count in play, and whether a WebGPU error was
    // already in flight when this was detected.
    const msg = `Deformed frame detected on panel "${panel.canvas.id}" at ${new Date().toISOString()}: `
      + `canvas backing store ${bw}x${bh} (aspect ${(bw / bh).toFixed(4)}) does not match on-screen size `
      + `${rect.width.toFixed(1)}x${rect.height.toFixed(1)} (aspect ${(rect.width / rect.height).toFixed(4)}) — halting rendering. `
      + `Context: scale=${panel.scale}, maxIter=${panel.maxIter}, devicePixelRatio=${window.devicePixelRatio || 1}, `
      + `msSinceLastResize=${Date.now() - this.lastResizeAt}, deviceLost=${this.deviceLost}.`;
    console.error(msg);
    this.renderHalted = true;
    this.showFatalError(msg);
  }

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
      bandCount: panel.bandCount,
    });
    panel.renderer.render(data);
  }

  // RENDER. Each visible panel ramps toward its own maxIter independently;
  // scheduleRender's re-arm check (this.anyProgressiveBelowCap) re-arms while
  // at least one panel's ramp hasn't yet reached its own cap.
  renderOnce = () => {
    // Gated on deviceLost/renderHalted, not on any single panel's renderer —
    // renderPanel already skips a panel whose own renderer isn't attached
    // yet, so a missing Mandelbrot renderer shouldn't also block an
    // already-ready Julia panel from rendering.
    if (this.deviceLost || this.renderHalted) {
      this.anyProgressiveBelowCap = false;
      return;
    }

    // Checked for every visible, GPU-attached panel before any of them is
    // rendered — agnostic of which side it is, Mandelbrot or Julia: a
    // deformity on either one must block the whole frame, including an
    // otherwise-healthy other panel that would otherwise have already been
    // submitted to the GPU by the time the deformed one is reached below.
    // Skips panels not yet attached to a renderer (pre-initGPU) — nothing to
    // deform yet, and isDeformedFrame's on-screen-size check can be noisy
    // before the page's first layout pass has settled.
    for (const { panel } of this.panels) {
      if (panel.renderer && this.isDeformedFrame(panel)) {
        this.reportDeformedFrame(panel);
        this.anyProgressiveBelowCap = false;
        return;
      }
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

// Unit tests import this module for the MandelbrotApp class itself and set
// this flag first to skip the real app's construction (GPU + full DOM).
if (!globalThis.__MANDELBROT_TEST__) {
  const app = new MandelbrotApp();
  window.app = app; // exposed for e2e test assertions on internal state (tests/)
  try {
    await app.init();
  } catch (e) {
    app.showError(`Failed to initialize WebGPU: ${e.message}`);
  }
}
