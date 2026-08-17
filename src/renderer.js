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

// What the offscreen render target holds: escape data (iteration count and the
// smooth-colouring term), not colour. See fs_main/fs_colorize in the WGSL for
// the encoding. Two 32-bit channels — 8 B/px against the 4 B/px a canvas-format
// colour target cost, so a panel's target and its reprojection spare each
// double in size. That is the price of not having to iterate again just to
// recolour.
//
// uint rather than float channels so the derived bind group layout's sample
// type is unambiguously "uint"; the WGSL comment on binding 3 has the details.
const DATA_FORMAT = "rg32uint";

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

// Splits one or more rectangular regions into horizontal bands, each with
// worst-case pixel-iteration cost (band.width * band.height * maxIter) at or
// under `budget`. Returns [{ x, y, width, height }, ...] covering every
// region exactly, no gaps/overlap, region by region in the order given.
// Regions rather than a single width/height is what lets a caller ask for
// only the part of a panel that actually needs redrawing — e.g. the L-shaped
// strip a pan uncovers — instead of always banding the whole canvas.
// One row of an 8K canvas at the maxIter cap is ~63M pixel-iterations (7680 *
// 8192, see ITER.max in mandelbrot.js), which exceeds the budget on its own —
// a band can't be subdivided below a single row, so the clamp to at least one
// row is what covers that case rather than a theoretical impossibility. Such a
// frame is minutes of GPU work whatever the banding does with it.
export function frameBands(regions, maxIter, budget = BAND_WORK_BUDGET) {
  const safeRegions = Array.isArray(regions) && regions.length > 0
    ? regions
    : [{ x: 0, y: 0, width: 1, height: 1 }];
  const bands = [];
  for (const region of safeRegions) {
    const x = Number.isFinite(region?.x) ? region.x : 0;
    const y = Number.isFinite(region?.y) ? region.y : 0;
    const safeWidth = Number.isFinite(region?.width) && region.width > 0 ? region.width : 1;
    const safeHeight = Number.isFinite(region?.height) && region.height > 0 ? region.height : 1;
    if (!Number.isFinite(maxIter) || maxIter <= 0) {
      bands.push({ x, y, width: safeWidth, height: safeHeight });
      continue;
    }
    const rows = Math.min(safeHeight, Math.max(1, Math.floor(budget / (safeWidth * maxIter))));
    for (let dy = 0; dy < safeHeight; dy += rows) {
      bands.push({ x, y: y + dy, width: safeWidth, height: Math.min(rows, safeHeight - dy) });
    }
  }
  return bands;
}

// The region a pan uncovers, as the rectangles frameBands wants: a vertical
// strip spanning the full height on the side the image came from, plus a
// horizontal strip covering only the columns that strip doesn't already — so
// the two never overlap and no pixel is computed twice. Returns 0, 1 or 2
// rectangles: 1 when the pan was purely horizontal or purely vertical, 0 when
// the shift is zero or big enough that nothing of the old frame survives (in
// which case there is nothing to reproject and the caller should be rendering
// the whole panel anyway).
export function exposedRegions(width, height, shift) {
  if (!(width > 0) || !(height > 0)) return [];
  const dx = Number.isFinite(shift?.x) ? Math.trunc(shift.x) : 0;
  const dy = Number.isFinite(shift?.y) ? Math.trunc(shift.y) : 0;
  if (Math.abs(dx) >= width || Math.abs(dy) >= height) return [];

  const regions = [];
  if (dx !== 0) {
    regions.push({ x: dx > 0 ? 0 : width + dx, y: 0, width: Math.abs(dx), height });
  }
  if (dy !== 0) {
    regions.push({
      x: dx > 0 ? dx : 0,
      y: dy > 0 ? 0 : height + dy,
      width: width - Math.abs(dx),
      height: Math.abs(dy),
    });
  }
  return regions;
}

