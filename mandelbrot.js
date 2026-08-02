import { domPoint, view } from './geometry.js';
import { split64 } from './precision.js';
import { makePalette } from './palette.js';
import { overlay } from './overlay.js';
import { share } from './share.js';
import { ViewHistory } from './history.js';
import { createRenderer } from './renderer.js';

class MandelbrotApp {
  static MIN_SCALE = 1e-14;
  static MAX_SCALE = 4.0;
  static MIN_ITER = 1;
  static MAX_ITER = 8192;
  static WHEEL_HISTORY_MS = 250;
  static SETTINGS_KEY = 'isghe-mandelbrot-settings';
  static SETTINGS_SAVE_MS = 400;

  // State (JS = f64)
  center = new DOMPointReadOnly(-0.5, 0.0);
  scale   = 3.0;
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

  // pivot for centered zoom
  pivot = new DOMPointReadOnly(-0.5, 0.0);
  pivotScreen = new DOMPointReadOnly(0.5, 0.5);

  // pan
  isDragging = false;
  hasDragged = false;
  dragStart = new DOMPointReadOnly(0, 0);
  startCenter = new DOMPointReadOnly(0, 0);

  // selection area (Ctrl + drag)
  isSelecting = false;
  selectStart = new DOMPointReadOnly(0, 0);

  // view history (Back / Forward)
  history = new ViewHistory(MandelbrotApp.WHEEL_HISTORY_MS, () => this.updateHistoryButtons());
  dragStartSnapshot = null;
  pendingZoomSnapshot = null;
  pendingIterSnapshot = null;
  saveSettingsTimer = null;
  shareBtnResetTimer = null;

  // render scheduling
  rafPending = false;

  // Set once the WebGPU device is lost; blocks further render attempts.
  deviceLost = false;

  constructor(canvas) {
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

    this.canvas = canvas;
    this.resizeCanvas();

    this.overlayCanvas = document.getElementById("overlay");
    this.overlayCtx = this.overlayCanvas.getContext("2d");
    this.resizeOverlayCanvas();

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
    this.progressiveChk = document.getElementById("progressiveMode");
    this.smoothColoringChk = document.getElementById("smoothColoring");
    this.gridOverlayChk = document.getElementById("gridOverlay");
    this.centerMarkerChk = document.getElementById("centerMarker");
    this.juliaMarkerChk = document.getElementById("juliaMarker");
    this.gridOverlayChk.checked = !!this.gridOverlay;
    this.centerMarkerChk.checked = !!this.centerMarker;
    this.juliaMarkerChk.checked = !!this.juliaMarker;
    this.juliaChk.checked = !!this.juliaMode;
    this.paletteSel.value = this.paletteType;
    this.progressiveChk.checked = !!this.progressiveMode;
    this.smoothColoringChk.checked = !!this.smoothColoring;
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
    this.scale = Math.min(MandelbrotApp.MAX_SCALE, Math.max(MandelbrotApp.MIN_SCALE, next));
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
      return raw ? JSON.parse(raw) : null;
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

    restorePoint("center");
    restoreNumber("scale");
    restoreNumber("maxIter");
    restoreNumber("juliaMode");
    restorePoint("juliaC");
    restoreNumber("paletteType");
    restoreNumber("progressiveMode");
    restoreNumber("smoothColoring");
    restoreNumber("gridOverlay");
    restoreNumber("centerMarker");
    restoreNumber("juliaMarker");

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
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  // Keeps the overlay's backing store in sync with #gfx; the transform
  // reset lets overlay draw calls be written in CSS pixels.
  resizeOverlayCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.overlayCanvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (this.overlayCanvas.width !== width || this.overlayCanvas.height !== height) {
      this.overlayCanvas.width = width;
      this.overlayCanvas.height = height;
    }
    this.overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.overlayCssWidth = rect.width;
    this.overlayCssHeight = rect.height;
  }

