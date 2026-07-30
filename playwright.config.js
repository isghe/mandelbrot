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

export default defineConfig({
  testDir: './tests',
  // Explicit, rather than the default (which also matches *.test.js): the
  // node:test unit tests under tests/unit/*.test.js are not Playwright tests
  // and must not be picked up here.
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  retries: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:8000',
    launchOptions: {
      args: ['--no-sandbox', ...SWIFTSHADER_ARGS],
      // A shell-level DISPLAY env var (e.g. set by a personal .bashrc for an
      // unrelated tool) makes Chromium try to attach to that X server even in
      // headless mode, which was observed to make WebGPU/SwiftShader init
      // intermittently fail. Force it off so the browser process's behavior
      // doesn't depend on whatever the invoking shell happens to export.
      env: { ...process.env, DISPLAY: '' },
    },
  },
  webServer: {
    command: 'python3 -m http.server 8000',
    port: 8000,
    reuseExistingServer: true,
  },
});
