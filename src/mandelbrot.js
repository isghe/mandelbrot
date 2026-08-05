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
  // that panel full-screen; both off = a black screen. Both panels' JS
  // wrappers always exist (constructed eagerly); visibility is just a CSS
  // class toggled by updatePanelVisibility().
  showMandelbrot = 1;
  showJulia = 0;

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

  // Pure passthroughs to the two live panels. Both panels are constructed
  // eagerly in the constructor and never destroyed (hidden via CSS when a
  // panel is off), so these have no backing field and no side effect — a
  // symmetric pair of getter/setter groups, juliaPanelX and mandelbrotPanelX.
  // They exist so restoreSettings() can drive both panels through the same
  // generic this[field] = s[field] loop. The DOM refs (sliders/checkboxes/
  // selects) don't exist yet when restoreSettings() runs, so these can't do
  // UI sync — the rest of the constructor (setJulia/MandelbrotMaxIter,
  // palette256, the panelCheckboxFields loops) re-aligns the interface, and
  // the runtime write paths (applySnapshot/restoreDisplayPrefs) call the
  // side-effecting helpers explicitly rather than relying on the setters.
  get juliaPanelCenter() { return this.juliaPanel.center; }
  set juliaPanelCenter(v) { this.juliaPanel.center = v; }
  get juliaPanelScale() { return this.juliaPanel.scale; }
  set juliaPanelScale(v) { this.juliaPanel.scale = v; }
  get juliaPanelMaxIter() { return this.juliaPanel.maxIter; }
  set juliaPanelMaxIter(v) { this.juliaPanel.maxIter = v; }
  get juliaPanelPaletteType() { return this.juliaPanel.paletteType; }
  set juliaPanelPaletteType(v) { this.juliaPanel.paletteType = v; }
  get juliaPanelSmoothColoring() { return this.juliaPanel.smoothColoring; }
  set juliaPanelSmoothColoring(v) { this.juliaPanel.smoothColoring = v; }
  get juliaPanelProgressiveMode() { return this.juliaPanel.progressiveMode; }
  set juliaPanelProgressiveMode(v) { this.juliaPanel.progressiveMode = v; }
  get juliaPanelGridOverlay() { return this.juliaPanel.gridOverlay; }
  set juliaPanelGridOverlay(v) { this.juliaPanel.gridOverlay = v; }
  get juliaPanelCenterMarker() { return this.juliaPanel.centerMarker; }
  set juliaPanelCenterMarker(v) { this.juliaPanel.centerMarker = v; }

  get mandelbrotPanelCenter() { return this.mandelbrotPanel.center; }
  set mandelbrotPanelCenter(v) { this.mandelbrotPanel.center = v; }
  get mandelbrotPanelScale() { return this.mandelbrotPanel.scale; }
  set mandelbrotPanelScale(v) { this.mandelbrotPanel.scale = v; }
  get mandelbrotPanelMaxIter() { return this.mandelbrotPanel.maxIter; }
  set mandelbrotPanelMaxIter(v) { this.mandelbrotPanel.maxIter = v; }
  get mandelbrotPanelPaletteType() { return this.mandelbrotPanel.paletteType; }
  set mandelbrotPanelPaletteType(v) { this.mandelbrotPanel.paletteType = v; }
  get mandelbrotPanelProgressiveMode() { return this.mandelbrotPanel.progressiveMode; }
  set mandelbrotPanelProgressiveMode(v) { this.mandelbrotPanel.progressiveMode = v; }
  get mandelbrotPanelSmoothColoring() { return this.mandelbrotPanel.smoothColoring; }
  set mandelbrotPanelSmoothColoring(v) { this.mandelbrotPanel.smoothColoring = v; }
  get mandelbrotPanelGridOverlay() { return this.mandelbrotPanel.gridOverlay; }
  set mandelbrotPanelGridOverlay(v) { this.mandelbrotPanel.gridOverlay = v; }
  get mandelbrotPanelCenterMarker() { return this.mandelbrotPanel.centerMarker; }
  set mandelbrotPanelCenterMarker(v) { this.mandelbrotPanel.centerMarker = v; }

  constructor(canvas) {
    this.mandelbrotPanel = new FractalPanel(canvas, document.getElementById("mandelbrotOverlay"));
    // Julia is constructed eagerly too (symmetric with Mandelbrot), so both
    // panels are always live; the DOM refs and GPU renderer are wired later
    // (below, and in initGPU) the same way Mandelbrot's are. Visibility is a
    // separate concern (showJulia + updatePanelVisibility).
    this.juliaPanel = new FractalPanel(document.getElementById("juliaGfx"), document.getElementById("juliaOverlay"));
    // A fresh Julia view is centered on the current Julia seed (its default
    // pan), matching what the old lazy createJuliaPanel() did on first reveal;
    // restoreSettings() overrides this if the URL/localStorage carries a
    // juliaPanelCenter. pivot follows in restoreSettings() below.
    this.juliaPanel.center = this.juliaSeed;

    // Captured via snapshotView() itself: both panels are freshly constructed
    // here (Mandelbrot's class defaults, Julia centered on the seed as above),
    // so this captures the app's built-in default view without hand-
    // duplicating those defaults.
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
    this.mandelbrotIterSlider = document.getElementById("mandelbrotIterSlider");
    this.mandelbrotIterLabel  = document.getElementById("mandelbrotIterLabel");
    this.mandelbrotIterSlider.min = Math.log10(MandelbrotApp.MIN_ITER);
    this.mandelbrotIterSlider.max = Math.log10(MandelbrotApp.MAX_ITER);
    this.mandelbrotZoomSlider = document.getElementById("mandelbrotZoomSlider");
    this.mandelbrotZoomLabel  = document.getElementById("mandelbrotZoomLabel");
    this.mandelbrotZoomSlider.min = Math.log10(MandelbrotApp.MIN_SCALE);
    this.mandelbrotZoomSlider.max = Math.log10(MandelbrotApp.MAX_SCALE);
    this.mandelbrotPaletteSel = document.getElementById("mandelbrotPaletteType");
    this.showMandelbrotChk = document.getElementById("showMandelbrot");
    this.showJuliaChk = document.getElementById("showJulia");
    this.mandelbrotProgressiveChk = document.getElementById("mandelbrotProgressiveMode");
    this.mandelbrotSmoothColoringChk = document.getElementById("mandelbrotSmoothColoring");
    this.mandelbrotGridOverlayChk = document.getElementById("mandelbrotGridOverlay");
    this.mandelbrotCenterMarkerChk = document.getElementById("mandelbrotCenterMarker");
    this.juliaMarkerChk = document.getElementById("juliaMarker");

    // Julia's own controls, independent of the Mandelbrot ones above —
    // synced to the live juliaPanel's field values further down in this
    // constructor (juliaPanelCheckboxFields, setJuliaMaxIter/
    // syncJuliaZoomSliderUI/juliaPaletteSel), symmetric with Mandelbrot's.
    this.juliaIterSlider = document.getElementById("juliaIterSlider");
    this.juliaIterLabel  = document.getElementById("juliaIterLabel");
    this.juliaIterSlider.min = Math.log10(MandelbrotApp.MIN_ITER);
    this.juliaIterSlider.max = Math.log10(MandelbrotApp.MAX_ITER);
    this.juliaZoomSlider = document.getElementById("juliaZoomSlider");
    this.juliaZoomLabel  = document.getElementById("juliaZoomLabel");
    this.juliaZoomSlider.min = Math.log10(MandelbrotApp.MIN_SCALE);
    this.juliaZoomSlider.max = Math.log10(MandelbrotApp.MAX_SCALE);
    this.juliaPaletteSel = document.getElementById("juliaPaletteType");
    this.juliaProgressiveChk = document.getElementById("juliaProgressiveMode");
    this.juliaSmoothColoringChk = document.getElementById("juliaSmoothColoring");
    this.juliaGridOverlayChk = document.getElementById("juliaGridOverlay");
    this.juliaCenterMarkerChk = document.getElementById("juliaCenterMarker");

    const checkboxFields = [
      ["juliaMarkerChk", "juliaMarker"],
      ["showJuliaChk", "showJulia"],
      ["showMandelbrotChk", "showMandelbrot"],
    ];
    checkboxFields.forEach(([chk, field]) => { this[chk].checked = !!this[field]; });
    const panelCheckboxFields = [
      ["mandelbrotCenterMarkerChk", "centerMarker"],
      ["mandelbrotGridOverlayChk", "gridOverlay"],
      ["mandelbrotProgressiveChk", "progressiveMode"],
      ["mandelbrotSmoothColoringChk", "smoothColoring"],
    ];
    panelCheckboxFields.forEach(([chk, field]) => { this[chk].checked = !!this.mandelbrotPanel[field]; });
    const juliaPanelCheckboxFields = [
      ["juliaCenterMarkerChk", "centerMarker"],
      ["juliaGridOverlayChk", "gridOverlay"],
      ["juliaProgressiveChk", "progressiveMode"],
      ["juliaSmoothColoringChk", "smoothColoring"],
    ];
    juliaPanelCheckboxFields.forEach(([chk, field]) => { this[chk].checked = !!this.juliaPanel[field]; });
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
    if (this.showMandelbrot) {
      this.resizeCanvas();
      this.resizeOverlayCanvas();
    }
    if (this.showJulia) {
      this.juliaPanel.resizeCanvas();
      this.juliaPanel.resizeOverlayCanvas();
    }
    this.mandelbrotPaletteSel.value = this.mandelbrotPanel.paletteType;
    this.juliaPaletteSel.value = this.juliaPanel.paletteType;
    this.backBtn    = document.getElementById("backBtn");
    this.forwardBtn = document.getElementById("forwardBtn");
    this.resetBtn   = document.getElementById("resetBtn");
    this.shareBtn   = document.getElementById("shareBtn");

    this.mandelbrotIterSlider.oninput = this.onMandelbrotIterInput;
    this.mandelbrotIterSlider.onchange = () => {
      if (this.mandelbrotPendingIterSnapshot) {
        this.pushHistory(this.mandelbrotPendingIterSnapshot);
        this.mandelbrotPendingIterSnapshot = null;
      }
    };
    this.mandelbrotZoomSlider.oninput = this.onMandelbrotZoomInput;
    this.mandelbrotZoomSlider.onchange = () => {
      if (this.mandelbrotPendingZoomSnapshot) {
        this.pushHistory(this.mandelbrotPendingZoomSnapshot);
        this.mandelbrotPendingZoomSnapshot = null;
      }
    };
    this.mandelbrotPaletteSel.onchange = this.onMandelbrotPaletteChange;
    this.showMandelbrotChk.onchange = this.onPanelVisibilityChange;
    this.showJuliaChk.onchange = this.onPanelVisibilityChange;
    this.mandelbrotProgressiveChk.onchange = this.onMandelbrotProgressiveChange;
    this.mandelbrotSmoothColoringChk.onchange = this.onMandelbrotSmoothColoringChange;
    this.mandelbrotGridOverlayChk.onchange = this.onMandelbrotGridOverlayChange;
    this.mandelbrotCenterMarkerChk.onchange = this.onMandelbrotCenterMarkerChange;
    this.juliaMarkerChk.onchange = this.onJuliaMarkerChange;

    // Julia's own controls — symmetric with Mandelbrot's above, including
    // the same debounce-on-release pattern for the sliders.
    this.juliaIterSlider.oninput = this.onJuliaIterInput;
    this.juliaIterSlider.onchange = () => {
      if (this.juliaPendingIterSnapshot) {
        this.pushHistory(this.juliaPendingIterSnapshot);
        this.juliaPendingIterSnapshot = null;
      }
    };
    this.juliaZoomSlider.oninput = this.onJuliaZoomInput;
    this.juliaZoomSlider.onchange = () => {
      if (this.juliaPendingZoomSnapshot) {
        this.pushHistory(this.juliaPendingZoomSnapshot);
        this.juliaPendingZoomSnapshot = null;
      }
    };
    this.juliaPaletteSel.onchange = this.onJuliaPaletteChange;
    this.juliaProgressiveChk.onchange = this.onJuliaProgressiveChange;
    this.juliaSmoothColoringChk.onchange = this.onJuliaSmoothColoringChange;
    this.juliaGridOverlayChk.onchange = this.onJuliaGridOverlayChange;
    this.juliaCenterMarkerChk.onchange = this.onJuliaCenterMarkerChange;

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
        onScaleChange: () => this.syncMandelbrotZoomSliderUI(),
        // Only the Mandelbrot panel's genuine click sets the shared Julia
        // constant — see attachPanelEvents' hooks param.
        onGenuineClick: (fractalPoint) => {
          this.juliaSeed = fractalPoint;
          // Only the Julia panel's render actually depends on juliaSeed
          // (its escape set changes; the Mandelbrot panel's own image
          // doesn't) — reset just Julia's progressive ramp, not Mandelbrot's.
          if (this.showJulia) this.resetProgressive(this.juliaPanel);
        },
      },
    });
    // Julia's own pan/zoom/quality is Tier 1 too (History A, symmetric with
    // Mandelbrot). No onGenuineClick: clicking inside the Julia panel only
    // moves its own pivot/zoom anchor, it never sets juliaSeed (only a click
    // on the Mandelbrot panel does that).
    this.attachPanelEvents({
      panel: this.juliaPanel,
      hooks: {
        pushHistory: (snapshot) => this.pushHistory(snapshot),
        armWheelHistory: () => this.history.armWheel(() => this.snapshotView()),
        onScaleChange: () => this.syncJuliaZoomSliderUI(),
      },
    });
    window.addEventListener("resize", this.onResize);
    window.addEventListener("keydown", this.onKeyDown);

    this.setScale(this.mandelbrotPanel.scale);
    this.setMandelbrotMaxIter(this.mandelbrotPanel.maxIter);
    this.mandelbrotPanel.palette256 = makePalette(this.mandelbrotPanel.paletteType);
    // Julia's own iter/zoom slider sync + GPU palette (symmetric with the
    // three Mandelbrot lines above); the renderer attaches in initGPU().
    this.setJuliaMaxIter(this.juliaPanel.maxIter);
    this.syncJuliaZoomSliderUI();
    this.juliaPanel.palette256 = makePalette(this.juliaPanel.paletteType);

    this.drawOverlay();
  }

  setScale(next) {
    this.mandelbrotPanel.setScale(next, MandelbrotApp.MIN_SCALE, MandelbrotApp.MAX_SCALE);
    this.syncMandelbrotZoomSliderUI();
  }

  syncMandelbrotZoomSliderUI() {
    this.mandelbrotZoomSlider.value = Math.log10(this.mandelbrotPanel.scale);
    this.mandelbrotZoomLabel.textContent = this.mandelbrotPanel.scale;
  }

  syncJuliaZoomSliderUI() {
    this.juliaZoomSlider.value = Math.log10(this.juliaPanel.scale);
    this.juliaZoomLabel.textContent = this.juliaPanel.scale;
  }

  // Tier 1 ("navigable view", undo/redo): both panels' own view+quality,
  // symmetric — History A, see the plan doc. juliaSeed isn't a canvas's own
  // view (it's the Julia-family constant), so it stays a separate top-level
  // field rather than living inside either panel's sub-object.
  snapshotView() {
    return {
      mandelbrotPanel: {
        center: this.mandelbrotPanelCenter,
        scale: this.mandelbrotPanelScale,
        maxIter: this.mandelbrotPanelMaxIter,
        paletteType: this.mandelbrotPanelPaletteType,
        smoothColoring: this.mandelbrotPanelSmoothColoring,
        progressiveMode: this.mandelbrotPanelProgressiveMode,
      },
      juliaPanel: {
        center: this.juliaPanelCenter,
        scale: this.juliaPanelScale,
        maxIter: this.juliaPanelMaxIter,
        paletteType: this.juliaPanelPaletteType,
        smoothColoring: this.juliaPanelSmoothColoring,
        progressiveMode: this.juliaPanelProgressiveMode,
      },
      juliaSeed: this.juliaSeed,
    };
  }

  // share.js expects this flat shape (schema v5), distinct from
  // snapshotView()'s nested Tier 1 shape used for undo-history/Reset — see
  // flattenSnapshotForShare() below for the bridge between the two.
  shareState() {
    return {
      mandelbrotPanelCenter: this.mandelbrotPanelCenter,
      mandelbrotPanelScale: this.mandelbrotPanelScale,
      mandelbrotPanelMaxIter: this.mandelbrotPanelMaxIter,
      mandelbrotPanelPaletteType: this.mandelbrotPanelPaletteType,
      mandelbrotPanelProgressiveMode: this.mandelbrotPanelProgressiveMode,
      mandelbrotPanelSmoothColoring: this.mandelbrotPanelSmoothColoring,
      mandelbrotPanelGridOverlay: this.mandelbrotPanelGridOverlay,
      mandelbrotPanelCenterMarker: this.mandelbrotPanelCenterMarker,
      juliaSeed: this.juliaSeed,
      juliaPanelCenter: this.juliaPanelCenter,
      juliaPanelScale: this.juliaPanelScale,
      juliaPanelMaxIter: this.juliaPanelMaxIter,
      juliaPanelPaletteType: this.juliaPanelPaletteType,
      juliaPanelProgressiveMode: this.juliaPanelProgressiveMode,
      juliaPanelSmoothColoring: this.juliaPanelSmoothColoring,
      juliaPanelGridOverlay: this.juliaPanelGridOverlay,
      juliaPanelCenterMarker: this.juliaPanelCenterMarker,
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
      mandelbrotPanelGridOverlay: this.mandelbrotPanelGridOverlay,
      mandelbrotPanelCenterMarker: this.mandelbrotPanelCenterMarker,
      juliaPanelGridOverlay: this.juliaPanelGridOverlay,
      juliaPanelCenterMarker: this.juliaPanelCenterMarker,
      juliaMarker: this.juliaMarker,
      showMandelbrot: this.showMandelbrot,
      showJulia: this.showJulia,
    };
  }

  restoreDisplayPrefs(p) {
    this.mandelbrotPanel.gridOverlay = p.mandelbrotPanelGridOverlay;
    this.mandelbrotGridOverlayChk.checked = !!p.mandelbrotPanelGridOverlay;
    this.mandelbrotPanel.centerMarker = p.mandelbrotPanelCenterMarker;
    this.mandelbrotCenterMarkerChk.checked = !!p.mandelbrotPanelCenterMarker;
    this.juliaPanel.gridOverlay = p.juliaPanelGridOverlay;
    this.juliaGridOverlayChk.checked = !!p.juliaPanelGridOverlay;
    this.juliaPanel.centerMarker = p.juliaPanelCenterMarker;
    this.juliaCenterMarkerChk.checked = !!p.juliaPanelCenterMarker;
    this.juliaMarker = p.juliaMarker;
    this.juliaMarkerChk.checked = !!p.juliaMarker;

    this.showMandelbrot = p.showMandelbrot;
    this.showMandelbrotChk.checked = !!p.showMandelbrot;
    this.showJulia = p.showJulia;
    this.showJuliaChk.checked = !!p.showJulia;
    this.updatePanelVisibility();
    this.resizeCanvas();
    this.resizeOverlayCanvas();
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

    const restoreNumber = (field) => {
      if (typeof s[field] === "number") this[field] = s[field];
    };
    const restorePoint = (field) => {
      const p = s[field];
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        this[field] = new DOMPointReadOnly(p.x, p.y);
      }
    };
    const pointFields = ["juliaSeed", "juliaPanelCenter", "mandelbrotPanelCenter"];
    // mandelbrotPanelX / juliaPanelX names double as MandelbrotApp accessor
    // names (see the getters/setters above the constructor) — this[field] =
    // s[field] below routes straight through: mandelbrotPanel always exists;
    // juliaPanel falls back to a backing field until it's created.
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

    this.mandelbrotPanel.pivot = this.mandelbrotPanel.center;
    this.juliaPanel.pivot = this.juliaPanel.center;

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
    this.mandelbrotPanel.center = s.mandelbrotPanel.center;
    this.mandelbrotPanel.pivot = s.mandelbrotPanel.center;
    this.mandelbrotPanel.pivotScreen = new DOMPointReadOnly(0.5, 0.5);
    this.setScale(s.mandelbrotPanel.scale);
    this.setMandelbrotMaxIter(s.mandelbrotPanel.maxIter);
    this.applyMandelbrotPalette(s.mandelbrotPanel.paletteType);
    this.mandelbrotPaletteSel.value = s.mandelbrotPanel.paletteType;
    this.mandelbrotPanel.progressiveMode = s.mandelbrotPanel.progressiveMode;
    this.mandelbrotProgressiveChk.checked = !!s.mandelbrotPanel.progressiveMode;
    this.mandelbrotPanel.smoothColoring = s.mandelbrotPanel.smoothColoring;
    this.mandelbrotSmoothColoringChk.checked = !!s.mandelbrotPanel.smoothColoring;
    this.resetProgressive(this.mandelbrotPanel);

    // Mirror of the Mandelbrot block above — explicit side-effecting calls
    // rather than the juliaPanelX setters (those are pure passthroughs, see
    // the accessors above; UI sync has to happen here instead).
    this.juliaPanel.center = s.juliaPanel.center;
    this.juliaPanel.pivot = s.juliaPanel.center;
    this.juliaPanel.pivotScreen = new DOMPointReadOnly(0.5, 0.5);
    this.juliaPanel.setScale(s.juliaPanel.scale, MandelbrotApp.MIN_SCALE, MandelbrotApp.MAX_SCALE);
    this.syncJuliaZoomSliderUI();
    this.setJuliaMaxIter(s.juliaPanel.maxIter);
    this.applyJuliaPalette(s.juliaPanel.paletteType);
    this.juliaPaletteSel.value = s.juliaPanel.paletteType;
    this.juliaPanel.progressiveMode = s.juliaPanel.progressiveMode;
    this.juliaProgressiveChk.checked = !!s.juliaPanel.progressiveMode;
    this.juliaPanel.smoothColoring = s.juliaPanel.smoothColoring;
    this.juliaSmoothColoringChk.checked = !!s.juliaPanel.smoothColoring;
    this.resetProgressive(this.juliaPanel);

    this.juliaSeed = s.juliaSeed;

    this.scheduleRender();
  }

  setMandelbrotMaxIter(next) {
    const clamped = Math.round(Math.min(MandelbrotApp.MAX_ITER, Math.max(MandelbrotApp.MIN_ITER, next)));
    this.mandelbrotPanel.maxIter = clamped;
    this.mandelbrotIterSlider.value = Math.log10(clamped);
    this.mandelbrotIterLabel.textContent = clamped;
  }

  // Julia's own Iterations slider — independent of Mandelbrot's. History
  // bookkeeping (pushHistory) is done by the caller (see the slider's
  // onchange/juliaPendingIterSnapshot handling and applySnapshot above).
  setJuliaMaxIter(next) {
    const clamped = Math.round(Math.min(MandelbrotApp.MAX_ITER, Math.max(MandelbrotApp.MIN_ITER, next)));
    this.juliaPanel.maxIter = clamped;
    this.juliaIterSlider.value = Math.log10(clamped);
    this.juliaIterLabel.textContent = clamped;
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
    const [mRenderer, jRenderer] = await Promise.all([
      attachCanvas(this.gpuDevice, this.mandelbrotPanel.canvas, this.mandelbrotPanel.palette256),
      this.juliaPanel.renderer ? Promise.resolve(this.juliaPanel.renderer) : attachCanvas(this.gpuDevice, this.juliaPanel.canvas, this.juliaPanel.palette256),
    ]);
    this.mandelbrotPanel.renderer = mRenderer;
    this.juliaPanel.renderer = jRenderer;
    this.scheduleRender();
  }

  // Resets one panel's own progressive-reveal ramp.
  resetProgressive(panel) {
    panel.progressiveIter = 1;
  }

  applyMandelbrotPalette(type) {
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

  onMandelbrotIterInput = () => {
    if (!this.mandelbrotPendingIterSnapshot) this.mandelbrotPendingIterSnapshot = this.snapshotView();
    this.setMandelbrotMaxIter(10 ** Number(this.mandelbrotIterSlider.value));
    this.resetProgressive(this.mandelbrotPanel);
    this.scheduleRender();
  };

  onMandelbrotZoomInput = () => {
    if (!this.mandelbrotPendingZoomSnapshot) this.mandelbrotPendingZoomSnapshot = this.snapshotView();
    this.setScale(10 ** Number(this.mandelbrotZoomSlider.value));
    this.scheduleRender();
  };

  onMandelbrotPaletteChange = () => {
    this.pushHistory(this.snapshotView());
    this.applyMandelbrotPalette(Number(this.mandelbrotPaletteSel.value));
    this.scheduleRender();
  };

  onJuliaIterInput = () => {
    if (!this.juliaPendingIterSnapshot) this.juliaPendingIterSnapshot = this.snapshotView();
    this.setJuliaMaxIter(10 ** Number(this.juliaIterSlider.value));
    this.resetProgressive(this.juliaPanel);
    this.scheduleRender();
  };

  onJuliaZoomInput = () => {
    if (!this.juliaPendingZoomSnapshot) this.juliaPendingZoomSnapshot = this.snapshotView();
    this.juliaPanel.setScale(10 ** Number(this.juliaZoomSlider.value), MandelbrotApp.MIN_SCALE, MandelbrotApp.MAX_SCALE);
    this.syncJuliaZoomSliderUI();
    this.scheduleRender();
  };

  onJuliaPaletteChange = () => {
    this.pushHistory(this.snapshotView());
    this.applyJuliaPalette(Number(this.juliaPaletteSel.value));
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
    if (this.showMandelbrot) {
      this.resizeCanvas();
      this.resizeOverlayCanvas();
    }
    if (this.showJulia) {
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
  // over. Both panels always exist; only visibility (showMandelbrot/
  // showJulia) gates inclusion here.
  get panels() {
    const list = [];
    if (this.showMandelbrot) {
      list.push({ panel: this.mandelbrotPanel, juliaMode: 0, showJuliaMarker: true });
    }
    if (this.showJulia) {
      list.push({ panel: this.juliaPanel, juliaMode: 1, showJuliaMarker: false });
    }
    return list;
  }

  onMandelbrotProgressiveChange = () => {
    this.pushHistory(this.snapshotView());
    this.mandelbrotPanel.progressiveMode = this.mandelbrotProgressiveChk.checked ? 1 : 0;
    this.resetProgressive(this.mandelbrotPanel);
    this.scheduleRender();
  };

  onMandelbrotSmoothColoringChange = () => {
    this.pushHistory(this.snapshotView());
    this.mandelbrotPanel.smoothColoring = this.mandelbrotSmoothColoringChk.checked ? 1 : 0;
    this.scheduleRender();
  };

  // Overlay display preferences are not part of view history: they don't
  // change what the fractal render pass produces, only what's drawn on the
  // separate #mandelbrotOverlay canvas, so no pushHistory here (unlike the toggles above).
  onMandelbrotGridOverlayChange = () => {
    this.mandelbrotPanel.gridOverlay = this.mandelbrotGridOverlayChk.checked ? 1 : 0;
    this.scheduleRender();
  };

  onMandelbrotCenterMarkerChange = () => {
    this.mandelbrotPanel.centerMarker = this.mandelbrotCenterMarkerChk.checked ? 1 : 0;
    this.scheduleRender();
  };

  onJuliaMarkerChange = () => {
    this.juliaMarker = this.juliaMarkerChk.checked ? 1 : 0;
    this.scheduleRender();
  };

  // Julia's own quality controls — Tier 1, symmetric with Mandelbrot's above
  // (pushHistory immediately, same as onMandelbrotProgressiveChange/onMandelbrotSmoothColoringChange).
  onJuliaProgressiveChange = () => {
    this.pushHistory(this.snapshotView());
    this.juliaPanel.progressiveMode = this.juliaProgressiveChk.checked ? 1 : 0;
    this.resetProgressive(this.juliaPanel);
    this.scheduleRender();
  };

  onJuliaSmoothColoringChange = () => {
    this.pushHistory(this.snapshotView());
    this.juliaPanel.smoothColoring = this.juliaSmoothColoringChk.checked ? 1 : 0;
    this.scheduleRender();
  };

  // Julia's own grid/center-marker — Tier 2 (display preference), no
  // pushHistory, mirrors Mandelbrot's onMandelbrotGridOverlayChange/onMandelbrotCenterMarkerChange.
  onJuliaGridOverlayChange = () => {
    this.juliaPanel.gridOverlay = this.juliaGridOverlayChk.checked ? 1 : 0;
    this.scheduleRender();
  };

  onJuliaCenterMarkerChange = () => {
    this.juliaPanel.centerMarker = this.juliaCenterMarkerChk.checked ? 1 : 0;
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

const app = new MandelbrotApp(document.getElementById("mandelbrotGfx"));
window.app = app; // exposed for e2e test assertions on internal state (tests/)
try {
  await app.init();
} catch (e) {
  app.showError(`Failed to initialize WebGPU: ${e.message}`);
}