  onResize = () => {
    this.resizeCanvas();
    this.resizeOverlayCanvas();
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
      if (this.progressiveMode && this.progressiveIter < this.maxIter && !this.isDragging) {
        this.scheduleRender();
      }
    });
  };

  drawOverlay = () => {
    const ctx = this.overlayCtx;
    const w = this.overlayCssWidth;
    const h = this.overlayCssHeight;
    const aspect = this.canvas.width / this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (this.gridOverlay) overlay.drawGrid(ctx, w, h, this.center, this.scale, aspect);
    if (this.centerMarker) overlay.drawCenterMarker(ctx, w, h, this.center, this.scale, aspect);
    if (this.juliaMarker) overlay.drawJuliaMarker(ctx, w, h, this.juliaC, this.center, this.scale, aspect);
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
    const renderer = await createRenderer(this.canvas, this.palette256, {
      onDeviceLost: (info) => {
        this.deviceLost = true;
        this.showFatalError(`WebGPU device lost (${info.reason}): ${info.message}`);
      },
      onUncapturedError: (message) => this.showError(`WebGPU error: ${message}`),
    });
    if (!renderer) {
      this.showError("No WebGPU adapter available.");
      return;
    }
    this.renderer = renderer;
    this.scheduleRender();
  }

  resetProgressive() {
    this.progressiveIter = 1;
  }

  applyPalette(type) {
    this.paletteType = type;
    this.palette256 = makePalette(type);
    if (!this.renderer) return;
    this.renderer.writePalette(this.palette256);
  }

  // Screen-normalized [0,1] point -> fractal-space point, anchored at `anchor`.
  toFractal(normPoint, anchor) {
    const aspect = this.canvas.width / this.canvas.height;
    return view.normalizedToFractal(normPoint, anchor, this.scale, aspect);
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
    this.gridOverlay = 0;
    this.gridOverlayChk.checked = false;
    this.centerMarker = 0;
    this.centerMarkerChk.checked = false;
    this.juliaMarker = 0;
    this.juliaMarkerChk.checked = false;
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

  // PAN: pointerdown / pointermove / pointerup
  onPointerDown = (e) => {
    this.canvas.setPointerCapture(e.pointerId);
    if (e.ctrlKey) {
      this.isSelecting = true;
      this.dragStartSnapshot = this.snapshotView();
      this.selectStart = new DOMPointReadOnly(e.clientX, e.clientY);
      this.selectionBox.style.left = this.selectStart.x + "px";
      this.selectionBox.style.top = this.selectStart.y + "px";
      this.selectionBox.style.width = "0px";
      this.selectionBox.style.height = "0px";
      this.selectionBox.style.display = "block";
      return;
    }
    this.isDragging = true;
    this.hasDragged = false;
    this.dragStartSnapshot = this.snapshotView();
    const rect = this.canvas.getBoundingClientRect();
    this.dragStart = new DOMPointReadOnly((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
    this.dragStartClient = new DOMPointReadOnly(e.clientX, e.clientY);
    this.startCenter = this.center;
  };

  onPointerMove = (e) => {
    if (this.isSelecting) {
      const box = DOMRectReadOnly.fromRect({
        x: Math.min(e.clientX, this.selectStart.x),
        y: Math.min(e.clientY, this.selectStart.y),
        width: Math.abs(e.clientX - this.selectStart.x),
        height: Math.abs(e.clientY - this.selectStart.y),
      });
      this.selectionBox.style.left = box.x + "px";
      this.selectionBox.style.top = box.y + "px";
      this.selectionBox.style.width = box.width + "px";
      this.selectionBox.style.height = box.height + "px";
      return;
    }
    if (!this.isDragging) return;
    this.hasDragged = true;
    // Cheap CSS-transform preview while dragging: the real WebGPU render
    // (expensive) only runs once, on pointerup, with the final center.
    const dx = e.clientX - this.dragStartClient.x;
    const dy = e.clientY - this.dragStartClient.y;
    const preview = `translate(${dx}px, ${dy}px)`;
    this.canvas.style.transform = preview;
    this.overlayCanvas.style.transform = preview;
  };

  clearDragPreview = () => {
    this.canvas.style.transform = "";
    this.overlayCanvas.style.transform = "";
  };

  onPointerUp = (e) => {
    if (this.isSelecting) {
      this.isSelecting = false;
      this.selectionBox.style.display = "none";

      const rect = this.canvas.getBoundingClientRect();
      const screenSel = DOMRectReadOnly.fromRect({
        x: Math.min(e.clientX, this.selectStart.x) - rect.left,
        y: Math.min(e.clientY, this.selectStart.y) - rect.top,
        width: Math.abs(e.clientX - this.selectStart.x),
        height: Math.abs(e.clientY - this.selectStart.y),
      });

      // ignore selections that are too small (e.g. Ctrl+click without dragging)
      if (screenSel.width < 3 || screenSel.height < 3) return;

      const aspect = this.canvas.width / this.canvas.height;

      const topLeftNorm = new DOMPointReadOnly(screenSel.left / rect.width, screenSel.top / rect.height);
      const bottomRightNorm = new DOMPointReadOnly(screenSel.right / rect.width, screenSel.bottom / rect.height);
      const f1 = this.toFractal(topLeftNorm, this.center);
      const f2 = this.toFractal(bottomRightNorm, this.center);

      this.center = domPoint.mid(f1, f2);

      const selWidth  = Math.abs(f2.x - f1.x);
      const selHeight = Math.abs(f1.y - f2.y);
      this.setScale(Math.max(selHeight, selWidth / aspect));

      this.pivot = this.center;
      this.pivotScreen = new DOMPointReadOnly(0.5, 0.5);

      this.pushHistory(this.dragStartSnapshot);
      this.resetProgressive();
      this.scheduleRender();
      return;
    }

    this.isDragging = false;

    // Genuine CLICK (no dragging) → pivot (Y corrected: NDC vs canvas)
    if (!this.hasDragged) {
      const rect = this.canvas.getBoundingClientRect();
      const mouse = new DOMPointReadOnly((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);

      this.pivotScreen = mouse;
      this.pivot = this.toFractal(mouse, this.center);

      this.pushHistory(this.snapshotView());
      this.juliaC = this.pivot;
      // Only the Julia render actually depends on juliaC; in Mandelbrot
      // mode this just moves the marker, so don't restart its progressive
      // reveal over an unrelated, unchanged image.
      if (this.juliaMode === 1) this.resetProgressive();
      this.scheduleRender();
      return;
    }

    // Drag finished: commit the CSS preview into the real center and
    // trigger the one real render this drag gets.
    this.clearDragPreview();
    const rect = this.canvas.getBoundingClientRect();
    const mouse = new DOMPointReadOnly((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
    const delta = domPoint.sub(mouse, this.dragStart);
    const aspect = this.canvas.width / this.canvas.height;

    this.center = view.pan(this.startCenter, delta, this.scale, aspect);
    this.pivot = this.center;
    this.pivotScreen = new DOMPointReadOnly(0.5, 0.5);

    if (this.dragStartSnapshot) {
      this.pushHistory(this.dragStartSnapshot);
      this.dragStartSnapshot = null;
    }
    this.scheduleRender();
  };

  onPointerLeave = () => {
    if (this.isDragging) this.clearDragPreview();
    this.isDragging = false;
    if (this.isSelecting) {
      this.isSelecting = false;
      this.selectionBox.style.display = "none";
    }
  };

  // WHEEL → zoom centered on the pivot
  onWheel = (e) => {
    e.preventDefault();
    this.history.armWheel(() => this.snapshotView());
    const aspect = this.canvas.width / this.canvas.height;
    const zoomFactor = (e.deltaY > 0 ? 1.1 : 0.9);

    this.setScale(this.scale * zoomFactor);

    // Keeps the fractal point under pivotScreen fixed at the new scale.
    this.center = view.anchorFor(this.pivot, this.pivotScreen, this.scale, aspect);

    this.resetProgressive();
    this.scheduleRender();
  };

  // RENDER
  renderOnce = () => {
    if (this.deviceLost || !this.renderer) return;
    const [cx_hi, cx_lo] = split64(this.center.x);
    const [cy_hi, cy_lo] = split64(this.center.y);
    const [jx_hi, jx_lo] = split64(this.juliaC.x);
    const [jy_hi, jy_lo] = split64(this.juliaC.y);

    let displayIter = this.maxIter;
    if (this.progressiveMode && !this.isDragging) {
      displayIter = Math.min(this.progressiveIter, this.maxIter);
      if (this.progressiveIter < this.maxIter) {
        this.progressiveIter = Math.min(this.maxIter, Math.ceil(this.progressiveIter * 1.08 + 1));
      }
    }

    const data = new Float32Array([
      this.scale,
      cx_hi, cx_lo,
      cy_hi, cy_lo,
      jx_hi, jx_lo,
      jy_hi, jy_lo,
      displayIter,
      this.canvas.width,
      this.canvas.height,
      this.juliaMode,
      this.smoothColoring,
      0, 0 // padding to 64 B (16 floats), see renderer.js's uniformBuffer comment
    ]);

    this.renderer.render(data);
  };
}

const app = new MandelbrotApp(document.getElementById("gfx"));
window.app = app; // exposed for e2e test assertions on internal state (tests/)
try {
  await app.init();
} catch (e) {
  app.showError(`Failed to initialize WebGPU: ${e.message}`);
}
