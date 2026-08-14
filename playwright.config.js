// @ts-check
import { defineConfig } from '@playwright/test';

// SwiftShader software rendering gives a working WebGPU adapter in
// environments without a real/accessible GPU (e.g. headless CI or sandboxes).
// --ignore-gpu-blocklist is deliberately omitted: on hosts that expose a
// (partial/virtual) GPU device node, it lets Chromium attempt that hardware
// path instead of cleanly using SwiftShader, which was observed to make
// WebGPU adapter creation intermittently fail ("No WebGPU adapter available").
const SWIFTSHADER_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=swiftshader',
  '--use-vulkan=swiftshader',
  '--enable-unsafe-swiftshader',
];

// On native Windows, SwiftShader can't provide a WebGPU adapter at all
// (confirmed 2026-08-02: "No available adapters" both with the flags above and
// Chromium's own headless default), so Windows goes through the real GPU via
// ANGLE's D3D11 backend instead. Disabling Dawn's DXC shader compiler is what
// makes that work headless: inside the headless GPU process loading its DLL
// fails ("DynamicLib.Open: dxil.dll Windows Error: 87") and requestDevice()
// throws, while Dawn's FXC fallback renders fine (confirmed 2026-08-14 17:50:00).
const IS_NATIVE_WINDOWS = process.platform === 'win32';
const GPU_ARGS = IS_NATIVE_WINDOWS
  ? ['--enable-unsafe-webgpu', '--use-angle=d3d11', '--disable-dawn-features=use_dxc']
  : SWIFTSHADER_ARGS;

export default defineConfig({
  testDir: './tests',
  // Explicit, rather than the default (which also matches *.test.js): the
  // node:test unit tests under tests/unit/*.test.js are not Playwright tests
  // and must not be picked up here.
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  // Where the tests share one real GPU, running them in parallel is not just
  // pointless but actively worse: the default worker count made page loads
  // miss their 30s timeout, and the run took 4m12 with five such failures
  // against 2m36 and a clean pass serially (measured 2026-08-14 18:57:00). The
  // SwiftShader platforms render on the CPU instead, so there parallelism
  // still pays and the default worker count stands.
  workers: IS_NATIVE_WINDOWS ? 1 : undefined,
  retries: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:8123',
    launchOptions: {
      args: ['--no-sandbox', ...GPU_ARGS],
      // A shell-level DISPLAY env var (e.g. set by a personal .bashrc for an
      // unrelated tool) makes Chromium try to attach to that X server even in
      // headless mode, which was observed to make WebGPU/SwiftShader init
      // intermittently fail. Force it off so the browser process's behavior
      // doesn't depend on whatever the invoking shell happens to export.
      env: { ...process.env, DISPLAY: '' },
    },
  },
  webServer: {
    // Node, not python3 -m http.server: serving one request at a time, Python
    // buckles once several Playwright workers hit it together — dropping
    // requests (ERR_EMPTY_RESPONSE) on Linux, and on Windows hanging page
    // loads until their 30s timeout, which reads as a WebGPU failure and is
    // not. scripts/serve.mjs rather than `npx http-server` because it depends
    // on nothing, so a run never waits on a package fetch, and it sends
    // no-store, which also stops a reload from serving stale modules.
    command: 'node scripts/serve.mjs 8123',
    // Not 8000: on the Windows host VirtualBoxVM.exe holds that port, and
    // reuseExistingServer below would then mistake it for our own server.
    port: 8123,
    // In CI, always start a fresh server rather than reusing whatever might
    // already be listening on the port; locally, reuse one you already have
    // running (e.g. for manual testing) instead of racing to bind it twice.
    reuseExistingServer: !process.env.CI,
  },
});
