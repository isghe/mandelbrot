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
  // Bridges the flat mandelbrotPanelX/juliaPanelX schema field names (URL/
  // localStorage, see share.js) to their live location on this.mandelbrot.panel/
  // this.julia.panel — used by restoreSettings()'s generic dispatch below.
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
  };
  // Visibility toggling operates on DOM elements that exist from page load.
  // Both panels' FractalPanel wrappers are constructed eagerly in the
  // constructor, so showing/hiding is purely a CSS concern here. This table
  // is what makes updatePanelVisibility() generic instead of one hardcoded
  // branch per panel.
  static PANEL_VISIBILITY = [
    { canvasId: "mandelbrotGfx", overlayId: "mandelbrotOverlay", uiSectionId: "uiMandelbrot", showField: "showMandelbrot" },
    { canvasId: "juliaGfx", overlayId: "juliaOverlay", uiSectionId: "uiJulia", showField: "showJulia" },
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
  // actually put to use from the first frame.
  showMandelbrot = 1;
  showJulia = 1;

  // Set once the shared WebGPU device is lost; blocks further render
  // attempts on both panels (the device, not the canvas, was lost).
  deviceLost = false;

  // view history (Back / Forward)
  history = new ViewHistory(MandelbrotApp.WHEEL_HISTORY_MS, () => this.updateHistoryButtons());
  mandelbrotPendingZoomSnapshot = null;
  mandelbrotPendingIterSnapshot = null;
  juliaPendingZoomSnapshot = null;
  juliaPendingIterSnapshot = null;
  saveSettingsTimer = null;
  shareBtnResetTimer = null;

  // render scheduling
  rafPending = false;

  constructor(canvas) {
    this.mandelbrot = { panel: new FractalPanel(canvas, document.getElementById("mandelbrotOverlay")) };
    // Julia is constructed eagerly too (symmetric with Mandelbrot), so both
    // panels are always live; the DOM refs and GPU renderer are wired later
    // (below, and in initGPU) the same way Mandelbrot's are. Visibility is a
    // separate concern (showJulia + updatePanelVisibility).
    this.julia = { panel: new FractalPanel(document.getElementById("juliaGfx"), document.getElementById("juliaOverlay")) };
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
    });
    this.mandelbrot.iter.slider.min = Math.log10(MandelbrotApp.MIN_ITER);
    this.mandelbrot.iter.slider.max = Math.log10(MandelbrotApp.MAX_ITER);
    this.mandelbrot.zoom.slider.min = Math.log10(MandelbrotApp.MIN_SCALE);
    this.mandelbrot.zoom.slider.max = Math.log10(MandelbrotApp.MAX_SCALE);
    this.showMandelbrotChk = document.getElementById("showMandelbrot");
    this.showJuliaChk = document.getElementById("showJulia");

    // Julia's own controls, independent of the Mandelbrot ones above —
    // synced to the live juliaPanel's field values further down in this
    // constructor (panelCheckboxFields, setJuliaMaxIter/
    // syncJuliaZoomSliderUI/this.julia.palette.sel), symmetric with Mandelbrot's.
    Object.assign(this.julia, {
      iter: { slider: document.getElementById("juliaIterSlider"), label: document.getElementById("juliaIterLabel") },
      zoom: { slider: document.getElementById("juliaZoomSlider"), label: document.getElementById("juliaZoomLabel") },
      palette: { sel: document.getElementById("juliaPaletteType") },
      progressive: { chk: document.getElementById("juliaProgressiveMode") },
      smoothColoring: { chk: document.getElementById("juliaSmoothColoring") },
      gridOverlay: { chk: document.getElementById("juliaGridOverlay") },
      centerMarker: { chk: document.getElementById("juliaCenterMarker") },
      marker: { chk: document.getElementById("juliaMarker") },
    });
    this.julia.iter.slider.min = Math.log10(MandelbrotApp.MIN_ITER);
    this.julia.iter.slider.max = Math.log10(MandelbrotApp.MAX_ITER);
    this.julia.zoom.slider.min = Math.log10(MandelbrotApp.MIN_SCALE);
    this.julia.zoom.slider.max = Math.log10(MandelbrotApp.MAX_SCALE);

    const checkboxFields = [
      ["showJuliaChk", "showJulia"],
      ["showMandelbrotChk", "showMandelbrot"],
    ];
    checkboxFields.forEach(([chk, field]) => { this[chk].checked = !!this[field]; });
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
    // anything below: resizeCanvas()/resizeOverlayCanvas() read the current
    // CSS box size, so if dual-view's 50vw split isn't already in effect,
    // a share URL/localStorage restore that starts in dual view would size
    // both backing stores to the old (100vw) layout and stay stretched
    // until the next window resize or panel toggle.
    this.updatePanelVisibility();
    // Both panels were constructed before the CSS visibility classes above
    // were known — resize each shown panel's backing store now that they are
    // (resizeCanvas reads the current CSS box size). GPU renderers attach
    // later in initGPU().
    this.resizeVisiblePanels();
    this.mandelbrot.palette.sel.value = this.mandelbrot.panel.paletteType;
    this.julia.palette.sel.value = this.julia.panel.paletteType;
    this.backBtn    = document.getElementById("backBtn");
    this.forwardBtn = document.getElementById("forwardBtn");
    this.resetBtn   = document.getElementById("resetBtn");
    this.shareBtn   = document.getElementById("shareBtn");

    this.mandelbrot.iter.slider.oninput = this.onMandelbrotIterInput;
    this.mandelbrot.iter.slider.onchange = () => {
      if (this.mandelbrotPendingIterSnapshot) {
        this.pushHistory(this.mandelbrotPendingIterSnapshot);
        this.mandelbrotPendingIterSnapshot = null;
      }
    };
    this.mandelbrot.zoom.slider.oninput = this.onMandelbrotZoomInput;
    this.mandelbrot.zoom.slider.onchange = () => {
      if (this.mandelbrotPendingZoomSnapshot) {
        this.pushHistory(this.mandelbrotPendingZoomSnapshot);
        this.mandelbrotPendingZoomSnapshot = null;
      }
    };
    this.mandelbrot.palette.sel.onchange = this.onMandelbrotPaletteChange;
    this.showMandelbrotChk.onchange = this.onPanelVisibilityChange;
    this.showJuliaChk.onchange = this.onPanelVisibilityChange;
    this.mandelbrot.progressive.chk.onchange = this.onMandelbrotProgressiveChange;
    this.mandelbrot.smoothColoring.chk.onchange = this.onMandelbrotSmoothColoringChange;
    this.mandelbrot.gridOverlay.chk.onchange = this.onMandelbrotGridOverlayChange;
    this.mandelbrot.centerMarker.chk.onchange = this.onMandelbrotCenterMarkerChange;
    this.julia.marker.chk.onchange = this.onJuliaMarkerChange;

    // Julia's own controls — symmetric with Mandelbrot's above, including
    // the same debounce-on-release pattern for the sliders.
    this.julia.iter.slider.oninput = this.onJuliaIterInput;
    this.julia.iter.slider.onchange = () => {
      if (this.juliaPendingIterSnapshot) {
        this.pushHistory(this.juliaPendingIterSnapshot);
        this.juliaPendingIterSnapshot = null;
      }
    };
    this.julia.zoom.slider.oninput = this.onJuliaZoomInput;
    this.julia.zoom.slider.onchange = () => {
      if (this.juliaPendingZoomSnapshot) {
        this.pushHistory(this.juliaPendingZoomSnapshot);
        this.juliaPendingZoomSnapshot = null;
      }
    };
    this.julia.palette.sel.onchange = this.onJuliaPaletteChange;
    this.julia.progressive.chk.onchange = this.onJuliaProgressiveChange;
    this.julia.smoothColoring.chk.onchange = this.onJuliaSmoothColoringChange;
    this.julia.gridOverlay.chk.onchange = this.onJuliaGridOverlayChange;
    this.julia.centerMarker.chk.onchange = this.onJuliaCenterMarkerChange;

    this.backBtn.onclick    = this.onBack;
    this.forwardBtn.onclick = this.onForward;
    this.resetBtn.onclick   = this.onReset;
    this.shareBtn.onclick   = this.onShare;
    this.uiToggleBtn.onclick = this.onUiToggle;

    this.attachPanelEvents({
      panel: this.mandelbrot.panel,
      hooks: {
        pushHistory: (s) => this.pushHistory(s),
        armWheelHistory: () => this.history.armWheel(() => this.snapshotView()),
        onScaleChange: () => this.syncMandelbrotZoomSliderUI(),
        // Only the Mandelbrot panel's genuine click sets the shared Julia
        // seed — see attachPanelEvents' hooks param.
        onGenuineClick: (fractalPoint) => {
          this.juliaSeed = fractalPoint;
          // Only the Julia panel's render actually depends on juliaSeed
          // (its escape set changes; the Mandelbrot panel's own image
          // doesn't) — reset just Julia's progressive ramp, not Mandelbrot's.
          if (this.showJulia) this.resetProgressive(this.julia.panel);
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
        pushHistory: (snapshot) => this.pushHistory(snapshot),
        armWheelHistory: () => this.history.armWheel(() => this.snapshotView()),
        onScaleChange: () => this.syncJuliaZoomSliderUI(),
      },
    });
    window.addEventListener("resize", this.onResize);
    window.addEventListener("keydown", this.onKeyDown);

    this.setScale(this.mandelbrot.panel.scale);
    this.setMandelbrotMaxIter(this.mandelbrot.panel.maxIter);
    this.mandelbrot.panel.palette256 = makePalette(this.mandelbrot.panel.paletteType);
    // Julia's own iter/zoom slider sync + GPU palette (symmetric with the
    // three Mandelbrot lines above); the renderer attaches in initGPU().
    this.setJuliaMaxIter(this.julia.panel.maxIter);
    this.syncJuliaZoomSliderUI();
    this.julia.panel.palette256 = makePalette(this.julia.panel.paletteType);

    this.drawOverlay();
  }

  setScale(next) {
    this.mandelbrot.panel.setScale(next, MandelbrotApp.MIN_SCALE, MandelbrotApp.MAX_SCALE);
    this.syncMandelbrotZoomSliderUI();
  }

  syncMandelbrotZoomSliderUI() {
    this.mandelbrot.zoom.slider.value = Math.log10(this.mandelbrot.panel.scale);
    this.mandelbrot.zoom.label.textContent = this.mandelbrot.panel.scale;
  }

  syncJuliaZoomSliderUI() {
    this.julia.zoom.slider.value = Math.log10(this.julia.panel.scale);
    this.julia.zoom.label.textContent = this.julia.panel.scale;
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
      showMandelbrot: this.showMandelbrot,
      showJulia: this.showJulia,
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
      showMandelbrot: this.showMandelbrot,
      showJulia: this.showJulia,
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

    this.showMandelbrot = p.showMandelbrot;
    this.showMandelbrotChk.checked = !!p.showMandelbrot;
    this.showJulia = p.showJulia;
    this.showJuliaChk.checked = !!p.showJulia;
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
        const [side, key] = mapped;
        this[side].panel[key] = value;
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
    // mandelbrotPanelX / juliaPanelX names are the flat URL/localStorage
    // schema field names (see share.js) — setPanelField() above routes them
    // through PANEL_FIELD_MAP to this.mandelbrot.panel / this.julia.panel,
    // both always live (constructed eagerly above). juliaSeed/juliaMarker/
    // showJulia/showMandelbrot aren't in the map, so they fall through to
    // plain this[flatName] = value.
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
    this.mandelbrot.panel.center = s.mandelbrotPanel.center;
    this.mandelbrot.panel.pivot = s.mandelbrotPanel.center;
    this.mandelbrot.panel.pivotScreen = new DOMPointReadOnly(0.5, 0.5);
    this.setScale(s.mandelbrotPanel.scale);
    this.setMandelbrotMaxIter(s.mandelbrotPanel.maxIter);
    this.applyMandelbrotPalette(s.mandelbrotPanel.paletteType);
    this.mandelbrot.palette.sel.value = s.mandelbrotPanel.paletteType;
    this.mandelbrot.panel.progressiveMode = s.mandelbrotPanel.progressiveMode;
    this.mandelbrot.progressive.chk.checked = !!s.mandelbrotPanel.progressiveMode;
    this.mandelbrot.panel.smoothColoring = s.mandelbrotPanel.smoothColoring;
    this.mandelbrot.smoothColoring.chk.checked = !!s.mandelbrotPanel.smoothColoring;
    this.resetProgressive(this.mandelbrot.panel);

    // Mirror of the Mandelbrot block above — explicit writes to
    // this.julia.panel plus the matching UI sync, since assigning
    // panel state alone doesn't touch the DOM controls.
    this.julia.panel.center = s.juliaPanel.center;
    this.julia.panel.pivot = s.juliaPanel.center;
    this.julia.panel.pivotScreen = new DOMPointReadOnly(0.5, 0.5);
    this.julia.panel.setScale(s.juliaPanel.scale, MandelbrotApp.MIN_SCALE, MandelbrotApp.MAX_SCALE);
    this.syncJuliaZoomSliderUI();
    this.setJuliaMaxIter(s.juliaPanel.maxIter);
    this.applyJuliaPalette(s.juliaPanel.paletteType);
    this.julia.palette.sel.value = s.juliaPanel.paletteType;
    this.julia.panel.progressiveMode = s.juliaPanel.progressiveMode;
    this.julia.progressive.chk.checked = !!s.juliaPanel.progressiveMode;
    this.julia.panel.smoothColoring = s.juliaPanel.smoothColoring;
    this.julia.smoothColoring.chk.checked = !!s.juliaPanel.smoothColoring;
    this.resetProgressive(this.julia.panel);

    this.juliaSeed = s.juliaSeed;

    this.scheduleRender();
  }

  setMandelbrotMaxIter(next) {
    const clamped = Math.round(Math.min(MandelbrotApp.MAX_ITER, Math.max(MandelbrotApp.MIN_ITER, next)));
    this.mandelbrot.panel.maxIter = clamped;
    this.mandelbrot.iter.slider.value = Math.log10(clamped);
    this.mandelbrot.iter.label.textContent = clamped;
  }

  // Julia's own Iterations slider — independent of Mandelbrot's. History
  // bookkeeping (pushHistory) is done by the caller (see the slider's
  // onchange/juliaPendingIterSnapshot handling and applySnapshot above).
  setJuliaMaxIter(next) {
    const clamped = Math.round(Math.min(MandelbrotApp.MAX_ITER, Math.max(MandelbrotApp.MIN_ITER, next)));
    this.julia.panel.maxIter = clamped;
    this.julia.iter.slider.value = Math.log10(clamped);
    this.julia.iter.label.textContent = clamped;
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
      this.julia.panel.renderer ? Promise.resolve(this.julia.panel.renderer) : attachCanvas(this.gpuDevice, this.julia.panel.canvas, this.julia.panel.palette256),
    ]);
    this.mandelbrot.panel.renderer = mRenderer;
    this.julia.panel.renderer = jRenderer;
    this.scheduleRender();
  }

  // Resets one panel's own progressive-reveal ramp.
  resetProgressive(panel) {
    panel.progressiveIter = 1;
  }

  applyMandelbrotPalette(type) {
    const palette256 = makePalette(type);
    this.mandelbrot.panel.paletteType = type;
    this.mandelbrot.panel.palette256 = palette256;
    if (this.mandelbrot.panel.renderer) this.mandelbrot.panel.renderer.writePalette(palette256);
  }

  // Julia's own Palette control — its own GPU palette texture (attachCanvas
  // is per-canvas), independent of Mandelbrot's.
  applyJuliaPalette(type) {
    const palette256 = makePalette(type);
    this.julia.panel.paletteType = type;
    this.julia.panel.palette256 = palette256;
    if (this.julia.panel.renderer) this.julia.panel.renderer.writePalette(palette256);
  }

  // Screen-normalized [0,1] point -> fractal-space point, anchored at `anchor`.
  toFractal(normPoint, anchor) {
    return this.mandelbrot.panel.toFractal(normPoint, anchor);
  }

  onMandelbrotIterInput = () => {
    if (!this.mandelbrotPendingIterSnapshot) this.mandelbrotPendingIterSnapshot = this.snapshotView();
    this.setMandelbrotMaxIter(10 ** Number(this.mandelbrot.iter.slider.value));
    this.resetProgressive(this.mandelbrot.panel);
    this.scheduleRender();
  };

  onMandelbrotZoomInput = () => {
    if (!this.mandelbrotPendingZoomSnapshot) this.mandelbrotPendingZoomSnapshot = this.snapshotView();
    this.setScale(10 ** Number(this.mandelbrot.zoom.slider.value));
    this.scheduleRender();
  };

  onMandelbrotPaletteChange = () => {
    this.pushHistory(this.snapshotView());
    this.applyMandelbrotPalette(Number(this.mandelbrot.palette.sel.value));
    this.scheduleRender();
  };

  onJuliaIterInput = () => {
    if (!this.juliaPendingIterSnapshot) this.juliaPendingIterSnapshot = this.snapshotView();
    this.setJuliaMaxIter(10 ** Number(this.julia.iter.slider.value));
    this.resetProgressive(this.julia.panel);
    this.scheduleRender();
  };

  onJuliaZoomInput = () => {
    if (!this.juliaPendingZoomSnapshot) this.juliaPendingZoomSnapshot = this.snapshotView();
    this.julia.panel.setScale(10 ** Number(this.julia.zoom.slider.value), MandelbrotApp.MIN_SCALE, MandelbrotApp.MAX_SCALE);
    this.syncJuliaZoomSliderUI();
    this.scheduleRender();
  };

  onJuliaPaletteChange = () => {
    this.pushHistory(this.snapshotView());
    this.applyJuliaPalette(Number(this.julia.palette.sel.value));
    this.scheduleRender();
  };

  // Panel visibility is a display preference, not view state (mirrors the
  // overlay toggles below) — no pushHistory. Both panels are always live
  // (just hidden by CSS), so toggling never needs to attach WebGPU.
  onPanelVisibilityChange = () => {
    this.showMandelbrot = this.showMandelbrotChk.checked ? 1 : 0;
    this.showJulia = this.showJuliaChk.checked ? 1 : 0;
    this.updatePanelVisibility();
    // The CSS width of a shown panel changes (100vw <-> 50vw) the instant
    // its visibility changes; refresh its backing store now rather than
    // waiting for the next window resize, or the image stays stretched.
    this.resizeVisiblePanels();
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
  // over. Both panels always exist; only visibility (showMandelbrot/
  // showJulia) gates inclusion here.
  get panels() {
    const list = [];
    if (this.showMandelbrot) {
      list.push({ panel: this.mandelbrot.panel, juliaMode: 0, showJuliaMarker: true });
    }
    if (this.showJulia) {
      list.push({ panel: this.julia.panel, juliaMode: 1, showJuliaMarker: false });
    }
    return list;
  }

  onMandelbrotProgressiveChange = () => {
    this.pushHistory(this.snapshotView());
    this.mandelbrot.panel.progressiveMode = this.mandelbrot.progressive.chk.checked ? 1 : 0;
    this.resetProgressive(this.mandelbrot.panel);
    this.scheduleRender();
  };

  onMandelbrotSmoothColoringChange = () => {
    this.pushHistory(this.snapshotView());
    this.mandelbrot.panel.smoothColoring = this.mandelbrot.smoothColoring.chk.checked ? 1 : 0;
    this.scheduleRender();
  };

  // Overlay display preferences are not part of view history: they don't
  // change what the fractal render pass produces, only what's drawn on the
  // separate #mandelbrotOverlay canvas, so no pushHistory here (unlike the toggles above).
  onMandelbrotGridOverlayChange = () => {
    this.mandelbrot.panel.gridOverlay = this.mandelbrot.gridOverlay.chk.checked ? 1 : 0;
    this.scheduleRender();
  };

  onMandelbrotCenterMarkerChange = () => {
    this.mandelbrot.panel.centerMarker = this.mandelbrot.centerMarker.chk.checked ? 1 : 0;
    this.scheduleRender();
  };

  onJuliaMarkerChange = () => {
    this.juliaMarker = this.julia.marker.chk.checked ? 1 : 0;
    this.scheduleRender();
  };

  // Julia's own quality controls — Tier 1, symmetric with Mandelbrot's above
  // (pushHistory immediately, same as onMandelbrotProgressiveChange/onMandelbrotSmoothColoringChange).
  onJuliaProgressiveChange = () => {
    this.pushHistory(this.snapshotView());
    this.julia.panel.progressiveMode = this.julia.progressive.chk.checked ? 1 : 0;
    this.resetProgressive(this.julia.panel);
    this.scheduleRender();
  };

  onJuliaSmoothColoringChange = () => {
    this.pushHistory(this.snapshotView());
    this.julia.panel.smoothColoring = this.julia.smoothColoring.chk.checked ? 1 : 0;
    this.scheduleRender();
  };

  // Julia's own grid/center-marker — Tier 2 (display preference), no
  // pushHistory, mirrors Mandelbrot's onMandelbrotGridOverlayChange/onMandelbrotCenterMarkerChange.
  onJuliaGridOverlayChange = () => {
    this.julia.panel.gridOverlay = this.julia.gridOverlay.chk.checked ? 1 : 0;
    this.scheduleRender();
  };

  onJuliaCenterMarkerChange = () => {
    this.julia.panel.centerMarker = this.julia.centerMarker.chk.checked ? 1 : 0;
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
    this.mandelbrotPendingIterSnapshot = null;
    this.mandelbrotPendingZoomSnapshot = null;
    this.juliaPendingIterSnapshot = null;
    this.juliaPendingZoomSnapshot = null;
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
    if (this.deviceLost || !this.mandelbrot.panel.renderer) {
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

const app = new MandelbrotApp(document.getElementById("mandelbrotGfx"));
window.app = app; // exposed for e2e test assertions on internal state (tests/)
try {
  await app.init();
} catch (e) {
  app.showError(`Failed to initialize WebGPU: ${e.message}`);
}
