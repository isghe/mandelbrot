class MandelbrotApp {
  static MIN_SCALE = 1e-14;
  static MAX_SCALE = 4.0;
  static MIN_ITER = 1;
  static MAX_ITER = 8192;

  // State (JS = f64)
  center = new DOMPointReadOnly(-0.5, 0.0);
  scale   = 3.0;
  maxIter = 256;
  juliaMode = 0;
  juliaC = new DOMPointReadOnly(-0.8, 0.156);
  paletteType = 4;
  smoothColoring = 0;

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

    this.canvas = canvas;
    this.resizeCanvas();

    this.selectionBox = document.getElementById("selectionBox");
    this.errorBox = document.getElementById("gpuError");
    this.errorMessage = document.getElementById("gpuErrorMessage");
    this.reloadBtn = document.getElementById("gpuReloadBtn");
    this.reloadBtn.onclick = () => location.reload();

    // UI
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
    this.resetBtn   = document.getElementById("resetBtn");

    this.iterSlider.oninput = this.onIterInput;
    this.zoomSlider.oninput = this.onZoomInput;
    this.paletteSel.onchange = this.onPaletteChange;
    this.juliaChk.onchange   = this.onJuliaChange;
    this.progressiveChk.onchange = this.onProgressiveChange;
    this.smoothColoringChk.onchange = this.onSmoothColoringChange;
    this.resetBtn.onclick   = this.onReset;

    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("resize", this.onResize);

    this.setScale(this.scale);
    this.setMaxIter(this.maxIter);
    this.palette256 = this.makePalette(this.paletteType);
  }

  setScale(next) {
    this.scale = Math.min(MandelbrotApp.MAX_SCALE, Math.max(MandelbrotApp.MIN_SCALE, next));
    this.zoomSlider.value = Math.log10(this.scale);
    this.zoomLabel.textContent = this.scale;
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

  onResize = () => {
    this.resizeCanvas();
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
      this.renderOnce();
      if (this.progressiveMode && this.progressiveIter < this.maxIter && !this.isDragging) {
        this.scheduleRender();
      }
    });
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

  // Double-single split (f64 -> hi+lo f32)
  static split64(x) {
    const hi = Math.fround(x);
    const lo = x - hi;
    return [hi, lo];
  }

  onIterInput = () => {
    this.setMaxIter(10 ** Number(this.iterSlider.value));
    this.resetProgressive();
    this.scheduleRender();
  };

  onZoomInput = () => {
    this.setScale(10 ** Number(this.zoomSlider.value));
    this.scheduleRender();
  };

  onPaletteChange = () => {
    this.applyPalette(Number(this.paletteSel.value));
    this.scheduleRender();
  };

  onJuliaChange = () => {
    this.juliaMode = this.juliaChk.checked ? 1 : 0;
    this.resetProgressive();
    this.scheduleRender();
  };

  onProgressiveChange = () => {
    this.progressiveMode = this.progressiveChk.checked ? 1 : 0;
    this.resetProgressive();
    this.scheduleRender();
  };

  onSmoothColoringChange = () => {
    this.smoothColoring = this.smoothColoringChk.checked ? 1 : 0;
    this.scheduleRender();
  };

  onReset = () => {
    if (!this.device) return;
    const s = this.initialState;
    this.center = s.center;
    this.pivot = s.center;
    this.pivotScreen = new DOMPointReadOnly(0.5, 0.5);
    this.setScale(s.scale);
    this.setMaxIter(s.maxIter);
    this.juliaMode = s.juliaMode;
    this.juliaC = s.juliaC;
    this.progressiveMode = s.progressiveMode;
    this.smoothColoring = s.smoothColoring;

    this.juliaChk.checked = !!this.juliaMode;
    this.progressiveChk.checked = !!this.progressiveMode;
    this.smoothColoringChk.checked = !!this.smoothColoring;

    this.applyPalette(s.paletteType);
    this.paletteSel.value = this.paletteType;

    this.resetProgressive();
    this.scheduleRender();
  };

  // PAN: pointerdown / pointermove / pointerup
  onPointerDown = (e) => {
    this.canvas.setPointerCapture(e.pointerId);
    if (e.ctrlKey) {
      this.isSelecting = true;
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
    const rect = this.canvas.getBoundingClientRect();
    this.dragStart = new DOMPointReadOnly((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
    this.startCenter = this.center;
  };

  onPointerMove = (e) => {
    if (this.isSelecting) {
      const x = Math.min(e.clientX, this.selectStart.x);
      const y = Math.min(e.clientY, this.selectStart.y);
      this.selectionBox.style.left = x + "px";
      this.selectionBox.style.top = y + "px";
      this.selectionBox.style.width = Math.abs(e.clientX - this.selectStart.x) + "px";
      this.selectionBox.style.height = Math.abs(e.clientY - this.selectStart.y) + "px";
      return;
    }
    if (!this.isDragging) return;
    this.hasDragged = true;
    const rect = this.canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width;
    const my = (e.clientY - rect.top)  / rect.height;

    const dx = mx - this.dragStart.x;
    const dy = my - this.dragStart.y;
    const aspect = this.canvas.width / this.canvas.height;

    this.center = new DOMPointReadOnly(
      this.startCenter.x - dx * this.scale * aspect,
      this.startCenter.y + dy * this.scale
    );
    this.scheduleRender();
  };

  onPointerUp = (e) => {
    if (this.isSelecting) {
      this.isSelecting = false;
      this.selectionBox.style.display = "none";

      const rect = this.canvas.getBoundingClientRect();
      const x1 = Math.min(e.clientX, this.selectStart.x) - rect.left;
      const y1 = Math.min(e.clientY, this.selectStart.y) - rect.top;
      const x2 = Math.max(e.clientX, this.selectStart.x) - rect.left;
      const y2 = Math.max(e.clientY, this.selectStart.y) - rect.top;

      // ignore selections that are too small (e.g. Ctrl+click without dragging)
      if (x2 - x1 < 3 || y2 - y1 < 3) return;

      const aspect = this.canvas.width / this.canvas.height;

      const fx1 = ((x1 / rect.width)  - 0.5) * this.scale * aspect + this.center.x;
      const fx2 = ((x2 / rect.width)  - 0.5) * this.scale * aspect + this.center.x;
      const fy1 = (0.5 - (y1 / rect.height)) * this.scale + this.center.y;
      const fy2 = (0.5 - (y2 / rect.height)) * this.scale + this.center.y;

      this.center = new DOMPointReadOnly((fx1 + fx2) / 2, (fy1 + fy2) / 2);

      const selWidth  = Math.abs(fx2 - fx1);
      const selHeight = Math.abs(fy1 - fy2);
      this.setScale(Math.max(selHeight, selWidth / aspect));

      this.pivot = this.center;
      this.pivotScreen = new DOMPointReadOnly(0.5, 0.5);

      this.resetProgressive();
      this.scheduleRender();
      return;
    }

    this.isDragging = false;

    // Genuine CLICK (no dragging) → pivot (Y corrected: NDC vs canvas)
    if (!this.hasDragged) {
      const rect = this.canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / rect.width;
      const my = (e.clientY - rect.top)  / rect.height;

      const aspect = this.canvas.width / this.canvas.height;

      this.pivotScreen = new DOMPointReadOnly(mx, my);

      this.pivot = new DOMPointReadOnly(
        (mx - 0.5) * this.scale * aspect + this.center.x,
        (0.5 - my) * this.scale + this.center.y
      );

      if (this.juliaMode === 1) {
        this.juliaC = this.pivot;
        this.resetProgressive();
      }
      this.scheduleRender();
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
    const aspect = this.canvas.width / this.canvas.height;
    const zoomFactor = (e.deltaY > 0 ? 1.1 : 0.9);

    this.setScale(this.scale * zoomFactor);

    this.center = new DOMPointReadOnly(
      this.pivot.x - (this.pivotScreen.x - 0.5) * this.scale * aspect,
      this.pivot.y - (0.5 - this.pivotScreen.y) * this.scale
    );

    this.resetProgressive();
    this.scheduleRender();
  };

  // RENDER
  renderOnce = () => {
    if (this.deviceLost) return;
    const [cx_hi, cx_lo] = MandelbrotApp.split64(this.center.x);
    const [cy_hi, cy_lo] = MandelbrotApp.split64(this.center.y);
    const [jx_hi, jx_lo] = MandelbrotApp.split64(this.juliaC.x);
    const [jy_hi, jy_lo] = MandelbrotApp.split64(this.juliaC.y);

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
try {
  await app.init();
} catch (e) {
  app.showError(`Failed to initialize WebGPU: ${e.message}`);
}
