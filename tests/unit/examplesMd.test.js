import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../../examples/examples.md', import.meta.url));
const content = readFileSync(path, 'utf8');
const timestamps = [...content.matchAll(/^Pubblicato: (.+)$/gm)].map((m) => m[1]);

test('examples.md has at least one Pubblicato entry', () => {
  assert.ok(timestamps.length > 0);
});

test('examples.md entries are ordered newest-first by Pubblicato timestamp', () => {
  const sorted = [...timestamps].sort().reverse();
  assert.deepStrictEqual(timestamps, sorted, 'Pubblicato: timestamps must be strictly descending top-to-bottom (new entries go at the top)');
});
