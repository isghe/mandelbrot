import { share } from './share.js';

// Tier 1 (view/history-relevant state) + Tier 2 (display prefs) persistence:
// localStorage save/load, share-URL build/parse, and the snapshot shapes both
// undo history and share.js expect. Each function takes `app` (the
// MandelbrotApp instance) explicitly instead of being a class method reading
// `this`, mirroring share.js's style. applyPanelSnapshot/applySnapshot stayed
// on MandelbrotApp because they drive rendering/panel mutation, not
// serialization; restoreDisplayPrefs stayed because it writes DOM checkboxes
// and triggers layout; updateHistoryButtons is a one-line DOM update not
// worth a module.

// Every field of every model's schema.view, nested per panel, plus the
// app-global juliaSeed — this is undo history's own unit (see ViewHistory)
// and the shape applySnapshot()/restoreSettings() below read back.
function snapshotView(app) {
  const snap = { juliaSeed: app.juliaSeed };
  for (const model of app.models) {
    const panelSnap = {};
    for (const key of Object.keys(model.schema.view)) panelSnap[key] = model.panel[key];
    snap[model.schema.panel] = panelSnap;
  }
  return snap;
}

// Tier 2 ("display preferences"): overlay toggles (per panel) and panel
// visibility — persisted (see shareState() below) but deliberately outside
// undo history, unlike snapshotView()'s Tier 1. juliaMarker/landmarksOverlay
// stay single app-level flags (they mark points on the Mandelbrot plane,
// meaningless on Julia's own view — see drawOverlayForPanel in mandelbrot.js).
function captureDisplayPrefs(app) {
  const prefs = { juliaMarker: app.juliaMarker, landmarksOverlay: app.landmarksOverlay };
  for (const model of app.models) {
    for (const [key, flatName] of Object.entries(model.schema.displayPrefs)) prefs[flatName] = model.panel[key];
    prefs[model.schema.show] = model.show;
  }
  return prefs;
}

// share.js expects this flat shape (schema v5): exactly the union of
// Tier 1 (flattened) and Tier 2 — every field either function above already
// produces, so this is their composition rather than a third hand-written
// copy of the same field list.
function shareState(app) {
  return { ...flattenSnapshotForShare(app, snapshotView(app)), ...captureDisplayPrefs(app) };
}

function saveSettings(app) {
  const data = share.settingsData(shareState(app));
  try {
    localStorage.setItem(app.constructor.SETTINGS_KEY, JSON.stringify(data));
  } catch {
    // localStorage unavailable (private browsing, quota, etc.) — ignore
  }
  history.replaceState(null, '', buildShareUrl(app));
}

function loadSettings(app) {
  try {
    const raw = localStorage.getItem(app.constructor.SETTINGS_KEY);
    return raw ? share.loadSettingsData(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function scheduleSaveSettings(app) {
  clearTimeout(app.saveSettingsTimer);
  app.saveSettingsTimer = setTimeout(() => saveSettings(app), app.constructor.SETTINGS_SAVE_MS);
}

// share.js's buildShareUrl diffs the live shareState() against this same
// flat shape applied to app.initialState (snapshotView()'s nested Tier 1
// shape, used for applySnapshot/Reset) — hence the bridge. Only Tier 1
// fields, deliberately: buildShareUrl diffs these against initialState but
// includes Tier 2 (gridOverlay/centerMarker) unconditionally instead, since
// Reset always zeroes those rather than restoring a captured initial value
// — see shareState()'s call site in buildShareUrl() below.
function flattenSnapshotForShare(app, s) {
  const flat = { juliaSeed: s.juliaSeed };
  for (const model of app.models) {
    const panelSnap = s[model.schema.panel];
    for (const [key, flatName] of Object.entries(model.schema.view)) flat[flatName] = panelSnap[key];
  }
  return flat;
}

// Wraps share.js's own buildShareUrl(state, initialState, origin, pathname)
// — that one takes already-flattened state; this one composes it from `app`
// first. Keep the two distinct: don't rename either, this comment is the
// disambiguation.
function buildShareUrl(app) {
  return share.buildShareUrl(shareState(app), flattenSnapshotForShare(app, app.initialState), location.origin, location.pathname);
}

function restoreSettings(app) {
  const shared = share.parseShareParams(location.search);
  const s = shared || loadSettings(app);
  if (!s) return;

  const restoreNumber = (flatName, target, key) => {
    if (typeof s[flatName] === "number") target[key] = s[flatName];
  };
  const restorePoint = (flatName, target, key) => {
    const p = s[flatName];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) target[key] = new DOMPointReadOnly(p.x, p.y);
  };
  // Driven by each model's own schema (see createModel() in mandelbrot.js)
  // instead of a reverse flat-name lookup: for every logical key the model
  // declares, read s[flatName] and validate/route it by type (POINT_KEYS vs
  // number). juliaSeed/juliaMarker/landmarksOverlay are the only truly flat
  // app-level fields left.
  for (const model of app.models) {
    for (const [key, flatName] of Object.entries(model.schema.view)) {
      (app.constructor.POINT_KEYS.has(key) ? restorePoint : restoreNumber)(flatName, model.panel, key);
    }
    for (const [key, flatName] of Object.entries(model.schema.displayPrefs)) restoreNumber(flatName, model.panel, key);
    restoreNumber(model.schema.show, model, "show");
  }
  restorePoint("juliaSeed", app, "juliaSeed");
  restoreNumber("juliaMarker", app, "juliaMarker");
  restoreNumber("landmarksOverlay", app, "landmarksOverlay");

  for (const model of app.models) model.panel.pivot = model.panel.center;

  if (shared) saveSettings(app);
}

export const settings = {
  snapshotView,
  captureDisplayPrefs,
  shareState,
  flattenSnapshotForShare,
  buildShareUrl,
  saveSettings,
  loadSettings,
  scheduleSaveSettings,
  restoreSettings,
};
