// Copyright (c) 2026 Isidoro Ghezzi
//
// End-to-end counterpart of scripts/precision-strictmath-probe.mjs, which
// drives scripts/precision-portability-probe.html — an isolated compute
// shader reproducing the ds_add precision collapse described in gpuweb#2076.
// That probe found the collapse is not Firefox-vs-Chrome: the D3D11+FXC
// backend playwright.config.js forces for headless native-Windows CI
// collapses ds_add the same way Firefox does, while Chrome's own default
// backend on the same GPU does not.
//
// This script asks whether that collapse reaches the real render pipeline
// (fs_main in src/mandelbrot.wgsl, run through src/renderer.js), and at what
// zoom depth it starts, rather than only the isolated compute shader. The
// app fetches its WGSL over HTTP (renderer.js's attachCanvas), so — unlike
// the standalone probe — it must be served, not opened via file://.
//
// For each of a range of zoom depths (mscale), on each backend, it loads the
// real app at a deep-zoom URL, waits for the render to settle, and reads back
// 32 adjacent full-resolution texels off the actual escape-data render
// target — the same "distinct values in a run of 32 adjacent pixels" metric
// the isolated probe uses, but against real fs_main output instead of a
// synthetic compute shader.
//
// Usage: node scripts/precision-app-render-probe.mjs

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import path from 'node:path';
import { GPU_ARGS, SWIFTSHADER_ARGS } from '../playwright.config.js';
import { waitForRenderSettled } from '../tests/fractalShot.js';

const IS_NATIVE_WINDOWS = process.platform === 'win32';
const PORT = 8127;
// Plain-text loopback on this machine's native-Windows setup is held in ~10s
// increments by a content inspector once a browser is involved (see
// playwright.config.js) — TLS is the fix, so this script serves over it from
// the start on that platform rather than waiting for the symptom.
const BASE_URL = `${IS_NATIVE_WINDOWS ? 'https' : 'http'}://localhost:${PORT}`;

// A fixed, already-verified-structured deep-zoom centre (examples/examples.md's
// dual-panel view), rather than a fresh one: panning only mscale in and out at
// a known-good centre still risks landing in an all-interior region at some
// depths (flagged via interiorFraction below), but starting from a spot
// that's confirmed structured at one real depth is better than guessing.
const CENTER = { x: -1.859401731016781, y: -0.001809058061010546 };
const MAX_ITER = 1549;

// Shallow to deep; SCALE.min in src/mandelbrot.js is 1e-14, so 1e-13 is one
// decade of headroom short of the app's own floor. 2.899932872038949e-7 is
// examples.md's own verified-structured mscale at CENTER.
const DEPTHS = [1e-2, 1e-4, 1e-6, 2.899932872038949e-7, 1e-8, 1e-10, 1e-12, 1e-13];

const viewUrl = (scale) => {
  const params = new URLSearchParams({
    v: '7',
    julia: '0',
    mx: String(CENTER.x),
    my: String(CENTER.y),
    mscale: String(scale),
    miter: String(MAX_ITER),
  });
  return `${BASE_URL}/index.html?${params}`;
};

async function startServer() {
  const args = [path.resolve(import.meta.dirname, 'serve.mjs'), String(PORT)];
  if (IS_NATIVE_WINDOWS) args.push('--tls');
  const child = spawn(process.execPath, args, { stdio: 'ignore' });

  const probeOnce = () => new Promise((resolve) => {
    const get = IS_NATIVE_WINDOWS ? httpsGet : httpGet;
    const req = get(`${BASE_URL}/index.html`, { rejectUnauthorized: false }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
  });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await probeOnce()) return child;
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error(`server did not come up on ${BASE_URL} within 15s`);
}

// waitForRenderSettled tolerates a renderer that never even started a frame
// (pendingBands is 0 both before the first beginFrame and after the last),
// so right after a fresh page.goto() it can resolve in the gap before the
// initial render has actually begun — target is still null and
// readEscapeSamples() returns null. Poll until a real frame has landed.
async function waitForFirstRender(page, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await waitForRenderSettled(page);
    const ready = await page.evaluate(async () => {
      const samples = await window.app.modelNamed('mandelbrot').panel.renderer.readEscapeSamples();
      return samples !== null;
    });
    if (ready) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('render target never appeared within timeout');
}

