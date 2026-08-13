import { test, expect } from '@playwright/test';
import { PALETTE_GROUPS } from '../src/palette.js';

const VIEWPORT = { width: 1280, height: 720 };

const EXPECTED_GROUPS = PALETTE_GROUPS.map((group) => ({
  label: group.label,
  options: group.palettes.map((p) => ({ value: String(p.id), label: p.label })),
}));

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

for (const selId of ['mandelbrotPaletteType', 'juliaPaletteType']) {
  test(`#${selId} is built from the palette registry with the expected optgroups/options`, async ({ page }) => {
    const optgroups = page.locator(`#${selId} optgroup`);
    await expect(optgroups).toHaveCount(EXPECTED_GROUPS.length);

    for (let i = 0; i < EXPECTED_GROUPS.length; i++) {
      const group = EXPECTED_GROUPS[i];
      const optgroup = optgroups.nth(i);
      await expect(optgroup).toHaveAttribute('label', group.label);

      const options = optgroup.locator('option');
      await expect(options).toHaveCount(group.options.length);
      for (let j = 0; j < group.options.length; j++) {
        const option = options.nth(j);
        await expect(option).toHaveAttribute('value', group.options[j].value);
        await expect(option).toHaveText(group.options[j].label);
      }
    }
  });

  test(`#${selId} defaults to Apple II (value 4)`, async ({ page }) => {
    await expect(page.locator(`#${selId}`)).toHaveValue('4');
  });

  test(`#${selId} can be switched to the Apple II - Banded palette`, async ({ page }) => {
    await page.selectOption(`#${selId}`, '6');
    await expect(page.locator(`#${selId}`)).toHaveValue('6');
  });
}
