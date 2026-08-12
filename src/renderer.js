// Requests a WebGPU adapter/device, once per app. A single device can
// configure any number of independent canvases (see attachCanvas), so this
// is called once even when the app later drives two canvases (Mandelbrot +
// Julia panels).
//
// `onDeviceLost`/`onUncapturedError` are wired up immediately after device
// creation, before anything else that could throw, so they're live even if
// a later setup step (e.g. shader compilation) fails.
// Returns null if no adapter is available.
export async function requestGPUDevice({ onDeviceLost, onUncapturedError }) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();

  device.lost.then((info) => {
    if (info.reason === "destroyed") return; // torn down intentionally
    onDeviceLost(info);
  });
  device.addEventListener("uncapturederror", (event) => {
    onUncapturedError(event.error.message);
  });

  return device;
}

// Worst-case pixel-iteration budget per submitted render pass. A single
// full-canvas draw at high maxIter (observed: ~6.9G iterations, >2s) can
// exceed the GPU driver's TDR watchdog and lose the device. Splitting the
// frame into horizontal scissored bands, each under this budget, keeps every
// individual submit short — on the hardware that produced the DEVICE_HUNG,
// throughput was ≤~3G iterations/s, so 1e8 targets ~30-50ms per submit,
// well under the watchdog. The worst case (972px height, maxIter 8192)
// produces ~75 submits per frame.
export const BAND_WORK_BUDGET = 1e8;

// Splits [0, height) into horizontal bands, each with worst-case pixel-
// iteration cost (width * band.height * maxIter) at or under `budget`.
// Returns [{ y, height }, ...] covering the canvas exactly, no gaps/overlap.
// A single row can never exceed the budget in practice (max canvas width
// 7680 * maxIter cap 8192 ≈ 63M, see ITER.max in mandelbrot.js), so rows is
// always clamped to at least 1.
export function frameBands(width, height, maxIter, budget = BAND_WORK_BUDGET) {
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 1;
  if (!Number.isFinite(width) || !Number.isFinite(maxIter) || width <= 0 || maxIter <= 0) {
    return [{ y: 0, height: safeHeight }];
  }
  const rows = Math.min(safeHeight, Math.max(1, Math.floor(budget / (width * maxIter))));
  const bands = [];
  for (let y = 0; y < safeHeight; y += rows) {
    bands.push({ y, height: Math.min(rows, safeHeight - y) });
  }
  return bands;
}

// Sets up the pipeline/uniforms for one canvas's fractal render pass and
// returns a small `{ render, writePalette }` handle. Throws on setup
// failure (missing WebGPU canvas context, WGSL fetch/compile errors), for
// the caller to catch and report.
export async function attachCanvas(device, canvas, palette256) {
  const context = canvas.getContext("webgpu");
  if (!context) {
    throw new Error("Unable to create the WebGPU canvas context.");
  }
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format });

  const paletteTex = device.createTexture({
    size: [256, 2],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  });
  const writePalette = (data) => {
    device.queue.writeTexture(
      { texture: paletteTex },
      data,
      { bytesPerRow: 256 * 4 },
      { width: 256, height: 2 }
    );
  };
  writePalette(palette256);
  // "nearest", not "linear": with few iterations (coarse maxIter), the
  // escape-time t can land exactly on a palette LUT texel boundary. Linear
  // filtering would blend the two neighboring texels there - invisible for
  // smooth gradients (256 steps is already fine-grained), but it would put a
  // visible gray ring into any future hard-edged (banded) palette.
  const paletteSampler = device.createSampler({
    magFilter: "nearest", minFilter: "nearest"
  });

  // WGSL (f32 + double-single center/julia)
  const shaderResponse = await fetch("src/mandelbrot.wgsl", { cache: "no-cache" });
  if (!shaderResponse.ok) {
    throw new Error(`WGSL fetch failed: ${shaderResponse.status}`);
  }
  const shaderCode = await shaderResponse.text();
  const module = device.createShaderModule({ code: shaderCode });

  const compilationInfo = await module.getCompilationInfo();
  const shaderErrors = compilationInfo.messages.filter((message) => message.type === "error");
  if (shaderErrors.length > 0) {
    throw new Error(
      shaderErrors.map((error) => `${error.lineNum}:${error.linePos} ${error.message}`).join("\n")
    );
  }

  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs_main" },
    fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" }
  });

  // Uniform buffer: 15 logical f32 fields + 1 padding float, since WGSL
  // rounds a uniform struct's size up to a 16-byte multiple (64 B here).
  const uniformBuffer = device.createBuffer({
    size: 16 * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: paletteSampler },
      { binding: 2, resource: paletteTex.createView() }
    ]
  });

  // Splits the frame into scissored horizontal bands (see frameBands), each
  // submitted as its own command buffer, so no single submit is long enough
  // to trip the GPU driver's TDR watchdog at high maxIter. The fragment
  // shader derives its per-pixel fractal coordinate purely from NDC
  // position + canvas width/height (mandelbrot.wgsl), which scissoring
  // doesn't change — so bands are pixel-identical to an unbanded render,
  // just split across more, shorter submits. Returns the band count.
  const render = (uniformData, maxIter) => {
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const view = context.getCurrentTexture().createView();
    const bands = frameBands(canvas.width, canvas.height, maxIter);

    bands.forEach((band, i) => {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view,
          // Only the first band clears the attachment; loadOp applies to
          // the whole attachment (not scissored), so a "clear" on later
          // bands would wipe out the bands already drawn.
          loadOp: i === 0 ? "clear" : "load",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 }
        }]
      });

      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.setScissorRect(0, band.y, canvas.width, band.height);
      pass.draw(3);
      pass.end();

      device.queue.submit([encoder.finish()]);
    });

    return bands.length;
  };

  return { render, writePalette };
}
