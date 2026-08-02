// View-history (Back/Forward) mechanics: two undo/redo stacks plus the
// wheel-zoom debounce, which coalesces a burst of wheel events into a
// single history entry instead of one per tick. `onChange` is called
// whenever a mutation could affect Back/Forward button state, so the
// (DOM-coupled) caller can refresh its own UI without this class knowing
// about buttons.
export class ViewHistory {
  constructor(wheelDebounceMs, onChange) {
    this.past = [];
    this.future = [];
    this.pendingWheelSnapshot = null;
    this.wheelTimer = null;
    this.wheelDebounceMs = wheelDebounceMs;
    this.onChange = onChange;
  }

  get canGoBack() {
    return this.past.length > 0 || !!this.pendingWheelSnapshot;
  }

  get canGoForward() {
    return this.future.length > 0;
  }

  push(snapshot) {
    this.flushPendingWheel();
    this.past.push(snapshot);
    this.future = [];
    this.onChange();
  }

  // Captures `captureSnapshot()` as the pending wheel entry if one isn't
  // already pending, and (re)arms the debounce timer that flushes it into
  // `past`. Returns true only the first time a burst captures a snapshot,
  // matching the one-entry-per-burst coalescing.
  armWheel(captureSnapshot) {
    const isNew = !this.pendingWheelSnapshot;
    if (isNew) {
      this.pendingWheelSnapshot = captureSnapshot();
      this.onChange();
    }
    clearTimeout(this.wheelTimer);
    this.wheelTimer = setTimeout(() => this.flushPendingWheel(), this.wheelDebounceMs);
    return isNew;
  }

  flushPendingWheel() {
    clearTimeout(this.wheelTimer);
    this.wheelTimer = null;
    if (this.pendingWheelSnapshot) {
      const snap = this.pendingWheelSnapshot;
      this.pendingWheelSnapshot = null;
      this.push(snap);
    }
  }

  // Returns the snapshot to restore, or null if there's nothing to go back
  // to. `current` is pushed onto `future` so Forward can return to it.
  back(current) {
    this.flushPendingWheel();
    if (this.past.length === 0) return null;
    const prev = this.past.pop();
    this.future.push(current);
    this.onChange();
    return prev;
  }

  forward(current) {
    this.flushPendingWheel();
    if (this.future.length === 0) return null;
    const next = this.future.pop();
    this.past.push(current);
    this.onChange();
    return next;
  }

  reset() {
    clearTimeout(this.wheelTimer);
    this.wheelTimer = null;
    this.pendingWheelSnapshot = null;
    this.past = [];
    this.future = [];
    this.onChange();
  }
}
