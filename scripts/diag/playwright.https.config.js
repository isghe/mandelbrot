// @ts-check
// Experiment, not the project's configuration: the suite as it stands, but
// served over TLS and with the default (parallel) worker count on Windows.
//
// The reason it can be parallel here: the native Windows stall is an HTTP
// content inspector holding plain-text loopback payload for ~10s at a time
// (measured 2026-08-16 — see scripts/diag/README.md). Encrypted payload gives
// it nothing to read, and the stall does not occur.
//
//   npx playwright test --config=scripts/diag/playwright.https.config.js
//
// The certificate comes from scripts/diag/out/cert, generated with:
//   openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj /CN=localhost \
//     -addext subjectAltName=DNS:localhost,IP:127.0.0.1 \
//     -keyout scripts/diag/out/cert/key.pem -out scripts/diag/out/cert/cert.pem
import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  testDir: '../../tests',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  // The point of the experiment: no win32 special case.
  retries: 1,
  reporter: 'list',
  use: {
    baseURL: 'https://127.0.0.1:8443',
    ignoreHTTPSErrors: true,
    launchOptions: {
      args: [
        '--no-sandbox',
        '--enable-unsafe-webgpu',
        '--use-angle=d3d11',
        '--disable-dawn-features=use_dxc',
        '--ignore-certificate-errors',
      ],
      env: { ...process.env, DISPLAY: '' },
    },
  },
  webServer: {
    command: 'node scripts/diag/serve-https.mjs 8443',
    cwd: REPO,
    url: 'https://127.0.0.1:8443/index.html',
    ignoreHTTPSErrors: true,
    reuseExistingServer: !process.env.CI,
  },
});