// Reads 32 adjacent full-resolution texels off the real render target's
// centre scanline, without touching src/renderer.js: readEscapeSamples()
// already does exactly the copyTextureToBuffer/mapAsync dance we need over
// the whole texture (see its comment in renderer.js), just subsampled to a
// 256x256 grid for the entropy readout. Patching copyTextureToBuffer for the
// duration of one call captures which texture it targeted, then a second,
// scanline-sized copy reads it at full resolution — entirely from the test
// side, only while no render is in flight (the caller awaits
// waitForRenderSettled first).
async function readCenterScanline(page) {
  return page.evaluate(async () => {
    const panel = window.app.modelNamed('mandelbrot').panel;
    const renderer = panel.renderer;
    if (!renderer) return { error: 'no renderer attached' };

    let captured = null;
    const proto = GPUCommandEncoder.prototype;
    const original = proto.copyTextureToBuffer;
    proto.copyTextureToBuffer = function (source, dest, size) {
      if (!captured) captured = source.texture;
      return original.call(this, source, dest, size);
    };
    let escapeSamples;
    try {
      escapeSamples = await renderer.readEscapeSamples();
    } finally {
      proto.copyTextureToBuffer = original;
    }
    if (!captured) return { error: 'readEscapeSamples did not call copyTextureToBuffer' };

    const { computeEscapeEntropy } = await import('/src/entropy.js');
    const entropy = escapeSamples ? computeEscapeEntropy(escapeSamples) : null;

    const texture = captured;
    const { width, height } = texture;
    const device = window.app.gpuDevice;
    const rowY = Math.floor(height / 2);
    const start = Math.max(0, Math.floor(width / 2) - 16);
    const runWidth = Math.min(32, width - start);
    const bytesPerRow = Math.ceil((runWidth * 8) / 256) * 256;

    const buffer = device.createBuffer({
      size: bytesPerRow,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture, origin: { x: start, y: rowY } },
      { buffer, bytesPerRow },
      { width: runWidth, height: 1 },
    );
    device.queue.submit([encoder.finish()]);

    let texels;
    try {
      await buffer.mapAsync(GPUMapMode.READ);
      try {
        texels = Array.from(new Uint32Array(buffer.getMappedRange().slice(0, runWidth * 8)));
      } finally {
        buffer.unmap();
      }
    } finally {
      buffer.destroy();
    }

    const INTERIOR = 0xffffffff;
    const pairs = [];
    for (let i = 0; i < texels.length; i += 2) pairs.push(`${texels[i]},${texels[i + 1]}`);
    const distinct = new Set(pairs).size;
    let maxRun = pairs.length ? 1 : 0;
    let run = 1;
    for (let i = 1; i < pairs.length; i++) {
      run = pairs[i] === pairs[i - 1] ? run + 1 : 1;
      if (run > maxRun) maxRun = run;
    }
    const interiorCount = texels.filter((v, i) => i % 2 === 0 && v === INTERIOR).length;

    return {
      runWidth,
      distinct,
      maxRun,
      interiorFraction: pairs.length ? interiorCount / pairs.length : 0,
      frameEntropy: entropy,
    };
  });
}

async function probeBackend(label, launchArgs, { headless }) {
  console.log(`\n########## ${label} ##########`);
  let browser;
  try {
    browser = await chromium.launch({
      headless,
      args: ['--no-sandbox', ...launchArgs, ...(IS_NATIVE_WINDOWS ? ['--ignore-certificate-errors'] : [])],
      env: { ...process.env, DISPLAY: '' },
    });
  } catch (e) {
    console.log(`  skipped: could not launch (${e.message})`);
    return;
  }

  const context = await browser.newContext({ ignoreHTTPSErrors: IS_NATIVE_WINDOWS });
  for (const scale of DEPTHS) {
    const url = viewUrl(scale);
    const page = await context.newPage();
    try {
      await page.goto(url);
      // page.goto() resolving on 'load' does not guarantee app.init()'s
      // async GPU setup (mandelbrot.js's top-level await) has finished yet —
      // waitForRenderSettled tolerates a renderer that never attaches (so it
      // doesn't hang forever when WebGPU is genuinely unavailable), so it is
      // not a substitute for this wait.
      await page.waitForFunction(
        () => window.app.modelNamed('mandelbrot').panel.renderer
          || document.querySelector('#gpuError')?.offsetParent !== null,
        { timeout: 10000 },
      );
      const gpuError = page.locator('#gpuError');
      if (await gpuError.isVisible().catch(() => false)) {
        console.log(`  mscale=${scale}: gpuError visible, skipping`);
        continue;
      }
      await waitForFirstRender(page);
      const r = await readCenterScanline(page);
      if (r.error) {
        console.log(`  mscale=${scale}: ${r.error}`);
      } else {
        const entropyBit = r.frameEntropy
          ? `frame entropy=${r.frameEntropy.entropyNormalized.toFixed(3)}`
          : 'frame entropy=n/a';
        console.log(
          `  mscale=${scale.toExponential(6).padEnd(14)} `
          + `${r.distinct}/${r.runWidth} distinct  maxRun=${String(r.maxRun).padEnd(2)}  `
          + `interior=${(r.interiorFraction * 100).toFixed(0)}%  ${entropyBit}`
        );
      }
    } catch (e) {
      console.log(`  mscale=${scale}: FAILED (${e.message})`);
    } finally {
      await page.close();
    }
  }
  console.log(
    '  view URL template (swap mscale by hand to cross-check in another browser):\n'
    + `  ${BASE_URL}/index.html?v=7&julia=0&mx=${CENTER.x}&my=${CENTER.y}&mscale=<mscale>&miter=${MAX_ITER}`
  );

  await context.close();
  await browser.close();
}

const server = await startServer();
try {
  // Chrome's own default backend needs a real display session on native
  // Windows (see precision-strictmath-probe.mjs) — run it first so a missing
  // display degrades gracefully via probeBackend's launch try/catch rather
  // than aborting the CI-backend run below.
  await probeBackend('Chrome default backend', [], { headless: false });
  await probeBackend(
    IS_NATIVE_WINDOWS ? 'D3D11+FXC (matches playwright.config.js on native Windows)' : 'SwiftShader (matches playwright.config.js off Windows)',
    IS_NATIVE_WINDOWS ? GPU_ARGS : SWIFTSHADER_ARGS,
    { headless: true },
  );
} finally {
  server.kill();
}
