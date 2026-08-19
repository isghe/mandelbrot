// Copyright (c) 2026 Isidoro Ghezzi
//
// Launches Chromium against precision-portability-probe.html twice — once
// plain, once with ?strict=1 (the non-standard GPUShaderModuleDescriptor
// strictMath option, gated behind chrome://flags/#enable-webgpu-developer-features,
// see gpuweb#2076) — under two backends: Chrome's own default, and the
// D3D11+FXC combination playwright.config.js forces on native Windows to get
// a working headless adapter at all.
//
// Findings (2026-08-19, Intel gen-9, Windows):
//   - strictMath:true changed nothing under either backend. Either the
//     command-line feature flag doesn't actually enable the developer option
//     (the docs only describe chrome://flags), or the non-standard dictionary
//     member is silently ignored when the flag isn't really active.
//   - Chrome's default backend preserves precision (32/32) with or without
//     strictMath.
//   - The forced D3D11+FXC backend collapses to 4/32 — the same block pattern
//     previously seen only on Firefox — with or without strictMath. That
//     backend is exactly what the project's own headless Windows CI run uses,
//     so the e2e suite is running on a backend with the same fragility, just
//     not yet caught by any test at a matching zoom depth.
//
// Usage: node scripts/precision-strictmath-probe.mjs

import { chromium } from '@playwright/test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const file = pathToFileURL(
  path.resolve(import.meta.dirname, 'precision-portability-probe.html')
).href;

const BACKENDS = [
  {
    label: 'Chrome default backend',
    args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=WebGPUDeveloperFeatures'],
    headless: false, // the default backend needs a real display session on native Windows
  },
  {
    label: 'D3D11+FXC (matches playwright.config.js on native Windows)',
    args: [
      '--no-sandbox',
      '--enable-unsafe-webgpu',
      '--use-angle=d3d11',
      '--disable-dawn-features=use_dxc',
      '--enable-features=WebGPUDeveloperFeatures',
    ],
    headless: true,
  },
];

for (const { label, args, headless } of BACKENDS) {
  console.log(`\n########## ${label} ##########`);
  const browser = await chromium.launch({ headless, args, env: { ...process.env, DISPLAY: '' } });
  for (const [variant, url] of [
    ['baseline', file],
    ['strictMath: true', `${file}?strict=1`],
  ]) {
    const page = await browser.newPage();
    await page.goto(url);
    await page
      .waitForFunction(() => document.getElementById('result').textContent !== 'running…', { timeout: 15000 })
      .catch(() => {});
    console.log(`\n=== ${variant} ===\n${await page.locator('#result').innerText()}`);
    await page.close();
  }
  await browser.close();
}
