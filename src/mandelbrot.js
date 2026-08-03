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

  // State (JS = f64)
  maxIter = 256;
  juliaMode = 0;
  juliaC = new DOMPointReadOnly(-0.8, 0.156);
  paletteType = 4;
  smoothColoring = 0;

  // overlay display preferences (not part of view history)
  gridOverlay = 0;
  centerMarker = 0;
  juliaMarker = 0;

  // progressive mode (reveals the fractal iteration by iteration)
  progressiveMode = 0;
  progressiveIter = 1;

  // Split screen showing Mandelbrot + Julia side by side (juliaPanel is
  // created lazily on first activation). Independent of the `juliaMode`
  // checkbox, which controls only the Mandelbrot canvas's own exclusive
  // full-screen render.
  dualView = 0;

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

  // Per-canvas render/interaction state (center, scale, pivot, pan/selection,
  // renderer, ...) lives on FractalPanel; these accessors keep the rest of
  // this class working against `this.foo` unchanged while that state moves.
  get canvas() { return this.mandelbrotPanel.canvas; }
  get overlayCanvas() { return this.mandelbrotPanel.overlayCanvas; }
  get overlayCtx() { return this.mandelbrotPanel.overlayCtx; }
  get overlayCssWidth() { return this.mandelbrotPanel.overlayCssWidth; }
  get overlayCssHeight() { return this.mandelbrotPanel.overlayCssHeight; }
  get center() { return this.mandelbrotPanel.center; }
  set center(v) { this.mandelbrotPanel.center = v; }
  get scale() { return this.mandelbrotPanel.scale; }
  set scale(v) { this.mandelbrotPanel.scale = v; }
  get pivot() { return this.mandelbrotPanel.pivot; }
  set pivot(v) { this.mandelbrotPanel.pivot = v; }
  get pivotScreen() { return this.mandelbrotPanel.pivotScreen; }
  set pivotScreen(v) { this.mandelbrotPanel.pivotScreen = v; }
  get isDragging() { return this.mandelbrotPanel.isDragging; }
  get renderer() { return this.mandelbrotPanel.renderer; }
  set renderer(v) { this.mandelbrotPanel.renderer = v; }

  constructor(canvas) {
    this.mandelbrotPanel = new FractalPanel(canvas, document.getElementById("overlay"));

    this.initialState = {
      center: this.center,
      scale: this.scale,
      maxIter: this.maxIter,
      juliaMode: this.juliaMode,
      juliaC: this.juliaC,
      paletteType: this.paletteType,
      progressiveMode: this.progressiveMode,
      smoothColoring: this.smoothColoring,
    };

    this.restoreSettings();

    this.selectionBox = document.getElementById("selectionBox");
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
    this.juliaChk   = document.getElementById("juliaMode");
    this.dualViewChk = document.getElementById("dualViewMode");
    this.dualViewChk.checked = !!this.dualView;
    this.progressiveChk = document.getElementById("progressiveMode");
    this.smoothColoringChk = document.getElementById("smoothColoring");
    this.gridOverlayChk = document.getElementById("gridOverlay");
    this.centerMarkerChk = document.getElementById("centerMarker");
    this.juliaMarkerChk = document.getElementById("juliaMarker");
    const checkboxFields = [
      ["centerMarkerChk", "centerMarker"],
      ["gridOverlayChk", "gridOverlay"],
      ["juliaChk", "juliaMode"],
      ["juliaMarkerChk", "juliaMarker"],
      ["progressiveChk", "progressiveMode"],
      ["smoothColoringChk", "smoothColoring"],
    ];
    checkboxFields.forEach(([chk, field]) => { this[chk].checked = !!this[field]; });
    this.paletteSel.value = this.paletteType;
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
    this.juliaChk.onchange   = this.onJuliaChange;
    this.dualViewChk.onchange = this.onDualViewChange;
    this.progressiveChk.onchange = this.onProgressiveChange;
    this.smoothColoringChk.onchange = this.onSmoothColoringChange;
    this.gridOverlayChk.onchange = this.onGridOverlayChange;
    this.centerMarkerChk.onchange = this.onCenterMarkerChange;
    this.juliaMarkerChk.onchange = this.onJuliaMarkerChange;
    this.backBtn.onclick    = this.onBack;
    this.forwardBtn.onclick = this.onForward;
    this.resetBtn.onclick   = this.onReset;
    this.shareBtn.onclick   = this.onShare;
    this.uiToggleBtn.onclick = this.onUiToggle;

    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("resize", this.onResize);
    window.addEventListener("keydown", this.onKeyDown);

    this.setScale(this.scale);
    this.setMaxIter(this.maxIter);
    this.palette256 = makePalette(this.paletteType);

    this.drawOverlay();
  }

  setScale(next) {
    this.mandelbrotPanel.setScale(next, MandelbrotApp.MIN_SCALE, MandelbrotApp.MAX_SCALE);
    this.syncZoomSliderUI();
  }

  syncZoomSliderUI() {
    this.zoomSlider.value = Math.log10(this.scale);
    this.zoomLabel.textContent = this.scale;
  }

  snapshotView() {
    return {
      center: this.center,
      scale: this.scale,
      maxIter: this.maxIter,
      juliaMode: this.juliaMode,
      juliaC: this.juliaC,
      paletteType: this.paletteType,
      progressiveMode: this.progressiveMode,
      smoothColoring: this.smoothColoring,
    };
  }

  saveSettings() {
    const data = share.settingsData(this);
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
    return share.buildShareUrl(this, this.initialState, location.origin, location.pathname);
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

    const pointFields = ["center", "juliaC"];
    const numberFields = [
      "centerMarker", "gridOverlay", "juliaMarker", "juliaMode", "maxIter",
      "paletteType", "progressiveMode", "scale", "smoothColoring",
    ];
    pointFields.forEach(restorePoint);
    numberFields.forEach(restoreNumber);

    this.pivot = this.center;

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
    this.center = s.center;
    this.pivot = s.center;
    this.pivotScreen = new DOMPointReadOnly(0.5, 0.5);
    this.setScale(s.scale);
    this.setMaxIter(s.maxIter);

    this.juliaMode = s.juliaMode;
    this.juliaChk.checked = !!s.juliaMode;
    this.juliaC = s.juliaC;

    this.applyPalette(s.paletteType);
    this.paletteSel.value = s.paletteType;

    this.progressiveMode = s.progressiveMode;
    this.progressiveChk.checked = !!s.progressiveMode;

    this.smoothColoring = s.smoothColoring;
    this.smoothColoringChk.checked = !!s.smoothColoring;

    this.resetProgressive();
    this.scheduleRender();
  }

  setMaxIter(next) {
    this.maxIter = Math.round(Math.min(MandelbrotApp.MAX_ITER, Math.max(MandelbrotApp.MIN_ITER, next)));
    this.iterSlider.value = Math.log10(this.maxIter);
    this.iterLabel.textContent = this.maxIter;
  }

  resizeCanvas() {
    this.mandelbrotPanel.resizeCanvas();
  }

  resizeOverlayCanvas() {
    this.mandelbrotPanel.resizeOverlayCanvas();
  }

  onResize = () => {
    this.resizeCanvas();
    this.resizeOverlayCanvas();
    if (this.dualView && this.juliaPanel) {
      this.juliaPanel.resizeCanvas();
      this.juliaPanel.resizeOverlayCanvas();
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
      const displayIter = this.renderOnce();
      this.scheduleSaveSettings();
      const anyDragging = this.isDragging || !!(this.dualView && this.juliaPanel?.isDragging);
      if (this.progressiveMode && displayIter < this.maxIter && !anyDragging) {
        this.scheduleRender();
      }
    });
  };

  // `showJuliaMarker` is false for the Julia panel itself: the marker
  // points at where juliaC sits on the *Mandelbrot* plane, which is
  // meaningless overlaid on the Julia panel's own view.
  drawOverlayForPanel(panel, { showJuliaMarker }) {
    const ctx = panel.overlayCtx;
    const w = panel.overlayCssWidth;
    const h = panel.overlayCssHeight;
    const aspect = panel.canvas.width / panel.canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (this.gridOverlay) overlay.drawGrid(ctx, w, h, panel.center, panel.scale, aspect);
    if (this.centerMarker) overlay.drawCenterMarker(ctx, w, h, panel.center, panel.scale, aspect);
    if (showJuliaMarker && this.juliaMarker) overlay.drawJuliaMarker(ctx, w, h, this.juliaC, panel.center, panel.scale, aspect);
  }

  drawOverlay = () => {
    this.drawOverlayForPanel(this.mandelbrotPanel, { showJuliaMarker: true });
    if (this.dualView && this.juliaPanel) this.drawOverlayForPanel(this.juliaPanel, { showJuliaMarker: false });
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
    this.renderer = await attachCanvas(this.gpuDevice, this.canvas, this.palette256);
    // Dual view may have been toggled on before WebGPU finished
    // initializing; attach the Julia panel now if it's still waiting.
    if (this.juliaPanel && !this.juliaPanel.renderer) {
      this.juliaPanel.renderer = await attachCanvas(this.gpuDevice, this.juliaPanel.canvas, this.palette256);
    }
    this.scheduleRender();
  }

  resetProgressive() {
    this.progressiveIter = 1;
  }

  applyPalette(type) {
    this.paletteType = type;
    this.palette256 = makePalette(type);
    if (this.renderer) this.renderer.writePalette(this.palette256);
    if (this.juliaPanel?.renderer) this.juliaPanel.renderer.writePalette(this.palette256);
  }

  // Screen-normalized [0,1] point -> fractal-space point, anchored at `anchor`.
  toFractal(normPoint, anchor) {
    return this.mandelbrotPanel.toFractal(normPoint, anchor);
  }

  onIterInput = () => {
    if (!this.pendingIterSnapshot) this.pendingIterSnapshot = this.snapshotView();
    this.setMaxIter(10 ** Number(this.iterSlider.value));
    this.resetProgressive();
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

  onJuliaChange = () => {
    this.pushHistory(this.snapshotView());
    this.juliaMode = this.juliaChk.checked ? 1 : 0;
    this.resetProgressive();
    this.scheduleRender();
  };

  // Dual view is a display preference, not view state (mirrors the overlay
  // toggles below) — no pushHistory. The Julia panel is created lazily on
  // first activation and then kept alive (just hidden by CSS) so toggling
  // back on doesn't need to re-attach WebGPU.
  onDualViewChange = () => {
    this.dualView = this.dualViewChk.checked ? 1 : 0;
    document.body.classList.toggle("dual-view", !!this.dualView);
    // The CSS width of #gfx/#overlay changes (100vw <-> 50vw) the instant the
    // class toggles; refresh both panels' backing stores now rather than
    // waiting for the next window resize, or the image stays stretched.
    this.resizeCanvas();
    this.resizeOverlayCanvas();
    if (this.juliaPanel) {
      this.juliaPanel.resizeCanvas();
      this.juliaPanel.resizeOverlayCanvas();
    }
    if (this.dualView && !this.juliaPanel) {
      const panel = new FractalPanel(document.getElementById("gfxJulia"), document.getElementById("overlayJulia"));
      panel.center = this.juliaC;
      panel.pivot = this.juliaC;
      this.juliaPanel = panel;
      this.attachJuliaPanelEvents(panel);
      if (this.gpuDevice) {
        attachCanvas(this.gpuDevice, panel.canvas, this.palette256)
          .then((renderer) => {
            panel.renderer = renderer;
            this.scheduleRender();
          })
          .catch((e) => this.showError(`Failed to initialize the Julia panel: ${e.message}`));
      }
    }
    this.scheduleRender();
  };

  // Wires the Julia panel's own pan/zoom/select gestures. No onGenuineClick
  // hook: clicking inside the Julia panel only moves its own pivot/zoom
  // anchor, it never sets juliaC (only a click on the Mandelbrot panel does
  // that). Its pan/zoom also isn't pushed to the shared undo history —
  // Back/Forward navigates the Mandelbrot view only.
  attachJuliaPanelEvents(panel) {
    const noHistory = () => {};
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
        pushHistory: noHistory,
        resetProgressive: () => this.resetProgressive(),
        scheduleRender: () => this.scheduleRender(),
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
        armWheelHistory: noHistory,
        resetProgressive: () => this.resetProgressive(),
        scheduleRender: () => this.scheduleRender(),
      });
    }, { passive: false });
  }

  onProgressiveChange = () => {
    this.pushHistory(this.snapshotView());
    this.progressiveMode = this.progressiveChk.checked ? 1 : 0;
    this.resetProgressive();
    this.scheduleRender();
  };

  onSmoothColoringChange = () => {
    this.pushHistory(this.snapshotView());
    this.smoothColoring = this.smoothColoringChk.checked ? 1 : 0;
    this.scheduleRender();
  };

  // Overlay display preferences are not part of view history: they don't
  // change what the fractal render pass produces, only what's drawn on the
  // separate #overlay canvas, so no pushHistory here (unlike the toggles above).
  onGridOverlayChange = () => {
    this.gridOverlay = this.gridOverlayChk.checked ? 1 : 0;
    this.scheduleRender();
  };

  onCenterMarkerChange = () => {
    this.centerMarker = this.centerMarkerChk.checked ? 1 : 0;
    this.scheduleRender();
  };

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
    this.pendingIterSnapshot = null;
    this.pendingZoomSnapshot = null;
    this.history.reset();
    // Overlay display preferences aren't part of view history (see the
    // comment on the on*Change handlers below), but Reset should still
    // restore them to their defaults along with everything else.
    const overlayFields = [
      ["centerMarker", "centerMarkerChk"],
      ["gridOverlay", "gridOverlayChk"],
      ["juliaMarker", "juliaMarkerChk"],
    ];
    overlayFields.forEach(([field, chk]) => {
      this[field] = 0;
      this[chk].checked = false;
    });
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

  // PAN / CLICK / SELECT: delegated to FractalPanel, which owns the pointer
  // math; hooks here supply the app-global side effects (history, render
  // scheduling, UI sync) and what a genuine click on this panel should do.
  onPointerDown = (e) => {
    this.mandelbrotPanel.onPointerDown(e, {
      selectionBox: this.selectionBox,
      snapshotView: () => this.snapshotView(),
    });
  };

  onPointerMove = (e) => {
    this.mandelbrotPanel.onPointerMove(e, { selectionBox: this.selectionBox });
  };

  onPointerUp = (e) => {
    this.mandelbrotPanel.onPointerUp(e, {
      selectionBox: this.selectionBox,
      minScale: MandelbrotApp.MIN_SCALE,
      maxScale: MandelbrotApp.MAX_SCALE,
      snapshotView: () => this.snapshotView(),
      pushHistory: (s) => this.pushHistory(s),
      resetProgressive: () => this.resetProgressive(),
      scheduleRender: () => this.scheduleRender(),
      onScaleChange: () => this.syncZoomSliderUI(),
      onGenuineClick: (fractalPoint) => {
        this.juliaC = fractalPoint;
        // Only a Julia render actually depends on juliaC: the exclusive
        // full-screen Julia mode, or the Julia panel in dual view. Plain
        // Mandelbrot mode with dual view off just moves the marker, so
        // don't restart its progressive reveal over an unchanged image.
        if (this.juliaMode === 1 || (this.dualView && this.juliaPanel)) this.resetProgressive();
      },
    });
  };

  onPointerLeave = () => {
    this.mandelbrotPanel.onPointerLeave({ selectionBox: this.selectionBox });
  };

  // WHEEL → zoom centered on the pivot
  onWheel = (e) => {
    this.mandelbrotPanel.onWheel(e, {
      minScale: MandelbrotApp.MIN_SCALE,
      maxScale: MandelbrotApp.MAX_SCALE,
      armWheelHistory: () => this.history.armWheel(() => this.snapshotView()),
      resetProgressive: () => this.resetProgressive(),
      scheduleRender: () => this.scheduleRender(),
      onScaleChange: () => this.syncZoomSliderUI(),
    });
  };

  // Renders one panel with the given juliaMode/displayIter (both panels
  // share the same progressive ramp and iteration count; see renderOnce).
  renderPanel(panel, juliaMode, displayIter) {
    if (!panel.renderer) return;
    const data = buildUniformData({
      center: panel.center,
      scale: panel.scale,
      juliaC: this.juliaC,
      displayIter,
      canvasWidth: panel.canvas.width,
      canvasHeight: panel.canvas.height,
      juliaMode,
      smoothColoring: this.smoothColoring,
    });
    panel.renderer.render(data);
  }

  // RENDER
  renderOnce = () => {
    if (this.deviceLost || !this.renderer) return Infinity;

    const anyDragging = this.isDragging || !!(this.dualView && this.juliaPanel?.isDragging);
    let displayIter = this.maxIter;
    if (this.progressiveMode && !anyDragging) {
      displayIter = Math.min(this.progressiveIter, this.maxIter);
      if (this.progressiveIter < this.maxIter) {
        this.progressiveIter = Math.min(this.maxIter, Math.ceil(this.progressiveIter * 1.08 + 1));
      }
    }

    this.renderPanel(this.mandelbrotPanel, this.juliaMode, displayIter);
    if (this.dualView && this.juliaPanel) this.renderPanel(this.juliaPanel, 1, displayIter);

    // Exposed on the instance (rather than a local) so e2e tests can observe
    // the iteration count actually rendered, not just progressiveIter's
    // internal, already-incremented-for-next-frame value.
    this.lastDisplayIter = displayIter;
    return displayIter;
  };
}

const app = new MandelbrotApp(document.getElementById("gfx"));
window.app = app; // exposed for e2e test assertions on internal state (tests/)
try {
  await app.init();
} catch (e) {
  app.showError(`Failed to initialize WebGPU: ${e.message}`);
}
