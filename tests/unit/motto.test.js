import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MOTTO } from '../../src/motto.js';

const readmePath = fileURLToPath(new URL('../../README.md', import.meta.url));
const readme = readFileSync(readmePath, 'utf8');

test('README.md motto matches src/motto.js, the single source of truth', () => {
  assert.ok(readme.includes(MOTTO), 'README.md must quote src/motto.js\'s MOTTO verbatim');
});
