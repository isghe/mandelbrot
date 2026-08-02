import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ViewHistory } from '../../src/history.js';

function makeHistory(wheelDebounceMs = 250) {
  const changes = [];
  const history = new ViewHistory(wheelDebounceMs, () => changes.push(true));
  return { history, changes };
}

test('a fresh ViewHistory cannot go back or forward', () => {
  const { history } = makeHistory();
  assert.strictEqual(history.canGoBack, false);
  assert.strictEqual(history.canGoForward, false);
});

test('push makes canGoBack true, clears future, and notifies onChange', () => {
  const { history, changes } = makeHistory();
  history.future = ['stale'];
  history.push('snap-1');
  assert.strictEqual(history.canGoBack, true);
  assert.strictEqual(history.canGoForward, false);
  assert.strictEqual(changes.length, 1);
});

test('back returns null and does not notify when there is nothing to go back to', () => {
  const { history, changes } = makeHistory();
  const prev = history.back('current');
  assert.strictEqual(prev, null);
  assert.strictEqual(changes.length, 0);
});

test('back pops the most recent entry and pushes current onto future', () => {
  const { history, changes } = makeHistory();
  history.push('snap-1');
  history.push('snap-2');
  changes.length = 0;

  const prev = history.back('current-view');
  assert.strictEqual(prev, 'snap-2');
  assert.strictEqual(history.canGoBack, true); // snap-1 still in past
  assert.strictEqual(history.canGoForward, true);
  assert.strictEqual(changes.length, 1);

  const prev2 = history.back('snap-2');
  assert.strictEqual(prev2, 'snap-1');
  assert.strictEqual(history.canGoBack, false);
});

test('forward returns null and does not notify when there is nothing to go forward to', () => {
  const { history, changes } = makeHistory();
  const next = history.forward('current');
  assert.strictEqual(next, null);
  assert.strictEqual(changes.length, 0);
});

test('back then forward restores the original entry and re-populates past', () => {
  const { history } = makeHistory();
  history.push('snap-1');
  const prev = history.back('current-view');
  assert.strictEqual(prev, 'snap-1');

  const next = history.forward('snap-1');
  assert.strictEqual(next, 'current-view');
  assert.strictEqual(history.canGoBack, true);
  assert.strictEqual(history.canGoForward, false);
});

test('pushing a new entry clears any redo (future) stack', () => {
  const { history } = makeHistory();
  history.push('snap-1');
  history.back('current-view');
  assert.strictEqual(history.canGoForward, true);

  history.push('snap-2');
  assert.strictEqual(history.canGoForward, false);
});

test('armWheel captures a snapshot only once per burst and reports isNew', () => {
  const { history, changes } = makeHistory();
  let captures = 0;
  const capture = () => {
    captures += 1;
    return `snap-${captures}`;
  };

  const first = history.armWheel(capture);
  assert.strictEqual(first, true);
  assert.strictEqual(captures, 1);
  assert.strictEqual(history.canGoBack, true); // pending counts as "can go back"
  assert.strictEqual(changes.length, 1);

  const second = history.armWheel(capture);
  assert.strictEqual(second, false);
  assert.strictEqual(captures, 1, 'a burst captures only the first snapshot');
  assert.strictEqual(changes.length, 1, 'no extra onChange for subsequent burst ticks');
});

test('a burst of armWheel calls flushes into a single past entry after the debounce', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { history, changes } = makeHistory(250);

  history.armWheel(() => 'snap-1');
  t.mock.timers.tick(100);
  history.armWheel(() => 'snap-should-not-be-used');
  t.mock.timers.tick(100);
  history.armWheel(() => 'snap-should-not-be-used-either');

  assert.strictEqual(history.past.length, 0, 'still debouncing, nothing flushed yet');

  t.mock.timers.tick(250);
  assert.strictEqual(history.past.length, 1);
  assert.strictEqual(history.past[0], 'snap-1');
  assert.strictEqual(history.canGoBack, true);
  assert.strictEqual(history.pendingWheelSnapshot, null);
});

test('back flushes a pending wheel snapshot first, then operates on the resulting past', () => {
  const { history } = makeHistory();
  history.armWheel(() => 'wheel-snap');

  const prev = history.back('current-view');
  assert.strictEqual(prev, 'wheel-snap');
  assert.strictEqual(history.canGoBack, false);
  assert.strictEqual(history.canGoForward, true);
});

test('reset clears past, future, and any pending wheel snapshot, and notifies onChange', () => {
  const { history, changes } = makeHistory();
  history.push('snap-1');
  history.back('current-view');
  history.armWheel(() => 'irrelevant');
  changes.length = 0;

  history.reset();
  assert.strictEqual(history.canGoBack, false);
  assert.strictEqual(history.canGoForward, false);
  assert.strictEqual(history.pendingWheelSnapshot, null);
  assert.strictEqual(changes.length, 1);
});
