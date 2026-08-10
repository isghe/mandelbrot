import { test, expect } from '@playwright/test';
import { MANDELBROT_LANDMARKS } from '../src/landmarks.js';

const VIEWPORT = { width: 1280, height: 720 };

test.beforeEach(async ({ page }) => {
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  await page.setViewportSize(VIEWPORT);
  await page.goto('/index.html');

  const gpuError = page.locator('#gpuError');
  if (await gpuError.isVisible()) {
    const message = await page.locator('#gpuErrorMessage').textContent();
    throw new Error(
      `WebGPU failed to initialize: ${message}\nConsole errors:\n${consoleErrors.join('\n')}`
    );
  }
});

test('#mandelbrotLandmarks is built from the landmarks registry, one option per entry plus a placeholder', async ({ page }) => {
  const options = page.locator('#mandelbrotLandmarks option');
  await expect(options).toHaveCount(MANDELBROT_LANDMARKS.length + 1);
  await expect(options.first()).toHaveText('Jump to…');
  for (let i = 0; i < MANDELBROT_LANDMARKS.length; i++) {
    const option = options.nth(i + 1);
    await expect(option).toHaveAttribute('value', String(i));
    await expect(option).toHaveText(MANDELBROT_LANDMARKS[i].name);
  }
});

test('#mandelbrotLandmarks has no Julia counterpart', async ({ page }) => {
  await expect(page.locator('#juliaLandmarks')).toHaveCount(0);
});

const period2Index = MANDELBROT_LANDMARKS.findIndex((l) => l.name === 'Period-2 Center');
const cuspIndex = MANDELBROT_LANDMARKS.findIndex((l) => l.name === 'Main Cardioid Cusp');

test('selecting a landmark recenters the Mandelbrot panel, keeps scale, and resets the select to its placeholder', async ({ page }) => {
  const beforeScale = await page.evaluate(() => window.app.modelNamed('mandelbrot').panel.scale);
  const landmark = MANDELBROT_LANDMARKS[period2Index];

  await page.selectOption('#mandelbrotLandmarks', String(period2Index));
  await expect(page.locator('#mandelbrotLandmarks')).toHaveValue('');

  const { center, scale } = await page.evaluate(() => {
    const panel = window.app.modelNamed('mandelbrot').panel;
    return { center: { x: panel.center.x, y: panel.center.y }, scale: panel.scale };
  });
  expect(center.x).toBeCloseTo(landmark.x, 10);
  expect(center.y).toBeCloseTo(landmark.y, 10);
  expect(scale).toBeCloseTo(beforeScale, 10);
});

test('selecting a landmark pushes history (Back button becomes enabled)', async ({ page }) => {
  await expect(page.locator('#backBtn')).toBeDisabled();
  await page.selectOption('#mandelbrotLandmarks', String(cuspIndex));
  await expect(page.locator('#backBtn')).toBeEnabled();
});
