// @ts-check
import { defineConfig } from '@playwright/test';
import { ensureTestCert } from './scripts/make-test-cert.mjs';

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

// Exported so scripts/precision-app-render-probe.mjs can launch the exact
// backend this suite runs on, instead of a copy that could silently drift.
export { GPU_ARGS, SWIFTSHADER_ARGS };

// Native Windows serves the suite over TLS; every other platform stays on plain
// HTTP and needs no certificate. The reason is the loopback stall documented at
// `workers` below: an HTTP content inspector on that machine holds plain-text
// payload for ~10s at a time, and encrypted payload gives it nothing to read.
// The certificate is made here, before the web server starts, and is skipped
// when the existing one is still valid.
const TEST_PORT = IS_NATIVE_WINDOWS ? 8443 : 8123;
const BASE_URL = `${IS_NATIVE_WINDOWS ? 'https' : 'http'}://localhost:${TEST_PORT}`;
if (IS_NATIVE_WINDOWS) ensureTestCert();

export default defineConfig({
  testDir: './tests',
  // Explicit, rather than the default (which also matches *.test.js): the
  // node:test unit tests under tests/unit/*.test.js are not Playwright tests
  // and must not be picked up here.
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  // Parallel everywhere. Native Windows had to run serially until 2026-08-16,
  // because with parallel workers page loads missed their 30s timeout there —
  // 4m12 with five such failures against 2m36 and a clean pass serially.
  //
  // The cause is an HTTP content inspector holding plain-text loopback payload;
  // TLS is what fixes it, which is why this platform serves over https above.
  // The TCP connection is accepted in 3ms and sits Established with both ends
  // idle while the server waits 10, 20, 30 or 40 seconds — multiples of a ~10s
  // quantum — for request bytes the client already wrote. It is not Chromium's
  // doing: a plain Node client polling the same server during a stall waits the
  // same ~10s, while 120 Node requests with no browser running never stall at
  // all. Avast is registered in the Windows Filtering Platform with a
  // terminating callout on all TCP, including the STREAM layer where payload
  // can be held. Over TLS: 0/9 stalled against 9/9 on plain HTTP,
  // cross-controlled against the port, and the whole suite passes 103/103 in
  // 1.4 min on four workers against 2m45s serially.
  //
  // Neither the GPU nor anything of ours, in case it resurfaces: WebGPU device
  // creation scales fine (187ms with one browser against 467ms with eight),
  // four browsers finish the app's whole init in ~1.2s when the files reach
  // them without a socket, and ruled out along the way were serve.mjs itself,
  // DNS and the hosts file, localhost against 127.0.0.1, proxy auto-discovery,
  // the port number, ephemeral-port exhaustion, and NetworkServiceSandbox.
  // scripts/diag/ holds the probes and README.md the full workings.
  workers: undefined,
  retries: 1,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    // The Windows certificate is self-signed and thrown away; both the test
    // context and the browser itself have to be told not to care.
    ignoreHTTPSErrors: IS_NATIVE_WINDOWS,
    launchOptions: {
      args: [
        '--no-sandbox',
        ...GPU_ARGS,
        ...(IS_NATIVE_WINDOWS ? ['--ignore-certificate-errors'] : []),
      ],
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
    command: `node scripts/serve.mjs ${TEST_PORT}${IS_NATIVE_WINDOWS ? ' --tls' : ''}`,
    // Playwright ignores webServer stdout by default; the test scripts grep
    // its access-log lines (filtering noise but keeping the /index.html
    // ones), which needs them piped through in the first place.
    stdout: 'pipe',
    // Not 8000: on the Windows host VirtualBoxVM.exe holds that port, and
    // reuseExistingServer below would then mistake it for our own server.
    // The https port is checked by URL instead, since a port check cannot tell
    // a TLS server from a plain one already sitting there.
    ...(IS_NATIVE_WINDOWS
      ? { url: `${BASE_URL}/index.html`, ignoreHTTPSErrors: true }
      : { port: TEST_PORT }),
    // In CI, always start a fresh server rather than reusing whatever might
    // already be listening on the port; locally, reuse one you already have
    // running (e.g. for manual testing) instead of racing to bind it twice.
    reuseExistingServer: !process.env.CI,
  },
});
