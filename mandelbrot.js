import { domPoint, view, grid } from './geometry.js';
import { split64 } from './precision.js';

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
  viewHistory = [];
  viewFuture = [];
  dragStartSnapshot = null;
  pendingZoomSnapshot = null;
  pendingIterSnapshot = null;
  pendingWheelSnapshot = null;
  wheelHistoryTimer = null;
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
    this.palette256 = this.makePalette(this.paletteType);

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
    const data = {
      center: { x: this.center.x, y: this.center.y },
      scale: this.scale,
      maxIter: this.maxIter,
      juliaMode: this.juliaMode,
      juliaC: { x: this.juliaC.x, y: this.juliaC.y },
      paletteType: this.paletteType,
      progressiveMode: this.progressiveMode,
      smoothColoring: this.smoothColoring,
      gridOverlay: this.gridOverlay,
      centerMarker: this.centerMarker,
      juliaMarker: this.juliaMarker,
    };
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

  // Only encodes fields that differ from the initial condition, so the
  // "Reset to initial condition" state always maps to a bare URL and the
  // address bar only ever names what's actually been changed.
  buildShareUrl() {
    const init = this.initialState;
    const params = new URLSearchParams();

    if (this.center.x !== init.center.x || this.center.y !== init.center.y) {
      params.set("x", this.center.x);
      params.set("y", this.center.y);
    }
    if (this.scale !== init.scale) params.set("scale", this.scale);
    if (this.maxIter !== init.maxIter) params.set("iter", this.maxIter);
    if (this.juliaMode !== init.juliaMode) params.set("julia", this.juliaMode);
    if (this.juliaC.x !== init.juliaC.x || this.juliaC.y !== init.juliaC.y) {
      params.set("jx", this.juliaC.x);
      params.set("jy", this.juliaC.y);
    }
    if (this.paletteType !== init.paletteType) params.set("palette", this.paletteType);
    if (this.progressiveMode !== init.progressiveMode) params.set("progressive", this.progressiveMode);
    if (this.smoothColoring !== init.smoothColoring) params.set("smooth", this.smoothColoring);
    // Overlay display preferences aren't part of initialState (see the
    // comment on the on*Change handlers below); Reset always zeroes them.
    if (this.gridOverlay) params.set("grid", this.gridOverlay);
    if (this.centerMarker) params.set("centerMark", this.centerMarker);
    if (this.juliaMarker) params.set("juliaMark", this.juliaMarker);

    const qs = params.toString();
    return `${location.origin}${location.pathname}${qs ? "?" + qs : ""}`;
  }

  parseShareParams() {
    const params = new URLSearchParams(location.search);
    if ([...params.keys()].length === 0) return null;

    const num = (name) => {
      const v = Number(params.get(name));
      return Number.isFinite(v) ? v : undefined;
    };

    const s = {};
    const x = num("x"), y = num("y");
    if (x !== undefined && y !== undefined) s.center = { x, y };
    const scale = num("scale"); if (scale !== undefined) s.scale = scale;
    const maxIter = num("iter"); if (maxIter !== undefined) s.maxIter = maxIter;
    const juliaMode = num("julia"); if (juliaMode !== undefined) s.juliaMode = juliaMode;
    const jx = num("jx"), jy = num("jy");
    if (jx !== undefined && jy !== undefined) s.juliaC = { x: jx, y: jy };
    const paletteType = num("palette"); if (paletteType !== undefined) s.paletteType = paletteType;
    const progressiveMode = num("progressive"); if (progressiveMode !== undefined) s.progressiveMode = progressiveMode;
    const smoothColoring = num("smooth"); if (smoothColoring !== undefined) s.smoothColoring = smoothColoring;
    const gridOverlay = num("grid"); if (gridOverlay !== undefined) s.gridOverlay = gridOverlay;
    const centerMarker = num("centerMark"); if (centerMarker !== undefined) s.centerMarker = centerMarker;
    const juliaMarker = num("juliaMark"); if (juliaMarker !== undefined) s.juliaMarker = juliaMarker;

    return Object.keys(s).length > 0 ? s : null;
  }

  restoreSettings() {
    const shared = this.parseShareParams();
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
    if (this.wheelHistoryTimer) {
      this.flushPendingWheelHistory();
    }
    this.viewHistory.push(snapshot);
    this.viewFuture = [];
    this.updateHistoryButtons();
  }

  flushPendingWheelHistory() {
    if (this.wheelHistoryTimer) {
      clearTimeout(this.wheelHistoryTimer);
      this.wheelHistoryTimer = null;
    }
    if (this.pendingWheelSnapshot) {
      const snap = this.pendingWheelSnapshot;
      this.pendingWheelSnapshot = null;
      this.pushHistory(snap);
    }
  }

  updateHistoryButtons() {
    this.backBtn.disabled = this.viewHistory.length === 0 && !this.pendingWheelSnapshot;
    this.forwardBtn.disabled = this.viewFuture.length === 0;
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
    ctx.clearRect(0, 0, w, h);
    if (this.gridOverlay) this.drawGrid(ctx, w, h);
    if (this.centerMarker) this.drawCenterMarker(ctx, w, h);
    if (this.juliaMarker) this.drawJuliaMarker(ctx, w, h);
  };

  // Fractal-space point -> overlay pixel point (CSS px), for the current
  // view. Thin wrapper pulling instance state around the pure
  // view.fractalToPixel, so overlay drawing stays in DOMPoint terms until
  // the final ctx.* calls, the only place scalars are unavoidable (Canvas 2D API).
  toPixel(fractalPoint, w, h) {
    const aspect = this.canvas.width / this.canvas.height;
    return view.fractalToPixel(fractalPoint, this.center, this.scale, aspect, w, h);
  }

  drawGrid(ctx, w, h) {
    const aspect = this.canvas.width / this.canvas.height;
    const step = grid.niceGridStep(this.scale, 8);
    const half = new DOMPointReadOnly((this.scale * aspect) / 2, this.scale / 2);
    const min = domPoint.sub(this.center, half);
    const max = domPoint.add(this.center, half);
    const eps = step * 1e-9;

    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const x of grid.gridLines(min.x, max.x, step)) {
      if (Math.abs(x) < eps) continue;
      const p = this.toPixel(new DOMPointReadOnly(x, 0), w, h);
      ctx.moveTo(p.x, 0);
      ctx.lineTo(p.x, h);
    }
    for (const y of grid.gridLines(min.y, max.y, step)) {
      if (Math.abs(y) < eps) continue;
      const p = this.toPixel(new DOMPointReadOnly(0, y), w, h);
      ctx.moveTo(0, p.y);
      ctx.lineTo(w, p.y);
    }
    ctx.stroke();

    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (min.x <= 0 && 0 <= max.x) {
      const p = this.toPixel(new DOMPointReadOnly(0, 0), w, h);
      ctx.moveTo(p.x, 0);
      ctx.lineTo(p.x, h);
    }
    if (min.y <= 0 && 0 <= max.y) {
      const p = this.toPixel(new DOMPointReadOnly(0, 0), w, h);
      ctx.moveTo(0, p.y);
      ctx.lineTo(w, p.y);
    }
    ctx.stroke();
  }

  // Position is always (w/2, h/2) since `center` is toFractal's anchor, but
  // it's still routed through toPixel for symmetry with drawJuliaMarker and
  // so it stays correct if that invariant ever changes.
  drawCenterMarker(ctx, w, h) {
    const p = this.toPixel(this.center, w, h);
    const r = 6;

    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    this.strokeCrosshair(ctx, p, r);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#ffffff";
    this.strokeCrosshair(ctx, p, r);
  }

  strokeCrosshair(ctx, p, r) {
    const { x: px, y: py } = p;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.moveTo(px - r - 4, py);
    ctx.lineTo(px - r, py);
    ctx.moveTo(px + r, py);
    ctx.lineTo(px + r + 4, py);
    ctx.moveTo(px, py - r - 4);
    ctx.lineTo(px, py - r);
    ctx.moveTo(px, py + r);
    ctx.lineTo(px, py + r + 4);
    ctx.stroke();
  }

  // Diamond marker, distinct in shape and color from the center crosshair
  // so the two are never confused when both are visible.
  drawJuliaMarker(ctx, w, h) {
    const p = this.toPixel(this.juliaC, w, h);
    if (p.x < 0 || p.x > w || p.y < 0 || p.y > h) return;
    const r = 7;

    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    this.strokeDiamond(ctx, p, r);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#ffee33";
    this.strokeDiamond(ctx, p, r);
  }

  strokeDiamond(ctx, p, r) {
    const { x: px, y: py } = p;
    ctx.beginPath();
    ctx.moveTo(px, py - r);
    ctx.lineTo(px + r, py);
    ctx.lineTo(px, py + r);
    ctx.lineTo(px - r, py);
    ctx.closePath();
    ctx.stroke();
  }

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
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      this.showError("No WebGPU adapter available.");
      return;
    }
    this.device  = await adapter.requestDevice();

    this.device.lost.then((info) => {
      if (info.reason === "destroyed") return; // we tore it down ourselves
      this.deviceLost = true;
      this.showFatalError(`WebGPU device lost (${info.reason}): ${info.message}`);
    });
    this.device.addEventListener("uncapturederror", (event) => {
      this.showError(`WebGPU error: ${event.error.message}`);
    });

    this.context = this.canvas.getContext("webgpu");
    if (!this.context) {
      throw new Error("Unable to create the WebGPU canvas context.");
    }
    this.format  = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device: this.device, format: this.format });

    this.paletteTex = this.device.createTexture({
      size:[256,1],
      format:"rgba8unorm",
      usage:GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    this.device.queue.writeTexture(
      {texture:this.paletteTex},
      this.palette256,
      {bytesPerRow:256*4},
      {width:256,height:1}
    );
    this.paletteSampler = this.device.createSampler({
      magFilter:"linear", minFilter:"linear"
    });

    // WGSL (f32 + double-single center/julia)
    const shaderResponse = await fetch("mandelbrot.wgsl", { cache: "no-cache" });
    if (!shaderResponse.ok) {
      throw new Error(`WGSL fetch failed: ${shaderResponse.status}`);
    }
    const shaderCode = await shaderResponse.text();
    const module = this.device.createShaderModule({code:shaderCode});

    const compilationInfo = await module.getCompilationInfo();
    const shaderErrors = compilationInfo.messages.filter((message) => message.type === "error");
    if (shaderErrors.length > 0) {
      throw new Error(
        shaderErrors.map((error) => `${error.lineNum}:${error.linePos} ${error.message}`).join("\n")
      );
    }

    this.pipeline = this.device.createRenderPipeline({
      layout:"auto",
      vertex:{module,entryPoint:"vs_main"},
      fragment:{module,entryPoint:"fs_main",targets:[{format:this.format}]},
      primitive:{topology:"triangle-list"}
    });

    // Uniform buffer: 14 logical f32 fields + 2 padding floats, since WGSL
    // rounds a uniform struct's size up to a 16-byte multiple (64 B here).
    this.uniformBuffer = this.device.createBuffer({
      size: 16 * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    this.bindGroup = this.device.createBindGroup({
      layout:this.pipeline.getBindGroupLayout(0),
      entries:[
        {binding:0,resource:{buffer:this.uniformBuffer}},
        {binding:1,resource:this.paletteSampler},
        {binding:2,resource:this.paletteTex.createView()}
      ]
    });

    this.scheduleRender();
  }

  resetProgressive() {
    this.progressiveIter = 1;
  }

  // 256-entry palette
  makePalette(type) {
    const arr = new Uint8Array(256 * 4);

    const APPLE2 = [
      [0,0,0],[255,255,255],[255,0,0],[0,255,0],
      [0,0,255],[255,255,0],[255,0,255],[0,255,255],
      [128,128,128],[255,128,0],[128,0,255],[0,128,255],
      [128,255,0],[255,0,128],[0,255,128],[128,0,0]
    ];

    const VIRIDIS = [
      [68,1,84],[71,44,122],[59,81,139],[44,113,142],
      [33,144,141],[39,173,129],[92,200,99],[170,220,50],
      [253,231,37]
    ];

    let P;
    if (type === 4) P = APPLE2;
    else if (type === 0) P = VIRIDIS;
    else {
      P = [];
      for (let i=0;i<16;i++){
        const t=i/15;
        if (type===1) P.push([255*t,80*t,0]);          // Fire
        else if (type===2) P.push([0,100*t,255*t]);   // Ocean
        else P.push([                                   // Rainbow
          (Math.sin(6.28318*t)+1)/2*255,
          (Math.sin(6.28318*(t+0.33))+1)/2*255,
          (Math.sin(6.28318*(t+0.66))+1)/2*255
        ]);
      }
    }

    for (let i=0;i<256;i++){
      const t=i/255;
      const p=t*(P.length-1);
      const idx=Math.floor(p);
      const f=p-idx;
      const idx2=Math.min(idx+1,P.length-1);

      const r=P[idx][0]*(1-f)+P[idx2][0]*f;
      const g=P[idx][1]*(1-f)+P[idx2][1]*f;
      const b=P[idx][2]*(1-f)+P[idx2][2]*f;

      arr[i*4+0]=r;
      arr[i*4+1]=g;
      arr[i*4+2]=b;
      arr[i*4+3]=255;
    }
    return arr;
  }

  applyPalette(type) {
    this.paletteType = type;
    this.palette256 = this.makePalette(type);
    if (!this.device) return;
    this.device.queue.writeTexture(
      {texture:this.paletteTex},
      this.palette256,
      {bytesPerRow:256*4},
      {width:256,height:1}
    );
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
    if (!this.device) return;
    clearTimeout(this.wheelHistoryTimer);
    this.wheelHistoryTimer = null;
    this.pendingWheelSnapshot = null;
    this.pendingIterSnapshot = null;
    this.pendingZoomSnapshot = null;
    this.viewHistory = [];
    this.viewFuture = [];
    this.updateHistoryButtons();
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
    this.flushPendingWheelHistory();
    if (this.viewHistory.length === 0) return;
    const current = this.snapshotView();
    const prev = this.viewHistory.pop();
    this.viewFuture.push(current);
    this.applySnapshot(prev);
    this.updateHistoryButtons();
  };

  onForward = () => {
    this.flushPendingWheelHistory();
    if (this.viewFuture.length === 0) return;
    const current = this.snapshotView();
    const next = this.viewFuture.pop();
    this.viewHistory.push(current);
    this.applySnapshot(next);
    this.updateHistoryButtons();
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
    const rect = this.canvas.getBoundingClientRect();
    const mouse = new DOMPointReadOnly((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
    const delta = domPoint.sub(mouse, this.dragStart);
    const aspect = this.canvas.width / this.canvas.height;

    this.center = view.pan(this.startCenter, delta, this.scale, aspect);
    this.pivot = this.center;
    this.pivotScreen = new DOMPointReadOnly(0.5, 0.5);
    this.scheduleRender();
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

    if (this.hasDragged && this.dragStartSnapshot) {
      this.pushHistory(this.dragStartSnapshot);
      this.dragStartSnapshot = null;
    }
  };

  onPointerLeave = () => {
    this.isDragging = false;
    if (this.isSelecting) {
      this.isSelecting = false;
      this.selectionBox.style.display = "none";
    }
  };

  // WHEEL → zoom centered on the pivot
  onWheel = (e) => {
    e.preventDefault();
    if (!this.pendingWheelSnapshot) {
      this.pendingWheelSnapshot = this.snapshotView();
      this.updateHistoryButtons();
    }
    clearTimeout(this.wheelHistoryTimer);
    this.wheelHistoryTimer = setTimeout(() => this.flushPendingWheelHistory(), MandelbrotApp.WHEEL_HISTORY_MS);
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
    if (this.deviceLost) return;
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
      0, 0 // padding to 64 B (16 floats), see uniformBuffer comment in init()
    ]);

    this.device.queue.writeBuffer(this.uniformBuffer,0,data);

    const encoder=this.device.createCommandEncoder();
    const pass=encoder.beginRenderPass({
      colorAttachments:[{
        view:this.context.getCurrentTexture().createView(),
        loadOp:"clear",
        storeOp:"store",
        clearValue:{r:0,g:0,b:0,a:1}
      }]
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0,this.bindGroup);
    pass.draw(3);
    pass.end();

    this.device.queue.submit([encoder.finish()]);
  };
}

const app = new MandelbrotApp(document.getElementById("gfx"));
window.app = app; // exposed for e2e test assertions on internal state (tests/)
try {
  await app.init();
} catch (e) {
  app.showError(`Failed to initialize WebGPU: ${e.message}`);
}
