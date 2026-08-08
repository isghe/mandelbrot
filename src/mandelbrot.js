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
  // (URL/localStorage, see share.js) to their live location on
  // this.mandelbrot/this.julia — used by restoreSettings()'s generic
  // dispatch below. Third element is true for the handful of fields that
  // live directly on the model object (e.g. `.show`) rather than on `.panel`.
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
  // Visibility toggling operates on DOM elements that exist from page load.
  // Both panels' FractalPanel wrappers are constructed eagerly in the
  // constructor, so showing/hiding is purely a CSS concern here. This table
  // is what makes updatePanelVisibility() generic instead of one hardcoded
  // branch per panel.
  static PANEL_VISIBILITY = [
    { canvasId: "mandelbrotGfx", overlayId: "mandelbrotOverlay", uiSectionId: "uiMandelbrot", side: "mandelbrot" },
    { canvasId: "juliaGfx", overlayId: "juliaOverlay", uiSectionId: "uiJulia", side: "julia" },
  ];

  // State (JS = f64). maxIter/paletteType/smoothColoring/progressiveMode/
  // gridOverlay/centerMarker live per-panel (this.mandelbrot.panel.X /
  // this.julia.panel.X) — see FractalPanel. juliaSeed is the one piece of
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
  // actually put to use from the first frame. Lives as `.show` on
  // this.mandelbrot/this.julia (see constructor), not a flat field here.

  // Set once the shared WebGPU device is lost; blocks further render
  // attempts on both panels (the device, not the canvas, was lost).
  deviceLost = false;

  // view history (Back / Forward)
  history = new ViewHistory(MandelbrotApp.WHEEL_HISTORY_MS, () => this.updateHistoryButtons());
  saveSettingsTimer = null;
  shareBtnResetTimer = null;

  // render scheduling
  rafPending = false;

  constructor(canvas) {
    // juliaMode/showJuliaMarker are fixed, intrinsic to each side (not
    // restored/toggled at runtime) — living here means `get panels()` below
    // doesn't need to hardcode them per branch.
    this.mandelbrot = { panel: new FractalPanel(canvas, document.getElementById("mandelbrotOverlay")), show: 1, juliaMode: 0, showJuliaMarker: true };
    // Julia is constructed eagerly too (symmetric with Mandelbrot), so both
    // panels are always live; the DOM refs and GPU renderer are wired later
    // (below, and in initGPU) the same way Mandelbrot's are. Visibility
    // (.show) defaults to shown for both — see updatePanelVisibility().
    this.julia = { panel: new FractalPanel(document.getElementById("juliaGfx"), document.getElementById("juliaOverlay")), show: 1, juliaMode: 1, showJuliaMarker: false };
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
    // this.mandelbrot / this.julia are per-side namespaces: `.panel` (set
    // above) holds the FractalPanel (view/quality state); the DOM control
    // refs added below (sliders, labels, selects, checkboxes) are its
    // sibling keys.
    Object.assign(this.mandelbrot, {
      iter: { slider: document.getElementById("mandelbrotIterSlider"), label: document.getElementById("mandelbrotIterLabel") },
      zoom: { slider: document.getElementById("mandelbrotZoomSlider"), label: document.getElementById("mandelbrotZoomLabel") },
      palette: { sel: document.getElementById("mandelbrotPaletteType") },
      progressive: { chk: document.getElementById("mandelbrotProgressiveMode") },
      smoothColoring: { chk: document.getElementById("mandelbrotSmoothColoring") },
      gridOverlay: { chk: document.getElementById("mandelbrotGridOverlay") },
      centerMarker: { chk: document.getElementById("mandelbrotCenterMarker") },
      pendingSnapshot: { iter: null, zoom: null },
      showChk: document.getElementById("showMandelbrot"),
    });
    this.mandelbrot.iter.slider.min = Math.log10(MandelbrotApp.MIN_ITER);
    this.mandelbrot.iter.slider.max = Math.log10(MandelbrotApp.MAX_ITER);
    this.mandelbrot.zoom.slider.min = Math.log10(MandelbrotApp.MIN_SCALE);
    this.mandelbrot.zoom.slider.max = Math.log10(MandelbrotApp.MAX_SCALE);

    // Julia's own controls, independent of the Mandelbrot ones above —
    // synced to the live juliaPanel's field values further down in this
    // constructor (panelCheckboxFields, setMaxIter(this.julia)/
    // syncZoomSliderUI(this.julia)/this.julia.palette.sel), symmetric with Mandelbrot's.
    Object.assign(this.julia, {
      iter: { slider: document.getElementById("juliaIterSlider"), label: document.getElementById("juliaIterLabel") },
      zoom: { slider: document.getElementById("juliaZoomSlider"), label: document.getElementById("juliaZoomLabel") },
      palette: { sel: document.getElementById("juliaPaletteType") },
      progressive: { chk: document.getElementById("juliaProgressiveMode") },
      smoothColoring: { chk: document.getElementById("juliaSmoothColoring") },
      gridOverlay: { chk: document.getElementById("juliaGridOverlay") },
      centerMarker: { chk: document.getElementById("juliaCenterMarker") },
      marker: { chk: document.getElementById("juliaMarker") },
      pendingSnapshot: { iter: null, zoom: null },
      showChk: document.getElementById("showJulia"),
    });
    this.julia.iter.slider.min = Math.log10(MandelbrotApp.MIN_ITER);
    this.julia.iter.slider.max = Math.log10(MandelbrotApp.MAX_ITER);
    this.julia.zoom.slider.min = Math.log10(MandelbrotApp.MIN_SCALE);
    this.julia.zoom.slider.max = Math.log10(MandelbrotApp.MAX_SCALE);

    for (const model of [this.mandelbrot, this.julia]) {
      model.showChk.checked = !!model.show;
    }
    this.julia.marker.chk.checked = !!this.juliaMarker;
    // [UI group key, FractalPanel field name] — mostly identical, except
    // "progressive" (UI) vs "progressiveMode" (FractalPanel), kept short on
    // the UI side since this.mandelbrot.progressive/this.julia.progressive
    // already reads unambiguously as the progressive-mode control.
    const panelCheckboxFields = [
      ["centerMarker", "centerMarker"],
      ["gridOverlay", "gridOverlay"],
      ["progressive", "progressiveMode"],
      ["smoothColoring", "smoothColoring"],
    ];
    panelCheckboxFields.forEach(([group, field]) => { this.mandelbrot[group].chk.checked = !!this.mandelbrot.panel[field]; });
    panelCheckboxFields.forEach(([group, field]) => { this.julia[group].chk.checked = !!this.julia.panel[field]; });
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
    this.mandelbrot.palette.sel.value = this.mandelbrot.panel.paletteType;
    this.julia.palette.sel.value = this.julia.panel.paletteType;
    this.backBtn    = document.getElementById("backBtn");
    this.forwardBtn = document.getElementById("forwardBtn");
    this.resetBtn   = document.getElementById("resetBtn");
    this.shareBtn   = document.getElementById("shareBtn");

    this.mandelbrot.iter.slider.oninput = () => this.onIterInput(this.mandelbrot);
    this.mandelbrot.iter.slider.onchange = () => this.commitPendingSnapshot(this.mandelbrot, "iter");
    this.mandelbrot.zoom.slider.oninput = () => this.onZoomInput(this.mandelbrot);
    this.mandelbrot.zoom.slider.onchange = () => this.commitPendingSnapshot(this.mandelbrot, "zoom");
    this.mandelbrot.palette.sel.onchange = () => this.onPaletteChange(this.mandelbrot);
    this.mandelbrot.showChk.onchange = this.onPanelVisibilityChange;
    this.julia.showChk.onchange = this.onPanelVisibilityChange;
    this.mandelbrot.progressive.chk.onchange = () => this.onProgressiveChange(this.mandelbrot);
    this.mandelbrot.smoothColoring.chk.onchange = () => this.onSmoothColoringChange(this.mandelbrot);
    this.mandelbrot.gridOverlay.chk.onchange = () => this.onGridOverlayChange(this.mandelbrot);
    this.mandelbrot.centerMarker.chk.onchange = () => this.onCenterMarkerChange(this.mandelbrot);
    this.julia.marker.chk.onchange = this.onJuliaMarkerChange;

    // Julia's own controls — symmetric with Mandelbrot's above, including
    // the same debounce-on-release pattern for the sliders.
    this.julia.iter.slider.oninput = () => this.onIterInput(this.julia);
    this.julia.iter.slider.onchange = () => this.commitPendingSnapshot(this.julia, "iter");
    this.julia.zoom.slider.oninput = () => this.onZoomInput(this.julia);
    this.julia.zoom.slider.onchange = () => this.commitPendingSnapshot(this.julia, "zoom");
    this.julia.palette.sel.onchange = () => this.onPaletteChange(this.julia);
    this.julia.progressive.chk.onchange = () => this.onProgressiveChange(this.julia);
    this.julia.smoothColoring.chk.onchange = () => this.onSmoothColoringChange(this.julia);
    this.julia.gridOverlay.chk.onchange = () => this.onGridOverlayChange(this.julia);
    this.julia.centerMarker.chk.onchange = () => this.onCenterMarkerChange(this.julia);

    this.backBtn.onclick    = this.onBack;
    this.forwardBtn.onclick = this.onForward;
    this.resetBtn.onclick   = this.onReset;
    this.shareBtn.onclick   = this.onShare;
    this.uiToggleBtn.onclick = this.onUiToggle;

    this.attachPanelEvents({
      panel: this.mandelbrot.panel,
      hooks: {
        pushHistory: (s) => this.history.push(s),
        armWheelHistory: () => this.history.armWheel(() => this.snapshotView()),
        onScaleChange: () => this.syncZoomSliderUI(this.mandelbrot),
        // Only the Mandelbrot panel's genuine click sets the shared Julia
        // seed — see attachPanelEvents' hooks param.
        onGenuineClick: (fractalPoint) => {
          this.juliaSeed = fractalPoint;
          // Only the Julia panel's render actually depends on juliaSeed
          // (its escape set changes; the Mandelbrot panel's own image
          // doesn't) — reset just Julia's progressive ramp, not Mandelbrot's.
          if (this.julia.show) this.resetProgressive(this.julia.panel);
        },
      },
    });
    // Julia's own pan/zoom/quality is Tier 1 too (History A, symmetric with
    // Mandelbrot). No onGenuineClick: clicking inside the Julia panel only
    // moves its own pivot/zoom anchor, it never sets juliaSeed (only a click
    // on the Mandelbrot panel does that).
    this.attachPanelEvents({
      panel: this.julia.panel,
      hooks: {
        pushHistory: (snapshot) => this.history.push(snapshot),
        armWheelHistory: () => this.history.armWheel(() => this.snapshotView()),
        onScaleChange: () => this.syncZoomSliderUI(this.julia),
      },
    });
    window.addEventListener("resize", this.onResize);
    window.addEventListener("keydown", this.onKeyDown);

    this.setPanelScale(this.mandelbrot, this.mandelbrot.panel.scale);
    this.setMaxIter(this.mandelbrot, this.mandelbrot.panel.maxIter);
    this.mandelbrot.panel.palette256 = makePalette(this.mandelbrot.panel.paletteType);
    // Julia's own iter/zoom slider sync + GPU palette (symmetric with the
    // three Mandelbrot lines above); the renderer attaches in initGPU().
    this.setMaxIter(this.julia, this.julia.panel.maxIter);
    this.setPanelScale(this.julia, this.julia.panel.scale);
    this.julia.panel.palette256 = makePalette(this.julia.panel.paletteType);

    this.drawOverlay();
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
    return {
      mandelbrotPanel: {
        center: this.mandelbrot.panel.center,
        scale: this.mandelbrot.panel.scale,
        maxIter: this.mandelbrot.panel.maxIter,
        paletteType: this.mandelbrot.panel.paletteType,
        smoothColoring: this.mandelbrot.panel.smoothColoring,
        progressiveMode: this.mandelbrot.panel.progressiveMode,
      },
      juliaPanel: {
        center: this.julia.panel.center,
        scale: this.julia.panel.scale,
        maxIter: this.julia.panel.maxIter,
        paletteType: this.julia.panel.paletteType,
        smoothColoring: this.julia.panel.smoothColoring,
        progressiveMode: this.julia.panel.progressiveMode,
      },
      juliaSeed: this.juliaSeed,
    };
  }

  // share.js expects this flat shape (schema v5), distinct from
  // snapshotView()'s nested Tier 1 shape used for undo-history/Reset — see
  // flattenSnapshotForShare() below for the bridge between the two.
  shareState() {
    return {
      mandelbrotPanelCenter: this.mandelbrot.panel.center,
      mandelbrotPanelScale: this.mandelbrot.panel.scale,
      mandelbrotPanelMaxIter: this.mandelbrot.panel.maxIter,
      mandelbrotPanelPaletteType: this.mandelbrot.panel.paletteType,
      mandelbrotPanelProgressiveMode: this.mandelbrot.panel.progressiveMode,
      mandelbrotPanelSmoothColoring: this.mandelbrot.panel.smoothColoring,
      mandelbrotPanelGridOverlay: this.mandelbrot.panel.gridOverlay,
      mandelbrotPanelCenterMarker: this.mandelbrot.panel.centerMarker,
      juliaSeed: this.juliaSeed,
      juliaPanelCenter: this.julia.panel.center,
      juliaPanelScale: this.julia.panel.scale,
      juliaPanelMaxIter: this.julia.panel.maxIter,
      juliaPanelPaletteType: this.julia.panel.paletteType,
      juliaPanelProgressiveMode: this.julia.panel.progressiveMode,
      juliaPanelSmoothColoring: this.julia.panel.smoothColoring,
      juliaPanelGridOverlay: this.julia.panel.gridOverlay,
      juliaPanelCenterMarker: this.julia.panel.centerMarker,
      juliaMarker: this.juliaMarker,
      showMandelbrot: this.mandelbrot.show,
      showJulia: this.julia.show,
    };
  }

  // Tier 2 ("display preferences"): overlay toggles (per panel) and panel
  // visibility — persisted (see shareState() above) but deliberately outside
  // undo history, unlike snapshotView()'s Tier 1. juliaMarker stays a single
  // app-level flag (it marks where juliaSeed sits on the Mandelbrot plane,
  // meaningless on Julia's own view — see drawOverlayForPanel).
  captureDisplayPrefs() {
    return {
      mandelbrotPanelGridOverlay: this.mandelbrot.panel.gridOverlay,
      mandelbrotPanelCenterMarker: this.mandelbrot.panel.centerMarker,
      juliaPanelGridOverlay: this.julia.panel.gridOverlay,
      juliaPanelCenterMarker: this.julia.panel.centerMarker,
      juliaMarker: this.juliaMarker,
      showMandelbrot: this.mandelbrot.show,
      showJulia: this.julia.show,
    };
  }

  restoreDisplayPrefs(p) {
    this.mandelbrot.panel.gridOverlay = p.mandelbrotPanelGridOverlay;
    this.mandelbrot.gridOverlay.chk.checked = !!p.mandelbrotPanelGridOverlay;
    this.mandelbrot.panel.centerMarker = p.mandelbrotPanelCenterMarker;
    this.mandelbrot.centerMarker.chk.checked = !!p.mandelbrotPanelCenterMarker;
    this.julia.panel.gridOverlay = p.juliaPanelGridOverlay;
    this.julia.gridOverlay.chk.checked = !!p.juliaPanelGridOverlay;
    this.julia.panel.centerMarker = p.juliaPanelCenterMarker;
    this.julia.centerMarker.chk.checked = !!p.juliaPanelCenterMarker;
    this.juliaMarker = p.juliaMarker;
    this.julia.marker.chk.checked = !!p.juliaMarker;

    this.mandelbrot.show = p.showMandelbrot;
    this.mandelbrot.showChk.checked = !!p.showMandelbrot;
    this.julia.show = p.showJulia;
    this.julia.showChk.checked = !!p.showJulia;
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
        const [side, key, onGroup] = mapped;
        if (onGroup) this[side][key] = value;
        else this[side].panel[key] = value;
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
    // routes them through PANEL_FIELD_MAP to this.mandelbrot.panel/
    // this.julia.panel (or, for showMandelbrot/showJulia, directly onto
    // this.mandelbrot/this.julia, both always live — constructed eagerly
    // above). juliaSeed/juliaMarker are the only truly flat app-level fields
    // left, and fall through to plain this[flatName] = value.
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

    this.mandelbrot.panel.pivot = this.mandelbrot.panel.center;
    this.julia.panel.pivot = this.julia.panel.center;

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
    this.applyPanelSnapshot(this.mandelbrot, s.mandelbrotPanel);
    this.applyPanelSnapshot(this.julia, s.juliaPanel);
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
    const [mRenderer, jRenderer] = await Promise.all([
      attachCanvas(this.gpuDevice, this.mandelbrot.panel.canvas, this.mandelbrot.panel.palette256),
      attachCanvas(this.gpuDevice, this.julia.panel.canvas, this.julia.panel.palette256),
    ]);
    this.mandelbrot.panel.renderer = mRenderer;
    this.julia.panel.renderer = jRenderer;
    this.scheduleRender();
  }

  // Resets one panel's own progressive-reveal ramp.
  resetProgressive(panel) {
    panel.progressiveIter = 1;
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
    this.mandelbrot.show = this.mandelbrot.showChk.checked ? 1 : 0;
    this.julia.show = this.julia.showChk.checked ? 1 : 0;
    this.updatePanelVisibility();
    // The CSS width of a shown panel changes (100vw <-> 50vw) the instant
    // its visibility changes; refresh its backing store now rather than
    // waiting for the next window resize, or the image stays stretched.
    this.resizeVisiblePanels();
    this.scheduleRender();
  };

  updatePanelVisibility() {
    document.body.classList.toggle("dual-view", !!(this.mandelbrot.show && this.julia.show));
    let anyVisible = false;
    for (const { canvasId, overlayId, uiSectionId, side } of MandelbrotApp.PANEL_VISIBILITY) {
      const show = !!this[side].show;
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
  // over. Both panels always exist; only visibility (`.show`) gates
  // inclusion here. Each model object already carries its own `panel`/
  // `juliaMode`/`showJuliaMarker` (set once in the constructor), so this is
  // purely a filter, not a per-branch literal.
  get panels() {
    const list = [];
    if (this.mandelbrot.show) list.push(this.mandelbrot);
    if (this.julia.show) list.push(this.julia);
    return list;
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
    this.juliaMarker = this.julia.marker.chk.checked ? 1 : 0;
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
    this.mandelbrot.pendingSnapshot.iter = null;
    this.mandelbrot.pendingSnapshot.zoom = null;
    this.julia.pendingSnapshot.iter = null;
    this.julia.pendingSnapshot.zoom = null;
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

const app = new MandelbrotApp(document.getElementById("mandelbrotGfx"));
window.app = app; // exposed for e2e test assertions on internal state (tests/)
try {
  await app.init();
} catch (e) {
  app.showError(`Failed to initialize WebGPU: ${e.message}`);
}
