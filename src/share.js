// Bump when the shape of settingsData()/parseShareParams() output changes
// in a way older code can't read. See loadSettingsData() and
// parseShareParams() for the hook points where a migration would go.
//
// v2: `juliaMode` (an exclusive full-screen Julia flag) was replaced by two
// independent panel-visibility flags, `showMandelbrot`/`showJulia`. See the
// v<2 migration branches below for how legacy `julia=1` URLs/localStorage
// map onto the new shape.
//
// v3: renamed fields for clarity/symmetry: `center`/`scale` (the Mandelbrot
// panel's own view, previously unprefixed as if app-global) became
// `mandelbrotPanelCenter`/`mandelbrotPanelScale`, matching the already-
// prefixed `juliaPanelCenter`/`juliaPanelScale`; `juliaC` (the Julia set's
// parameter, easily confused with `juliaPanelCenter`) became `juliaSeed`.
// URL params renamed to match: x/y -> mx/my, scale -> mscale, jx/jy -> sx/sy.
//
// v4: localStorage only (URL params unaffected) — `mandelbrotPanelCenter`/
// `mandelbrotPanelScale` nest under `mandelbrotPanel: { center, scale }`,
// and `juliaPanelCenter`/`juliaPanelScale` under `juliaPanel: { center,
// scale }`. `juliaSeed` stays flat: it's the Julia constant, not a panel's
// own view. loadSettingsData() flattens the nested shape back out so every
// other call site keeps using the flat field names.
const SCHEMA_VERSION = 4;

// Only encodes fields that differ from `initialState`, so the "Reset to
// initial condition" state always maps to a bare URL and the address bar
// only ever names what's actually been changed.
function buildShareUrl(state, initialState, origin, pathname) {
  const init = initialState;
  const params = new URLSearchParams();
  const setIfChanged = (name, current, initial) => {
    if (current !== initial) params.set(name, current);
  };

  if (state.mandelbrotPanelCenter.x !== init.mandelbrotPanelCenter.x || state.mandelbrotPanelCenter.y !== init.mandelbrotPanelCenter.y) {
    params.set("mx", state.mandelbrotPanelCenter.x);
    params.set("my", state.mandelbrotPanelCenter.y);
  }
  if (state.juliaSeed.x !== init.juliaSeed.x || state.juliaSeed.y !== init.juliaSeed.y) {
    params.set("sx", state.juliaSeed.x);
    params.set("sy", state.juliaSeed.y);
  }
  if (state.juliaPanelCenter.x !== init.juliaPanelCenter.x || state.juliaPanelCenter.y !== init.juliaPanelCenter.y) {
    params.set("jpx", state.juliaPanelCenter.x);
    params.set("jpy", state.juliaPanelCenter.y);
  }
  const changedFields = [
    ["iter", "maxIter"],
    ["jscale", "juliaPanelScale"],
    ["palette", "paletteType"],
    ["progressive", "progressiveMode"],
    ["mscale", "mandelbrotPanelScale"],
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

  // v3 renamed x/y -> mx/my, jx/jy -> sx/sy, scale -> mscale; older URLs
  // still use the pre-rename names.
  const [xName, yName] = schemaVersion < 3 ? ["x", "y"] : ["mx", "my"];
  const [sxName, syName] = schemaVersion < 3 ? ["jx", "jy"] : ["sx", "sy"];
  const scaleName = schemaVersion < 3 ? "scale" : "mscale";

  const x = num(xName), y = num(yName);
  if (x !== undefined && y !== undefined) s.mandelbrotPanelCenter = { x, y };
  const sx = num(sxName), sy = num(syName);
  if (sx !== undefined && sy !== undefined) s.juliaSeed = { x: sx, y: sy };
  const jpx = num("jpx"), jpy = num("jpy");
  if (jpx !== undefined && jpy !== undefined) s.juliaPanelCenter = { x: jpx, y: jpy };

  const presentFields = [
    ["centerMarker", "centerMark"],
    ["gridOverlay", "grid"],
    ["juliaMarker", "juliaMark"],
    ["juliaPanelScale", "jscale"],
    ["maxIter", "iter"],
    ["paletteType", "palette"],
    ["progressiveMode", "progressive"],
    ["mandelbrotPanelScale", scaleName],
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
    mandelbrotPanel: {
      center: { x: state.mandelbrotPanelCenter.x, y: state.mandelbrotPanelCenter.y },
      scale: state.mandelbrotPanelScale,
    },
    maxIter: state.maxIter,
    showMandelbrot: state.showMandelbrot,
    showJulia: state.showJulia,
    juliaSeed: { x: state.juliaSeed.x, y: state.juliaSeed.y },
    juliaPanel: {
      center: { x: state.juliaPanelCenter.x, y: state.juliaPanelCenter.y },
      scale: state.juliaPanelScale,
    },
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
  let result = parsed;
  if (v < 2) {
    // Legacy `juliaMode` meant an exclusive full-screen Julia render; map it
    // onto the new independent Mandelbrot/Julia visibility flags.
    const legacyJuliaMode = result.juliaMode;
    result = {
      ...result,
      showJulia: legacyJuliaMode ? 1 : 0,
      showMandelbrot: legacyJuliaMode ? 0 : 1,
    };
  }
  if (v < 3) {
    // `center`/`scale`/`juliaC` were renamed to `mandelbrotPanelCenter`/
    // `mandelbrotPanelScale`/`juliaSeed` (see SCHEMA_VERSION comment above).
    const { center, scale, juliaC, ...rest } = result;
    result = {
      ...rest,
      ...(center !== undefined && { mandelbrotPanelCenter: center }),
      ...(scale !== undefined && { mandelbrotPanelScale: scale }),
      ...(juliaC !== undefined && { juliaSeed: juliaC }),
    };
  }
  if (v >= 4) {
    // v4 nests mandelbrotPanelCenter/mandelbrotPanelScale under
    // mandelbrotPanel, and juliaPanelCenter/juliaPanelScale under
    // juliaPanel (see SCHEMA_VERSION comment above) — flatten back out so
    // every other call site keeps using the pre-v4 flat field names.
    const { mandelbrotPanel, juliaPanel, ...rest } = result;
    result = {
      ...rest,
      ...(mandelbrotPanel && {
        mandelbrotPanelCenter: mandelbrotPanel.center,
        mandelbrotPanelScale: mandelbrotPanel.scale,
      }),
      ...(juliaPanel && {
        juliaPanelCenter: juliaPanel.center,
        juliaPanelScale: juliaPanel.scale,
      }),
    };
  }
  return result;
}

export const share = { buildShareUrl, parseShareParams, settingsData, loadSettingsData, SCHEMA_VERSION };
