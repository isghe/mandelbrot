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
// individual submit short — well under the watchdog on the hardware that
// produced the DEVICE_HUNG, whose throughput was ≤~3G iterations/s.
//
// Avoiding the watchdog is no longer what sets this number, though; staying
// interactive is, and it is the tighter of the two constraints. A band is the
// smallest unit of work the frame scheduler can place (see
// FRAME_BAND_BUDGET), so a band that costs more than a frame leaves that
// scheduler nothing to do: nextBandBudget pins at its floor of one band and
// every frame overruns TARGET_FRAME_MS anyway. At 1e8 a band was ~30-50ms on
// that hardware — already over the target on its own, which is why controls
// stayed usable but not smooth during a heavy render.
//
// 2.5e7 puts a band at roughly 8ms there, so two or three fit in a frame and
// the budget controller has room to actually regulate. The worst case grows
// from ~81 submits per frame to ~324, but those are spread across the many
// animation frames the same render already took, only a handful per frame, at
// tens of microseconds of CPU each. Shorter submits also sit further from the
// TDR watchdog, so the original reason for banding is served better, not worse.
export const BAND_WORK_BUDGET = 2.5e7;

// How many bands the whole app submits per animation frame, across every
// visible panel (see shareBands), before any measurement has been taken.
// Bands are near-equal cost by construction — frameBands sizes each one to
// ~BAND_WORK_BUDGET pixel-iterations whatever the maxIter — so counting bands
// is a fair proxy for counting work, including between two panels at
// different maxIter.
//
// Only a starting point: how much work fits in a frame depends entirely on
// the hardware (one band is ~30-50ms on the GPU that prompted this,
// single-digit ms on a fast one), so nextBandBudget takes over from the
// second frame of every burst onward. 4 is where it starts because it covers
// an ordinary frame in one go — a 1280x720 canvas at the default maxIter 256
// is 3 bands, a half-width panel in split view 2 — so a cheap view never
// visibly arrives in pieces even before the first measurement.
export const INITIAL_FRAME_BAND_BUDGET = 4;

// Ceiling on that budget. Growth is otherwise unbounded during a long cheap
// stretch, and since backing off is by halving, a budget that had drifted
// into the hundreds would take many frames to come back down when a frame
// finally turned expensive — the backlog arriving exactly when responsiveness
// matters most. At 64 the walk back down to a single band is six frames.
export const MAX_FRAME_BAND_BUDGET = 64;

// Wall-clock time one animation frame should aim for, in ms. Deliberately
// above the 16.7ms of a 60Hz vsync: even a frame with nothing to do takes a
// whole vsync interval, so a target at or below one would read every frame as
// over budget and pin the budget at its floor forever. Deliberately below two
// intervals (33.3ms), so a frame that overruns into the next vsync is still
// recognised as too much work.
export const TARGET_FRAME_MS = 24;

// Picks the next frame's band budget from how long the last frame actually
// took: one more band while frames come in under target, halved when they run
// over. Additive growth probes for throughput a band at a time; the
// multiplicative back-off is deliberately abrupt, because an overlong frame
// is the jank this whole mechanism exists to remove — it should be given up
// quickly and re-earned slowly. The floor is a single band: with the deal
// rotating between panels (see shareBands) even a budget of 1 keeps every
// panel moving, which is what makes a floor that low safe.
//
// The signal lags by a frame or so — a band submitted during frame K may not
// finish on the GPU until K+1 — so the budget hunts around its equilibrium
// rather than settling exactly on it. That is fine for what it controls: the
// cost of being one band off is one band's worth of frame time.
export function nextBandBudget(current, lastFrameMs, targetMs = TARGET_FRAME_MS) {
  const base = Number.isFinite(current) && current >= 1 ? Math.floor(current) : 1;
  if (!Number.isFinite(lastFrameMs) || lastFrameMs <= 0) return Math.min(MAX_FRAME_BAND_BUDGET, base);
  const next = lastFrameMs > targetMs ? Math.floor(base / 2) : base + 1;
  return Math.max(1, Math.min(MAX_FRAME_BAND_BUDGET, next));
}

// Splits a frame's band budget across panels that still have bands pending,
// one band at a time in round-robin order, so no panel is starved by another
// one's longer queue. `pending` is each panel's remaining band count; the
// result is the same length, sums to at most `budget`, and never gives a
// panel more than it asked for. Non-finite or negative entries count as 0.
//
// `firstServed` is which panel the deal starts from, and the caller advances
// it every frame. Without it, a budget smaller than the number of panels with
// work would hand every band to panel 0 until its frame completed and only
// then move on — the monopoly this exists to break, merely at a frame's
// granularity instead of a render's. That case is reachable precisely because
// nextBandBudget can drop the budget to 1; rotating here is what lets it,
// rather than having to hold the budget at or above the panel count.
export function shareBands(pending, budget, firstServed = 0) {
  const wanted = pending.map((n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0));
  const share = wanted.map(() => 0);
  if (wanted.length === 0) return share;
  let left = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0;
  const start = Number.isFinite(firstServed)
    ? ((Math.floor(firstServed) % wanted.length) + wanted.length) % wanted.length
    : 0;
  let served = true;
  while (left > 0 && served) {
    served = false;
    for (let k = 0; k < wanted.length && left > 0; k++) {
      const i = (start + k) % wanted.length;
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
// One row of an 8K canvas at the maxIter cap is ~63M pixel-iterations (7680 *
// 8192, see ITER.max in mandelbrot.js), which exceeds the budget on its own —
// a band can't be subdivided below a single row, so the clamp to at least one
// row is what covers that case rather than a theoretical impossibility. Such a
// frame is minutes of GPU work whatever the banding does with it.
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