// Whether beginFrame should defer a pan rather than reproject or fall back to
// a full render: true only when a valid shift exists, the target isn't
// freshly (re)created, and the previous frame is still draining. Pulled out
// as its own pure function (mirroring frameBands/shareBands/nextBandBudget/
// exposedRegions above) so the decision itself gets direct coverage without
// mocking the WebGPU device beginFrame otherwise depends on.
export function shouldQueuePan(shift, freshTarget, draining) {
  return shift !== null && !freshTarget && draining;
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
  // One view for the panel's whole life: writePalette replaces the texture's
  // contents, never the texture, so every bind group built from this stays
  // valid across palette changes.
  const paletteView = paletteTex.createView();

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
    fragment: { module, entryPoint: "fs_main", targets: [{ format: DATA_FORMAT }] },
    primitive: { topology: "triangle-list" }
  });

  // Uniform buffer: 15 logical f32 fields + 1 padding float, since WGSL
  // rounds a uniform struct's size up to a 16-byte multiple (64 B here).
  const uniformBuffer = device.createBuffer({
    size: 16 * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });

  // The uniform alone: since the colouring moved to fs_colorize, the iterate
  // pass reads neither the sampler nor the palette texture, so its "auto"
  // layout declares only binding 0 — and a bind group carrying entries the
  // layout doesn't declare is a validation error, not a harmless extra.
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } }
    ]
  });

  // Turns the offscreen target's escape data into pixels on the canvas (see
  // fs_colorize in the WGSL). Shares vs_main with the fractal pipeline, so no
  // second vertex stage; its "auto" layout resolves to binding 3 plus the
  // uniform/palette bindings 0-2, which it now reads too — the colouring half
  // of the old fused shader lives here.
  const colorizePipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs_main" },
    fragment: { module, entryPoint: "fs_colorize", targets: [{ format }] },
    primitive: { topology: "triangle-list" }
  });

  // A frame's bands are rendered into a texture we own rather than straight
  // into the swap-chain texture, then coloured onto the canvas in one draw.
  // A WebGPU canvas texture doesn't carry its contents over from the previous
  // frame, so it can't accumulate anything across animation frames; a texture
  // we own can, which is what lets a frame's bands be spread over several
  // frames instead of all being submitted in one.
  //
  // What accumulates here is escape data, not colour (DATA_FORMAT), so it also
  // outlives any one palette: present() can re-read it through a different
  // palette without a single iteration being redone.
  //
  // Texture, view, bind group and size are one object rather than four
  // parallel variables: a render target is useless without all four agreeing,
  // and keeping them together means a second target is one more object rather
  // than four more variables to hold in sync.
  //
  // The size is the one passed in, not read back off the GPUTexture, so the
  // staleness check below doesn't depend on GPUTexture exposing width/height.
  const createTarget = (width, height) => {
    const texture = device.createTexture({
      size: [width, height],
      format: DATA_FORMAT,
      // COPY_SRC and COPY_DST both, on both targets: reprojection copies one
      // into the other and then swaps their roles, so each has to be able to
      // play either end of the copy.
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST
    });
    const view = texture.createView();
    return {
      texture,
      view,
      width,
      height,
      // Four entries, not just the target's own view: fs_colorize also reads
      // the uniform and the palette. Only binding 3 varies per target, but a
      // bind group is all-or-nothing, so the other three are repeated here.
      colorizeBindGroup: device.createBindGroup({
        layout: colorizePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: paletteSampler },
          { binding: 2, resource: paletteView },
          { binding: 3, resource: view }
        ]
      }),
    };
  };

  // Where the current frame's bands land, and what present() puts on screen.
  let target = null;
  // Ping-pong partner for reprojection: a texture can't be sampled and
  // rendered into at once, so a shifted copy of the target has to land
  // somewhere else and take its place. Allocated the first time a pan actually
  // reuses a frame, so a session that never pans never pays for it (per panel:
  // one extra full-canvas texture, ~66 MB at 4K now that a texel is 8 B).
  let spare = null;

  // (Re)creates the render target whenever the canvas backing store has
  // changed size, and reports whether it did — a target created just now holds
  // no previous frame, so there is nothing for a reprojection to reuse. A
  // freshly created WebGPU texture is zero-initialized by spec, and zero is
  // exactly the escape data's NOT_RENDERED sentinel (see the WGSL), which
  // fs_colorize turns into black — so a new target needs no explicit clear
  // pass and any not-yet-drawn region reads as plain black on screen.
  const ensureTarget = () => {
    if (target && target.width === canvas.width && target.height === canvas.height) return false;
    // Already-submitted work referencing the old textures stays valid; destroy
    // only bars further use of them, which the reassignment below ends anyway.
    target?.texture.destroy();
    spare?.texture.destroy();
    spare = null;
    target = createTarget(canvas.width, canvas.height);
    return true;
  };

  // Slides the target's image by `shift` device pixels into the spare target,
  // then makes that the target — the pixels a pan didn't uncover, moved to
  // where they now belong instead of being computed again.
  //
  // The spare is cleared first and the overlap copied over it, rather than the
  // copy going in first: the part a pan uncovers must come out black, not
  // holding whatever the spare kept from two frames ago, so that no pixel ever
  // shows a picture of somewhere else while the exposed strips fill in. The
  // clearValue's zero is the NOT_RENDERED sentinel, which is what "black"
  // means in escape data — the same literal works unchanged for both.
  //
  // copyTextureToTexture rather than a shifted draw: no second WGSL entry
  // point, no uniform to carry the offset, and the copy is texel-exact by
  // construction. Both it and the clear cost memory bandwidth rather than
  // iterations, which is the whole point — they don't scale with maxIter.
  const reprojectTarget = (shift) => {
    if (!spare) spare = createTarget(target.width, target.height);
    const encoder = device.createCommandEncoder();
    const wipe = encoder.beginRenderPass({
      colorAttachments: [{
        view: spare.view,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 }
      }]
    });
    wipe.end();
    // A pixel at x in the old frame is at x + shift.x in the new one, so the
    // surviving overlap starts at max(0, -shift) in the source and lands at
    // max(0, shift) in the destination.
    encoder.copyTextureToTexture(
      { texture: target.texture, origin: { x: Math.max(0, -shift.x), y: Math.max(0, -shift.y) } },
      { texture: spare.texture, origin: { x: Math.max(0, shift.x), y: Math.max(0, shift.y) } },
      { width: target.width - Math.abs(shift.x), height: target.height - Math.abs(shift.y) }
    );
    device.queue.submit([encoder.finish()]);

    const displaced = target;
    target = spare;
    spare = displaced;
  };

  // Colours the render target onto the screen. getCurrentTexture() is called
  // here and nowhere else, so the canvas texture is always acquired and used
  // within the same task, as WebGPU requires. loadOp "clear" is nominal —
  // the full-screen triangle covers every pixel of the attachment.
  //
  // This is where the palette is applied, so it is also what makes a recolour
  // cheap: the same target, read again through a different palette, with no
  // band of iteration work behind it.
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
    pass.setPipeline(colorizePipeline);
    pass.setBindGroup(0, target.colorizeBindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    pendingRecolor = false;
  };

  // Rewrites the uniform buffer without starting a frame — for a palette or
  // look change alone (fractalPanel.js's needsRecolorOnly), where the target
  // already holds the escape data the new look needs and no band of iterate
  // work is owed. The iterate pipeline never reads the fields this changes
  // (smoothColoring/bandCount/the palette texture — see mandelbrot.wgsl's
  // fs_main), so this is safe to call even while a previous beginFrame's
  // bands are still draining: they keep producing the same escape data
  // regardless, and the next present() colours the target — complete or
  // partial — through the new uniform.
  //
  // Guarded on `target` even though the only caller only takes this path once
  // a previous frame has landed (needsRecolorOnly requires a non-null
  // lastRenderSignature, which only follows a beginFrame): making the
  // precondition an explicit check here means a violation surfaces right
  // here, not as a null-dereference three calls later inside present(). Note
  // this path never calls ensureTarget() — only beginFrame does — which is
  // sound only because every canvas resize goes through invalidateRender()
  // first (see mandelbrot.js's resizeVisiblePanels), forcing a real beginFrame
  // before a recolor could ever be reached at the new size.
  const recolor = (uniformData) => {
    if (!target) return;
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);
    pendingRecolor = true;
  };

  // Escape-data readback for the visual-entropy readout (see entropy.js).
  // Independent of `target`/`spare`: it copies out of whichever texture
  // `target` currently is, on demand, rather than owning a texture of its
  // own — a fixed-size staging buffer, resized only when the canvas is.
  let entropyStaging = null;
  let entropyReadInFlight = false;

  // Copies the whole render target out to a mappable buffer, subsamples it
  // to a fixed logical grid, and returns the result as a flat Uint32Array of
  // interleaved (x, y) texel pairs — entropy.js's computeEscapeEntropy takes
  // that format directly. Returns null if a target isn't up yet or a
  // previous readback is still in flight (the caller is expected to only
  // trigger this once a frame has settled, so a collision here would mean
  // two settle detections raced, not routine contention).
  //
  // Copies the full texture rather than something already downsized on the
  // GPU: copyTextureToBuffer can't stride, so the alternative is a decimate
  // pass of its own (a real cost) purely to shrink a readback this codebase
  // doesn't do more than once per completed frame. Simplest correct thing
  // first; see the plan doc for the compute-shader alternative if this ever
  // shows up in a profile.
  const ENTROPY_GRID = 256;
  const readEscapeSamples = async () => {
    if (!target || entropyReadInFlight) return null;
    const { width, height } = target;
    // rg32uint is 8 B/texel; WebGPU requires bytesPerRow to be a multiple of
    // 256 for a texture-to-buffer copy.
    const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
    const bufferSize = bytesPerRow * height;

    if (!entropyStaging || entropyStaging.width !== width || entropyStaging.height !== height) {
      entropyStaging?.buffer.destroy();
      entropyStaging = {
        buffer: device.createBuffer({
          size: bufferSize,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        }),
        width,
        height
      };
    }

    entropyReadInFlight = true;
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture: target.texture },
        { buffer: entropyStaging.buffer, bytesPerRow },
        { width, height }
      );
      device.queue.submit([encoder.finish()]);

      await entropyStaging.buffer.mapAsync(GPUMapMode.READ);
      const mapped = new Uint32Array(entropyStaging.buffer.getMappedRange());
      const texelsPerRow = bytesPerRow / 4; // 2 u32 (8 B) per texel

      const cols = Math.min(ENTROPY_GRID, width);
      const rows = Math.min(ENTROPY_GRID, height);
      const samples = new Uint32Array(cols * rows * 2);
      let k = 0;
      for (let gy = 0; gy < rows; gy++) {
        const y = Math.floor(((gy + 0.5) * height) / rows);
        const rowOffset = y * texelsPerRow;
        for (let gx = 0; gx < cols; gx++) {
          const x = Math.floor(((gx + 0.5) * width) / cols);
          const idx = rowOffset + x * 2;
          samples[k++] = mapped[idx];
          samples[k++] = mapped[idx + 1];
        }
      }
      entropyStaging.buffer.unmap();
      return samples;
    } finally {
      entropyReadInFlight = false;
    }
  };

  // The current frame's bands and how many of them have been submitted. This
  // outlives the animation frame that started it: submitting a band is cheap
  // on the CPU but can be tens of milliseconds of GPU work, so an expensive
  // frame's bands are handed over a few per animation frame (see
  // advanceFrame) instead of all at once — which is what left the UI frozen
  // for as long as the whole frame took.
  let job = null;

  // Diagnostic only, not read by any render logic besides beginFrame's own
  // deferral check: what happened to the most recently requested shift, for
  // the caller to log (see mandelbrot.js's startRenderIfNeeded). Stays null
  // on a frame that never requested a shift in the first place — that path
  // is fine, it's not a rejected pan. "queued" means beginFrame returned
  // null without starting a new frame at all (see there).
  let lastPanOutcome = null;

  // True from a recolor() call until the next present(), regardless of which
  // branch triggers that present() — a plain band-driven one or one taken
  // solely to show the recolor. advanceRenderJobs (mandelbrot.js) reads this
  // to know a panel needs putting on screen even though it has no bands
  // pending, which is the normal state for a recolor: the target already
  // holds everything it needs, just under the previous look.
  let pendingRecolor = false;

  // Starts a frame, dropping any bands of the previous one still unsubmitted.
  //
  // `clear` says whether the render target should be wiped first. Without
  // it the new frame's bands overwrite the old image from the top down, so a
  // panel interrupted mid-frame keeps showing the newest content at the top
  // over progressively older content below — right when the frame is a
  // refinement of the same view, wrong when the view itself moved, since then
  // the untouched rows are a picture of somewhere else. The caller decides
  // (see fractalPanel.js's sameViewGeometry).
  //
  // `shift`, when non-null, says the new frame is the old one translated by
  // that many device pixels (fractalPanel.js's panShiftBetween) — so the
  // overlap can be copied across and only the strips the pan uncovered need
  // computing. That makes a frame cost what the pan uncovered rather than what
  // the panel holds, which for the short drags of ordinary exploring is an
  // order of magnitude less. Returns how many bands this frame was split into.
  const beginFrame = (uniformData, maxIter, { clear = false, shift = null } = {}) => {
    const freshTarget = ensureTarget();
    // Reprojecting is only sound if the target really holds the whole frame
    // the shift was measured against: not one created this very call, and not
    // one still missing bands of the frame before — a half-drained target is
    // part old view, part new, and sliding that across would smear the two.
    const draining = job !== null && job.next < job.bands.length;
    // A shift within tolerance but the previous frame still draining: wait
    // for it rather than discarding its still-good pixels for a full
    // re-render. Neither the uniform buffer nor `job` is touched, so the old
    // frame keeps landing exactly as it would have; the caller (see
    // mandelbrot.js's startRenderIfNeeded) skips markRendered on a null
    // return, which leaves lastRenderSignature at the pre-pan view, so this
    // same call recurs every animation frame — recomputing the shift fresh
    // each time, so it also absorbs any further panning in the meantime —
    // until draining is false and the reprojection actually happens below.
    if (shouldQueuePan(shift, freshTarget, draining)) {
      lastPanOutcome = "queued";
      return null;
    }
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);
    // Banded off the render target's own size, not the live canvas's: the
    // canvas can be resized while a frame is still draining, and every band
    // still queued has to stay inside the attachment it was computed for.
    // ensureTarget above has just reconciled the two for a new frame.
    // A clear stays owed until it has actually happened. It rides on band 0's
    // loadOp, so a frame replaced before that band was submitted — which the
    // per-frame budget can cause, by handing this panel none of it while the
    // other panel drains — never wiped anything, and the target still holds
    // the view the panel moved off. Without carrying it over, a later frame
    // that only recolours the same view would correctly ask for no clear and
    // the wipe would be lost for good.
    const owed = job !== null && job.next === 0 && job.clear;
    const reproject = shift !== null && !freshTarget;
    lastPanOutcome = shift === null ? null : reproject ? "reprojected" : "fresh-target";
    if (reproject) reprojectTarget(shift);

    job = {
      bands: frameBands(
        reproject
          ? exposedRegions(target.width, target.height, shift)
          : [{ x: 0, y: 0, width: target.width, height: target.height }],
        maxIter
      ),
      next: 0,
      // A reprojection has already cleared what it didn't copy, so the frame
      // must not also ask band 0 to wipe the attachment — that would erase the
      // overlap it just went to the trouble of preserving.
      clear: !reproject && (clear || owed),
    };
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
  // A band loads rather than clears, so it overwrites only its own rows and
  // leaves the rest of the previous frame showing. The exception is the first
  // band of a frame that asked to be cleared (see beginFrame): loadOp applies
  // to the whole attachment rather than to the scissor rect, so putting the
  // clear there wipes the target and draws band 0 in the same pass, at no
  // extra submit. The clearValue below is a GPUColor whatever the attachment's
  // format, so its b/a are simply dropped by DATA_FORMAT's two channels and
  // the zero it leaves in r/g is the NOT_RENDERED sentinel — "clear" and
  // "black" still coincide, as they did when this held colour.
  const advanceFrame = (maxBands) => {
    if (!job) return 0;
    const wanted = Number.isFinite(maxBands) ? Math.max(0, Math.floor(maxBands)) : 0;
    const upTo = Math.min(job.bands.length, job.next + wanted);
    const from = job.next;

    for (; job.next < upTo; job.next++) {
      const band = job.bands[job.next];
      const wipeFirst = job.clear && job.next === 0;
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: target.view,
          loadOp: wipeFirst ? "clear" : "load",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 }
        }]
      });

      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.setScissorRect(band.x, band.y, band.width, band.height);
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
    recolor,
    writePalette,
    readEscapeSamples,
    // Bands of the current frame not yet submitted; 0 once it has fully
    // landed, which is also how the caller knows the frame is complete.
    get pendingBands() { return job ? job.bands.length - job.next : 0; },
    // Diagnostic getter, see lastPanOutcome above.
    get lastPanOutcome() { return lastPanOutcome; },
    // A recolor() happened since the last present() — advanceRenderJobs
    // (mandelbrot.js) presents a panel that has this set even when it has no
    // bands to advance, since a recolor's whole point is a new look with no
    // new work.
    get needsPresent() { return pendingRecolor; },
  };
}
