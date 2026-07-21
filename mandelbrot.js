const canvas = document.getElementById("gfx");
canvas.width = innerWidth;
canvas.height = innerHeight;

const adapter = await navigator.gpu.requestAdapter();
const device  = await adapter.requestDevice();
const context = canvas.getContext("webgpu");
const format  = navigator.gpu.getPreferredCanvasFormat();
context.configure({ device, format });

// State (JS = f64)
let centerX = -0.5;
let centerY = 0.0;
let scale   = 3.0;
let maxIter = 300;
let juliaMode = 0;
let juliaCx = -0.8;
let juliaCy = 0.156;
let paletteType = 0;

// pivot for centered zoom
let pivotX = -0.5;
let pivotY = 0.0;
let pivotScreenX = 0.5;
let pivotScreenY = 0.5;

// pan
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let startCenterX = 0;
let startCenterY = 0;

// UI
const iterSlider = document.getElementById("iterSlider");
const iterLabel  = document.getElementById("iterLabel");
const zoomSlider = document.getElementById("zoomSlider");
const zoomLabel  = document.getElementById("zoomLabel");
const paletteSel = document.getElementById("paletteType");
const juliaChk   = document.getElementById("juliaMode");

iterSlider.oninput = () => {
  maxIter = Number(iterSlider.value);
  iterLabel.textContent = maxIter;
};
zoomSlider.oninput = () => {
  scale = Number(zoomSlider.value);
  zoomLabel.textContent = scale;
};
paletteSel.onchange = () => paletteType = Number(paletteSel.value);
juliaChk.onchange   = () => juliaMode = juliaChk.checked ? 1 : 0;

// 256-entry palette
function makePalette(type) {
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

let palette256 = makePalette(0);

const paletteTex = device.createTexture({
  size:[256,1],
  format:"rgba8unorm",
  usage:GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
});
device.queue.writeTexture(
  {texture:paletteTex},
  palette256,
  {bytesPerRow:256*4},
  {width:256,height:1}
);
const paletteSampler = device.createSampler({
  magFilter:"linear", minFilter:"linear"
});

// Double-double split (f64 -> hi+lo f32)
function split64(x) {
  const hi = Math.fround(x);
  const lo = x - hi;
  return [hi, lo];
}

// WGSL (f32 + double-double center/julia)
const shaderCode = await fetch("mandelbrot.wgsl").then(r => r.text());

const module = device.createShaderModule({code:shaderCode});

const pipeline = device.createRenderPipeline({
  layout:"auto",
  vertex:{module,entryPoint:"vs_main"},
  fragment:{module,entryPoint:"fs_main",targets:[{format}]},
  primitive:{topology:"triangle-list"}
});

// Uniform buffer (13 f32)
const uniformBuffer = device.createBuffer({
  size: 13 * 4,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
});

const bindGroup = device.createBindGroup({
  layout:pipeline.getBindGroupLayout(0),
  entries:[
    {binding:0,resource:{buffer:uniformBuffer}},
    {binding:1,resource:paletteSampler},
    {binding:2,resource:paletteTex.createView()}
  ]
});

// CLICK → pivot (Y corrected: NDC vs canvas)
canvas.addEventListener("click", e => {
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / canvas.width;
    const my = (e.clientY - rect.top)  / canvas.height;

    const aspect = canvas.width / canvas.height;

    pivotScreenX = mx;
    pivotScreenY = my;

    pivotX = (mx - 0.5) * scale * aspect + centerX;
    pivotY = (0.5 - my) * scale + centerY;

    if (juliaMode === 1) {
        juliaCx = pivotX;
        juliaCy = pivotY;
    }
});

// PAN: mousedown / mousemove / mouseup
canvas.addEventListener("mousedown", e => {
    isDragging = true;
    const rect = canvas.getBoundingClientRect();
    dragStartX = (e.clientX - rect.left) / canvas.width;
    dragStartY = (e.clientY - rect.top)  / canvas.height;
    startCenterX = centerX;
    startCenterY = centerY;
});

canvas.addEventListener("mousemove", e => {
    if (!isDragging) return;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / canvas.width;
    const my = (e.clientY - rect.top)  / canvas.height;

    const dx = mx - dragStartX;
    const dy = my - dragStartY;
    const aspect = canvas.width / canvas.height;

    centerX = startCenterX - dx * scale * aspect;
    centerY = startCenterY + dy * scale;
});

canvas.addEventListener("mouseup", () => { isDragging = false; });
canvas.addEventListener("mouseleave", () => { isDragging = false; });

// WHEEL → zoom centered on the pivot
canvas.addEventListener("wheel", e => {
    const aspect = canvas.width / canvas.height;
    const zoomFactor = (e.deltaY > 0 ? 1.1 : 0.9);

    scale *= zoomFactor;

    centerX = pivotX - (pivotScreenX - 0.5) * scale * aspect;
    centerY = pivotY - (0.5 - pivotScreenY) * scale;

    zoomSlider.value = scale;
    zoomLabel.textContent = scale;
});

// RENDER
function render(){
  const [cx_hi, cx_lo] = split64(centerX);
  const [cy_hi, cy_lo] = split64(centerY);
  const [jx_hi, jx_lo] = split64(juliaCx);
  const [jy_hi, jy_lo] = split64(juliaCy);

  const data = new Float32Array([
    scale,
    cx_hi, cx_lo,
    cy_hi, cy_lo,
    jx_hi, jx_lo,
    jy_hi, jy_lo,
    maxIter,
    canvas.width,
    canvas.height,
    juliaMode
  ]);

  device.queue.writeBuffer(uniformBuffer,0,data);

  const encoder=device.createCommandEncoder();
  const pass=encoder.beginRenderPass({
    colorAttachments:[{
      view:context.getCurrentTexture().createView(),
      loadOp:"clear",
      storeOp:"store",
      clearValue:{r:0,g:0,b:0,a:1}
    }]
  });

  pass.setPipeline(pipeline);
  pass.setBindGroup(0,bindGroup);
  pass.draw(3);
  pass.end();

  device.queue.submit([encoder.finish()]);
  requestAnimationFrame(render);
}
render();

// Palette change
paletteSel.onchange = () => {
  palette256 = makePalette(Number(paletteSel.value));
  device.queue.writeTexture(
    {texture:paletteTex},
    palette256,
    {bytesPerRow:256*4},
    {width:256,height:1}
  );
};
