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
// produces ~81 submits per frame.
export const BAND_WORK_BUDGET = 1e8;

// How many bands the whole app submits per animation frame, across every
// visible panel (see shareBands). Bands are near-equal cost by construction —
// frameBands sizes each one to ~BAND_WORK_BUDGET pixel-iterations whatever the
// maxIter — so counting bands is a fair proxy for counting work, including
// between two panels at different maxIter.
//
// The value is a compromise a fixed constant can't win: it has to be high
// enough that an ordinary frame still lands in one go (a 1280x720 canvas at
// the default maxIter 256 is 3 bands, a half-width panel in split view 2), and
// low enough that an expensive frame doesn't hand the GPU hundreds of
// milliseconds of work at once — which is the freeze this whole mechanism
// exists to remove. Where that line falls depends entirely on the hardware:
// one band is ~30-50ms on the GPU that prompted this, single-digit ms on a
// fast one. Replaced by a budget measured from actual frame times in the
// commit that follows this one.
export const FRAME_BAND_BUDGET = 4;

// Splits a frame's band budget across panels that still have bands pending,
// one band at a time in round-robin order, so no panel is starved by another
// one's longer queue. `pending` is each panel's remaining band count; the
// result is the same length, sums to at most `budget`, and never gives a
// panel more than it asked for. Non-finite or negative entries count as 0.
//
// The deal always starts from panel 0 and isn't rotated between frames, so a
// budget smaller than the number of panels with work would serve the first
// one over and over until its frame completed, and only then the next — the
// monopoly this is meant to break, just at a frame's granularity. The budget
// above stays clear of that; making it variable means either keeping it at or
// above the panel count, or rotating the starting index here.
export function shareBands(pending, budget) {
  const wanted = pending.map((n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0));
  const share = wanted.map(() => 0);
  let left = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0;
  let served = true;
  while (left > 0 && served) {
    served = false;
    for (let i = 0; i < wanted.length && left > 0; i++) {
      if (share[i] >= wanted[i]) continue;
      share[i]++;
      left--;
      served = true;
    }
  }
  return share;
}

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

  // Copies the offscreen target onto the canvas (see fs_blit in the WGSL).
  // Shares vs_main with the fractal pipeline, so no second vertex stage; its
  // "auto" layout resolves to just fs_blit's own binding 3, independent of
  // the fractal pipeline's uniform/palette bindings above.
  const blitPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs_main" },
    fragment: { module, entryPoint: "fs_blit", targets: [{ format }] },
    primitive: { topology: "triangle-list" }
  });

  // The frame's bands are rendered into this texture rather than straight
  // into the swap-chain texture, then blitted onto the canvas in one draw.
  // A WebGPU canvas texture doesn't carry its contents over from the previous
  // frame, so it can't accumulate anything across animation frames; a texture
  // we own can, which is what lets a frame's bands later be spread over
  // several frames instead of all being submitted in one.
  let offscreen = null;
  let offscreenView = null;
  let blitBindGroup = null;
  // Tracked here rather than read back off `offscreen` so the size check
  // doesn't depend on GPUTexture's width/height attributes.
  let offscreenWidth = 0;
  let offscreenHeight = 0;

  // (Re)creates the offscreen target whenever the canvas backing store has
  // changed size. A freshly created WebGPU texture is zero-initialized by
  // spec, so the new target starts as transparent black and needs no explicit
  // clear pass — and the canvas is configured with the default "opaque" alpha
  // mode, so any not-yet-drawn region reads as plain black on screen.
  const ensureOffscreen = () => {
    if (offscreen && offscreenWidth === canvas.width && offscreenHeight === canvas.height) return;
    // Already-submitted work referencing the old texture stays valid; destroy
    // only bars further use of it, which the reassignment below ends anyway.
    offscreen?.destroy();
    offscreenWidth = canvas.width;
    offscreenHeight = canvas.height;
    offscreen = device.createTexture({
      size: [offscreenWidth, offscreenHeight],
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    offscreenView = offscreen.createView();
    blitBindGroup = device.createBindGroup({
      layout: blitPipeline.getBindGroupLayout(0),
      entries: [{ binding: 3, resource: offscreenView }]
    });
  };

  // Puts the offscreen target on screen. getCurrentTexture() is called here
  // and nowhere else, so the canvas texture is always acquired and used
  // within the same task, as WebGPU requires. loadOp "clear" is nominal —
  // the blit triangle covers every pixel of the attachment.
  const present = () => {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 }
      }]
    });
    pass.setPipeline(blitPipeline);
    pass.setBindGroup(0, blitBindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  };

  // The current frame's bands and how many of them have been submitted. This
  // outlives the animation frame that started it: submitting a band is cheap
  // on the CPU but can be tens of milliseconds of GPU work, so an expensive
  // frame's bands are handed over a few per animation frame (see
  // advanceFrame) instead of all at once — which is what left the UI frozen
  // for as long as the whole frame took.
  let job = null;

  // Starts a frame, dropping any bands of the previous one still unsubmitted.
  // Whatever is already on the offscreen target stays there and the new
  // frame's bands overwrite it from the top down, so a panel interrupted
  // mid-frame keeps showing the newest view at the top over progressively
  // older content below, rather than going blank. Returns how many bands this
  // frame was split into.
  const beginFrame = (uniformData, maxIter) => {
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);
    ensureOffscreen();
    // Banded off the offscreen target's own size, not the live canvas's: the
    // canvas can be resized while a frame is still draining, and every band
    // still queued has to stay inside the attachment it was computed for.
    // ensureOffscreen above has just reconciled the two for a new frame.
    job = { bands: frameBands(offscreenWidth, offscreenHeight, maxIter), next: 0 };
    return job.bands.length;
  };

  // Submits up to `maxBands` of the current frame's remaining bands, each as
  // its own command buffer, so no single submit is long enough to trip the
  // GPU driver's TDR watchdog at high maxIter. The fragment shader derives
  // its per-pixel fractal coordinate purely from NDC position + canvas
  // width/height (mandelbrot.wgsl), which scissoring doesn't change — so
  // bands are pixel-identical to an unbanded render, just split across more,
  // shorter submits. Returns how many bands were actually submitted.
  //
  // Every band loads rather than clears: the offscreen target keeps whatever
  // the previous frame left there, and a band overwrites only its own rows.
  // The old "clear on band 0" is gone with the swap-chain target it existed
  // for — loadOp applies to the whole attachment, not to the scissor rect, so
  // it was the only way to start from a blank frame back when each frame had
  // to fully repaint a fresh canvas texture. Keeping the previous image
  // underneath is what lets a partially rendered frame still be shown.
  const advanceFrame = (maxBands) => {
    if (!job) return 0;
    const wanted = Number.isFinite(maxBands) ? Math.max(0, Math.floor(maxBands)) : 0;
    const upTo = Math.min(job.bands.length, job.next + wanted);
    const from = job.next;

    for (; job.next < upTo; job.next++) {
      const band = job.bands[job.next];
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: offscreenView,
          loadOp: "load",
          storeOp: "store"
        }]
      });

      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.setScissorRect(0, band.y, offscreenWidth, band.height);
      pass.draw(3);
      pass.end();

      device.queue.submit([encoder.finish()]);
    }

    return job.next - from;
  };

  return {
    beginFrame,
    advanceFrame,
    present,
    writePalette,
    // Bands of the current frame not yet submitted; 0 once it has fully
    // landed, which is also how the caller knows the frame is complete.
    get pendingBands() { return job ? job.bands.length - job.next : 0; },
  };
}
