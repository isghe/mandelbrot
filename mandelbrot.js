class MandelbrotApp {
  static MIN_SCALE = 1e-14;
  static MAX_SCALE = 4.0;

  // State (JS = f64)
  centerX = -0.5;
  centerY = 0.0;
  scale   = 3.0;
  maxIter = 300;
  juliaMode = 0;
  juliaCx = -0.8;
  juliaCy = 0.156;
  paletteType = 4;

  // progressive mode (reveals the fractal iteration by iteration)
  progressiveMode = 0;
  progressiveIter = 1;

  // pivot for centered zoom
  pivotX = -0.5;
  pivotY = 0.0;
  pivotScreenX = 0.5;
  pivotScreenY = 0.5;

  // pan
  isDragging = false;
  hasDragged = false;
  dragStartX = 0;
  dragStartY = 0;
  startCenterX = 0;
  startCenterY = 0;

  // selection area (Ctrl + drag)
  isSelecting = false;
  selectStartX = 0;
  selectStartY = 0;

  // render scheduling
  rafPending = false;

  constructor(canvas) {
    this.initialState = {
      centerX: this.centerX,
      centerY: this.centerY,
      scale: this.scale,
      maxIter: this.maxIter,
      juliaMode: this.juliaMode,
      juliaCx: this.juliaCx,
      juliaCy: this.juliaCy,
      paletteType: this.paletteType,
      progressiveMode: this.progressiveMode,
    };

    this.canvas = canvas;
    this.canvas.width = innerWidth;
    this.canvas.height = innerHeight;

    this.selectionBox = document.getElementById("selectionBox");
    this.errorBox = document.getElementById("gpuError");

    // UI
    this.iterSlider = document.getElementById("iterSlider");
    this.iterLabel  = document.getElementById("iterLabel");
    this.zoomSlider = document.getElementById("zoomSlider");
    this.zoomLabel  = document.getElementById("zoomLabel");
    this.paletteSel = document.getElementById("paletteType");
    this.juliaChk   = document.getElementById("juliaMode");
    this.progressiveChk = document.getElementById("progressiveMode");
    this.resetBtn   = document.getElementById("resetBtn");

    this.iterSlider.oninput = this.onIterInput;
    this.zoomSlider.oninput = this.onZoomInput;
    this.paletteSel.onchange = this.onPaletteChange;
    this.juliaChk.onchange   = this.onJuliaChange;
    this.progressiveChk.onchange = this.onProgressiveChange;
    this.resetBtn.onclick   = this.onReset;

    this.canvas.addEventListener("mousedown", this.onMouseDown);
    this.canvas.addEventListener("mousemove", this.onMouseMove);
    this.canvas.addEventListener("mouseup", this.onMouseUp);
    this.canvas.addEventListener("mouseleave", this.onMouseLeave);
    this.canvas.addEventListener("wheel", this.onWheel);
    window.addEventListener("resize", this.onResize);

    this.palette256 = this.makePalette(this.paletteType);
  }

  setScale(next) {
    this.scale = Math.min(MandelbrotApp.MAX_SCALE, Math.max(MandelbrotApp.MIN_SCALE, next));
    this.zoomSlider.value = this.scale;
    this.zoomLabel.textContent = this.scale;
  }

  onResize = () => {
    this.canvas.width = innerWidth;
    this.canvas.height = innerHeight;
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
    this.errorBox.textContent = msg;
    this.errorBox.style.display = "block";
  }

  async init() {
    if (!navigator.gpu) {
      this.showError("WebGPU is not supported in this browser.");
      return;
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      this.showError("No WebGPU adapter available.");
      return;
    }
    this.device  = await adapter.requestDevice();
    this.context = this.canvas.getContext("webgpu");
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
    const shaderResponse = await fetch("mandelbrot.wgsl");
    if (!shaderResponse.ok) {
      throw new Error(`WGSL fetch failed: ${shaderResponse.status}`);
    }
    const shaderCode = await shaderResponse.text();
    const module = this.device.createShaderModule({code:shaderCode});

    this.pipeline = this.device.createRenderPipeline({
      layout:"auto",
      vertex:{module,entryPoint:"vs_main"},
      fragment:{module,entryPoint:"fs_main",targets:[{format:this.format}]},
      primitive:{topology:"triangle-list"}
    });

    // Uniform buffer: 13 logical f32 fields + 3 padding floats, since WGSL
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
    this.maxIter = Number(this.iterSlider.value);
    this.iterLabel.textContent = this.maxIter;
    this.resetProgressive();
    this.scheduleRender();
  };

  onZoomInput = () => {
    this.setScale(Number(this.zoomSlider.value));
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

  onReset = () => {
    if (!this.device) return;
    const s = this.initialState;
    this.centerX = s.centerX;
    this.centerY = s.centerY;
    this.pivotX = s.centerX;
    this.pivotY = s.centerY;
    this.pivotScreenX = 0.5;
    this.pivotScreenY = 0.5;
    this.setScale(s.scale);
    this.maxIter = s.maxIter;
    this.juliaMode = s.juliaMode;
    this.juliaCx = s.juliaCx;
    this.juliaCy = s.juliaCy;
    this.progressiveMode = s.progressiveMode;

    this.iterSlider.value = this.maxIter;
    this.iterLabel.textContent = this.maxIter;
    this.juliaChk.checked = !!this.juliaMode;
    this.progressiveChk.checked = !!this.progressiveMode;

    this.applyPalette(s.paletteType);
    this.paletteSel.value = this.paletteType;

    this.resetProgressive();
    this.scheduleRender();
  };

  // PAN: mousedown / mousemove / mouseup
  onMouseDown = (e) => {
    if (e.ctrlKey) {
      this.isSelecting = true;
      this.selectStartX = e.clientX;
      this.selectStartY = e.clientY;
      this.selectionBox.style.left = this.selectStartX + "px";
      this.selectionBox.style.top = this.selectStartY + "px";
      this.selectionBox.style.width = "0px";
      this.selectionBox.style.height = "0px";
      this.selectionBox.style.display = "block";
      return;
    }
    this.isDragging = true;
    this.hasDragged = false;
    const rect = this.canvas.getBoundingClientRect();
    this.dragStartX = (e.clientX - rect.left) / this.canvas.width;
    this.dragStartY = (e.clientY - rect.top)  / this.canvas.height;
    this.startCenterX = this.centerX;
    this.startCenterY = this.centerY;
  };

  onMouseMove = (e) => {
    if (this.isSelecting) {
      const x = Math.min(e.clientX, this.selectStartX);
      const y = Math.min(e.clientY, this.selectStartY);
      this.selectionBox.style.left = x + "px";
      this.selectionBox.style.top = y + "px";
      this.selectionBox.style.width = Math.abs(e.clientX - this.selectStartX) + "px";
      this.selectionBox.style.height = Math.abs(e.clientY - this.selectStartY) + "px";
      return;
    }
    if (!this.isDragging) return;
    this.hasDragged = true;
    const rect = this.canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / this.canvas.width;
    const my = (e.clientY - rect.top)  / this.canvas.height;

    const dx = mx - this.dragStartX;
    const dy = my - this.dragStartY;
    const aspect = this.canvas.width / this.canvas.height;

    this.centerX = this.startCenterX - dx * this.scale * aspect;
    this.centerY = this.startCenterY + dy * this.scale;
    this.scheduleRender();
  };

  onMouseUp = (e) => {
    if (this.isSelecting) {
      this.isSelecting = false;
      this.selectionBox.style.display = "none";

      const rect = this.canvas.getBoundingClientRect();
      const x1 = Math.min(e.clientX, this.selectStartX) - rect.left;
      const y1 = Math.min(e.clientY, this.selectStartY) - rect.top;
      const x2 = Math.max(e.clientX, this.selectStartX) - rect.left;
      const y2 = Math.max(e.clientY, this.selectStartY) - rect.top;

      // ignore selections that are too small (e.g. Ctrl+click without dragging)
      if (x2 - x1 < 3 || y2 - y1 < 3) return;

      const aspect = this.canvas.width / this.canvas.height;

      const fx1 = ((x1 / this.canvas.width)  - 0.5) * this.scale * aspect + this.centerX;
      const fx2 = ((x2 / this.canvas.width)  - 0.5) * this.scale * aspect + this.centerX;
      const fy1 = (0.5 - (y1 / this.canvas.height)) * this.scale + this.centerY;
      const fy2 = (0.5 - (y2 / this.canvas.height)) * this.scale + this.centerY;

      this.centerX = (fx1 + fx2) / 2;
      this.centerY = (fy1 + fy2) / 2;

      const selWidth  = Math.abs(fx2 - fx1);
      const selHeight = Math.abs(fy1 - fy2);
      this.setScale(Math.max(selHeight, selWidth / aspect));

      this.pivotX = this.centerX;
      this.pivotY = this.centerY;
      this.pivotScreenX = 0.5;
      this.pivotScreenY = 0.5;

      this.resetProgressive();
      this.scheduleRender();
      return;
    }

    this.isDragging = false;

    // Genuine CLICK (no dragging) → pivot (Y corrected: NDC vs canvas)
    if (!this.hasDragged) {
      const rect = this.canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / this.canvas.width;
      const my = (e.clientY - rect.top)  / this.canvas.height;

      const aspect = this.canvas.width / this.canvas.height;

      this.pivotScreenX = mx;
      this.pivotScreenY = my;

      this.pivotX = (mx - 0.5) * this.scale * aspect + this.centerX;
      this.pivotY = (0.5 - my) * this.scale + this.centerY;

      if (this.juliaMode === 1) {
        this.juliaCx = this.pivotX;
        this.juliaCy = this.pivotY;
        this.resetProgressive();
      }
      this.scheduleRender();
    }
  };

  onMouseLeave = () => {
    this.isDragging = false;
    if (this.isSelecting) {
      this.isSelecting = false;
      this.selectionBox.style.display = "none";
    }
  };

  // WHEEL → zoom centered on the pivot
  onWheel = (e) => {
    const aspect = this.canvas.width / this.canvas.height;
    const zoomFactor = (e.deltaY > 0 ? 1.1 : 0.9);

    this.setScale(this.scale * zoomFactor);

    this.centerX = this.pivotX - (this.pivotScreenX - 0.5) * this.scale * aspect;
    this.centerY = this.pivotY - (0.5 - this.pivotScreenY) * this.scale;

    this.resetProgressive();
    this.scheduleRender();
  };

  // RENDER
  renderOnce = () => {
    const [cx_hi, cx_lo] = MandelbrotApp.split64(this.centerX);
    const [cy_hi, cy_lo] = MandelbrotApp.split64(this.centerY);
    const [jx_hi, jx_lo] = MandelbrotApp.split64(this.juliaCx);
    const [jy_hi, jy_lo] = MandelbrotApp.split64(this.juliaCy);

    let displayIter = this.maxIter;
    if (this.progressiveMode && !this.isDragging) {
      displayIter = Math.min(this.progressiveIter, this.maxIter);
      if (this.progressiveIter < this.maxIter) this.progressiveIter++;
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
      0, 0, 0 // padding to 64 B (16 floats), see uniformBuffer comment in init()
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
