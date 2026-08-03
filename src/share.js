// Bump when the shape of settingsData()/parseShareParams() output changes
// in a way older code can't read. See loadSettingsData() and
// parseShareParams() for the hook points where a migration would go.
//
// v2: `juliaMode` (an exclusive full-screen Julia flag) was replaced by two
// independent panel-visibility flags, `showMandelbrot`/`showJulia`. See the
// v<2 migration branches below for how legacy `julia=1` URLs/localStorage
// map onto the new shape.
const SCHEMA_VERSION = 2;

// Only encodes fields that differ from `initialState`, so the "Reset to
// initial condition" state always maps to a bare URL and the address bar
// only ever names what's actually been changed.
function buildShareUrl(state, initialState, origin, pathname) {
  const init = initialState;
  const params = new URLSearchParams();
  const setIfChanged = (name, current, initial) => {
    if (current !== initial) params.set(name, current);
  };

  if (state.center.x !== init.center.x || state.center.y !== init.center.y) {
    params.set("x", state.center.x);
    params.set("y", state.center.y);
  }
  if (state.juliaC.x !== init.juliaC.x || state.juliaC.y !== init.juliaC.y) {
    params.set("jx", state.juliaC.x);
    params.set("jy", state.juliaC.y);
  }
  const changedFields = [
    ["iter", "maxIter"],
    ["palette", "paletteType"],
    ["progressive", "progressiveMode"],
    ["scale", "scale"],
    ["smooth", "smoothColoring"],
  ];
  changedFields.forEach(([name, field]) => setIfChanged(name, state[field], init[field]));
  // Overlay/panel display preferences aren't part of initialState (see the
  // comment on mandelbrot.js's on*Change handlers); Reset always zeroes them
  // (showMandelbrot back to its default of 1, the rest back to 0).
  if (state.gridOverlay) params.set("grid", state.gridOverlay);
  if (state.centerMarker) params.set("centerMark", state.centerMarker);
  if (state.juliaMarker) params.set("juliaMark", state.juliaMarker);
  if (!state.showMandelbrot) params.set("mandelbrot", 0);
  if (state.showJulia) params.set("julia", state.showJulia);

  // `julia`'s meaning changed in v2 (see SCHEMA_VERSION comment above), so
  // any URL that actually encodes state must be stamped with the current
  // version — otherwise parseShareParams would default absent `v` to the
  // legacy (v1) interpretation and misread it. A bare (all-defaults) URL
  // has nothing to misread, so it stays unstamped.
  if (params.toString()) params.set("v", SCHEMA_VERSION);

  const qs = params.toString();
  return `${origin}${pathname}${qs ? "?" + qs : ""}`;
}

function parseShareParams(search) {
  const params = new URLSearchParams(search);
  if ([...params.keys()].length === 0) return null;

  // Absent v means the legacy (pre-versioning) shape, which is schema
  // version 1. An unrecognized future version is rejected outright rather
  // than partially applied.
  const vRaw = params.get("v");
  const schemaVersion = vRaw === null || vRaw === "" ? 1 : Number(vRaw);
  if (!Number.isFinite(schemaVersion) || schemaVersion > SCHEMA_VERSION) return null;
  // Hook for a future migration of legacy param shapes.

  const num = (name) => {
    const raw = params.get(name);
    if (raw === null || raw === "") return undefined;
    const v = Number(raw);
    return Number.isFinite(v) ? v : undefined;
  };

  const s = {};
  const setIfPresent = (field, paramName) => {
    const v = num(paramName);
    if (v !== undefined) s[field] = v;
  };

  const x = num("x"), y = num("y");
  if (x !== undefined && y !== undefined) s.center = { x, y };
  const jx = num("jx"), jy = num("jy");
  if (jx !== undefined && jy !== undefined) s.juliaC = { x: jx, y: jy };

  const presentFields = [
    ["centerMarker", "centerMark"],
    ["gridOverlay", "grid"],
    ["juliaMarker", "juliaMark"],
    ["maxIter", "iter"],
    ["paletteType", "palette"],
    ["progressiveMode", "progressive"],
    ["scale", "scale"],
    ["smoothColoring", "smooth"],
  ];
  presentFields.forEach(([field, paramName]) => setIfPresent(field, paramName));

  if (schemaVersion < 2) {
    // Legacy `julia=1` meant an exclusive full-screen Julia render; map it
    // onto the new independent Mandelbrot/Julia visibility flags.
    const legacyJulia = num("julia");
    if (legacyJulia !== undefined) {
      s.showJulia = legacyJulia ? 1 : 0;
      s.showMandelbrot = legacyJulia ? 0 : 1;
    }
  } else {
    setIfPresent("showMandelbrot", "mandelbrot");
    setIfPresent("showJulia", "julia");
  }

  return Object.keys(s).length > 0 ? s : null;
}

// state -> plain JSON-serializable object, for localStorage persistence.
function settingsData(state) {
  return {
    v: SCHEMA_VERSION,
    center: { x: state.center.x, y: state.center.y },
    scale: state.scale,
    maxIter: state.maxIter,
    showMandelbrot: state.showMandelbrot,
    showJulia: state.showJulia,
    juliaC: { x: state.juliaC.x, y: state.juliaC.y },
    paletteType: state.paletteType,
    progressiveMode: state.progressiveMode,
    smoothColoring: state.smoothColoring,
    gridOverlay: state.gridOverlay,
    centerMarker: state.centerMarker,
    juliaMarker: state.juliaMarker,
  };
}

// Decode side for localStorage: absent `v` means the legacy (pre-versioning)
// shape, which is schema version 1. An unrecognized future version is
// discarded entirely rather than partially applied.
function loadSettingsData(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const v = parsed.v === undefined ? 1 : Number(parsed.v);
  if (!Number.isFinite(v) || v > SCHEMA_VERSION) return null;
  if (v < 2) {
    // Legacy `juliaMode` meant an exclusive full-screen Julia render; map it
    // onto the new independent Mandelbrot/Julia visibility flags.
    const legacyJuliaMode = parsed.juliaMode;
    return {
      ...parsed,
      showJulia: legacyJuliaMode ? 1 : 0,
      showMandelbrot: legacyJuliaMode ? 0 : 1,
    };
  }
  return parsed;
}

export const share = { buildShareUrl, parseShareParams, settingsData, loadSettingsData, SCHEMA_VERSION };
