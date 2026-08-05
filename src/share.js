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
// scale }`. `juliaSeed` stays flat: it's the Julia seed, not a panel's
// own view. loadSettingsData() flattens the nested shape back out so every
// other call site keeps using the flat field names.
//
// v5: the Julia panel's own quality/look (`maxIter`, `paletteType`,
// `smoothColoring`, `progressiveMode`) and display prefs (`gridOverlay`,
// `centerMarker`) become independent from the Mandelbrot panel's (see the
// dual-panel state-symmetry work — Julia gained its own controls and, in
// Mossa 3, its own undo history). localStorage: these six fields join
// `center`/`scale` inside `mandelbrotPanel{}`/`juliaPanel{}` (nested keys
// stay bare — see below). v<5 data had no independent Julia values, so
// those flat legacy fields are promoted onto *both* panels on migration —
// they used to apply to whichever canvas rendered. URL: new `j`-prefixed
// params (`jiter`/`jpalette`/`jprogressive`/`jsmooth`, plus `jgrid`/
// `jcenterMark`) mirror the existing `jscale` for Julia's own view.
//
// Not a wire-format bump (the nested localStorage keys and the URL param
// names above are untouched): the flat top-level `maxIter`/`paletteType`/
// `progressiveMode`/`smoothColoring`/`gridOverlay`/`centerMarker` names
// this module's flat bridging layer (buildShareUrl/parseShareParams/
// settingsData, and mandelbrot.js's shareState/flattenSnapshotForShare/
// restoreSettings) exposes for the Mandelbrot side were renamed to
// `mandelbrotPanelX`, matching `juliaPanelX`. loadSettingsData() renames
// any surviving bare copies unconditionally at the end, after the v<5/v>=4
// branches above (see the comment there).
//
// v6: URL only (localStorage unaffected) — the six short Mandelbrot URL
// params `iter`/`palette`/`progressive`/`smooth`/`grid`/`centerMark` become
// `miter`/`mpalette`/`mprogressive`/`msmooth`/`mgrid`/`mcenterMark`, mirroring
// the already-prefixed `jiter`/`jpalette`/`jprogressive`/`jsmooth`/`jgrid`/
// `jcenterMark` and matching `mx`/`my`/`mscale`. parseShareParams() gates on
// `schemaVersion < 6` (same idiom as the v3 x/y->mx/my rename) so older
// shared links keep decoding with the bare names.
//
// v7: URL only (localStorage unaffected — it always writes showMandelbrot/
// showJulia explicitly, never defaults them) — the app's own built-in
// default for showJulia changed from 0 to 1 (both panels shown by default,
// split-screen, now that the Julia panel is constructed eagerly rather than
// lazily). buildShareUrl() now only emits `julia` when it's off (mirroring
// `mandelbrot`, only emitted when off), instead of only when on. Absence of
// `julia` in a v<7 URL still means the *old* default (Mandelbrot-only) —
// parseShareParams() gates on `schemaVersion < 7` to fill that in explicitly,
// so links generated before this change keep opening the view they actually
// captured. Absence in a v>=7 URL defers to the app's current default, as
// usual.
const SCHEMA_VERSION = 7;

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
    ["miter", "mandelbrotPanelMaxIter"],
    ["jscale", "juliaPanelScale"],
    ["jiter", "juliaPanelMaxIter"],
    ["mpalette", "mandelbrotPanelPaletteType"],
    ["jpalette", "juliaPanelPaletteType"],
    ["mprogressive", "mandelbrotPanelProgressiveMode"],
    ["jprogressive", "juliaPanelProgressiveMode"],
    ["mscale", "mandelbrotPanelScale"],
    ["msmooth", "mandelbrotPanelSmoothColoring"],
    ["jsmooth", "juliaPanelSmoothColoring"],
  ];
  changedFields.forEach(([name, field]) => setIfChanged(name, state[field], init[field]));
  // Overlay/panel display preferences aren't part of initialState (see the
  // comment on mandelbrot.js's on*Change handlers); Reset always zeroes them
  // back to their built-in defaults (showMandelbrot/showJulia both 1 — split
  // screen — the rest 0), so only their off/on state is ever encoded.
  if (state.mandelbrotPanelGridOverlay) params.set("mgrid", state.mandelbrotPanelGridOverlay);
  if (state.mandelbrotPanelCenterMarker) params.set("mcenterMark", state.mandelbrotPanelCenterMarker);
  if (state.juliaPanelGridOverlay) params.set("jgrid", state.juliaPanelGridOverlay);
  if (state.juliaPanelCenterMarker) params.set("jcenterMark", state.juliaPanelCenterMarker);
  if (state.juliaMarker) params.set("juliaMark", state.juliaMarker);
  if (!state.showMandelbrot) params.set("mandelbrot", 0);
  if (!state.showJulia) params.set("julia", 0);

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
  // v6 renamed the six short Mandelbrot params below to be m-prefixed,
  // mirroring the j-prefixed Julia equivalents; older URLs still use the
  // pre-rename bare names.
  const iterName = schemaVersion < 6 ? "iter" : "miter";
  const paletteName = schemaVersion < 6 ? "palette" : "mpalette";
  const progressiveName = schemaVersion < 6 ? "progressive" : "mprogressive";
  const smoothName = schemaVersion < 6 ? "smooth" : "msmooth";
  const gridName = schemaVersion < 6 ? "grid" : "mgrid";
  const centerMarkName = schemaVersion < 6 ? "centerMark" : "mcenterMark";

  const x = num(xName), y = num(yName);
  if (x !== undefined && y !== undefined) s.mandelbrotPanelCenter = { x, y };
  const sx = num(sxName), sy = num(syName);
  if (sx !== undefined && sy !== undefined) s.juliaSeed = { x: sx, y: sy };
  const jpx = num("jpx"), jpy = num("jpy");
  if (jpx !== undefined && jpy !== undefined) s.juliaPanelCenter = { x: jpx, y: jpy };

  const presentFields = [
    ["mandelbrotPanelCenterMarker", centerMarkName],
    ["mandelbrotPanelGridOverlay", gridName],
    ["juliaPanelCenterMarker", "jcenterMark"],
    ["juliaPanelGridOverlay", "jgrid"],
    ["juliaMarker", "juliaMark"],
    ["juliaPanelScale", "jscale"],
    ["juliaPanelMaxIter", "jiter"],
    ["juliaPanelPaletteType", "jpalette"],
    ["juliaPanelProgressiveMode", "jprogressive"],
    ["juliaPanelSmoothColoring", "jsmooth"],
    ["mandelbrotPanelMaxIter", iterName],
    ["mandelbrotPanelPaletteType", paletteName],
    ["mandelbrotPanelProgressiveMode", progressiveName],
    ["mandelbrotPanelScale", scaleName],
    ["mandelbrotPanelSmoothColoring", smoothName],
  ];
  presentFields.forEach(([field, paramName]) => setIfPresent(field, paramName));

  if (schemaVersion < 2) {
    // Legacy `julia=1` meant an exclusive full-screen Julia render; map it
    // onto the new independent Mandelbrot/Julia visibility flags. Absence of
    // `julia` meant the app's default at the time (Mandelbrot-only) — same
    // v<7 concern as the branch below, fill that in explicitly too (only
    // when this URL carries other real state — see the guard there).
    const legacyJulia = num("julia");
    if (legacyJulia !== undefined) {
      s.showJulia = legacyJulia ? 1 : 0;
      s.showMandelbrot = legacyJulia ? 0 : 1;
    } else if (Object.keys(s).length > 0) {
      s.showMandelbrot = 1;
      s.showJulia = 0;
    }
  } else if (schemaVersion < 7) {
    // v2-v6: absence of `mandelbrot`/`julia` meant the app's default at the
    // time (Mandelbrot-only, showJulia=0) — fill that in explicitly rather
    // than deferring to the app's *current* default (showJulia=1 as of v7),
    // so links generated before v7 keep opening the view they captured.
    // Only when this URL actually carries some real state, though (either
    // field present, or some other field already parsed above) — an
    // incomplete/malformed URL (e.g. `v=3&mx=...` with no `my`) must still
    // resolve to null rather than manufacture visibility state from nothing.
    const mandelbrotParam = num("mandelbrot");
    const juliaParam = num("julia");
    if (mandelbrotParam !== undefined || juliaParam !== undefined || Object.keys(s).length > 0) {
      s.showMandelbrot = mandelbrotParam ?? 1;
      s.showJulia = juliaParam ?? 0;
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
      maxIter: state.mandelbrotPanelMaxIter,
      paletteType: state.mandelbrotPanelPaletteType,
      smoothColoring: state.mandelbrotPanelSmoothColoring,
      progressiveMode: state.mandelbrotPanelProgressiveMode,
      gridOverlay: state.mandelbrotPanelGridOverlay,
      centerMarker: state.mandelbrotPanelCenterMarker,
    },
    showMandelbrot: state.showMandelbrot,
    showJulia: state.showJulia,
    juliaSeed: { x: state.juliaSeed.x, y: state.juliaSeed.y },
    juliaPanel: {
      center: { x: state.juliaPanelCenter.x, y: state.juliaPanelCenter.y },
      scale: state.juliaPanelScale,
      maxIter: state.juliaPanelMaxIter,
      paletteType: state.juliaPanelPaletteType,
      smoothColoring: state.juliaPanelSmoothColoring,
      progressiveMode: state.juliaPanelProgressiveMode,
      gridOverlay: state.juliaPanelGridOverlay,
      centerMarker: state.juliaPanelCenterMarker,
    },
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
  if (v < 5) {
    // Pre-v5, maxIter/paletteType/smoothColoring/progressiveMode/
    // gridOverlay/centerMarker were shared render params applied to
    // whichever canvas rendered — Julia had no independent quality/look of
    // its own yet. Promote them onto juliaPanel*'s own flat field names too,
    // so existing users' preferences carry over onto both panels.
    const legacy = [
      ["maxIter", "juliaPanelMaxIter"],
      ["paletteType", "juliaPanelPaletteType"],
      ["smoothColoring", "juliaPanelSmoothColoring"],
      ["progressiveMode", "juliaPanelProgressiveMode"],
      ["gridOverlay", "juliaPanelGridOverlay"],
      ["centerMarker", "juliaPanelCenterMarker"],
    ];
    const promoted = {};
    legacy.forEach(([srcField, dstField]) => {
      if (result[srcField] !== undefined) promoted[dstField] = result[srcField];
    });
    result = { ...result, ...promoted };
  }
  if (v >= 4) {
    // v4 nests mandelbrotPanelCenter/mandelbrotPanelScale under
    // mandelbrotPanel, and juliaPanelCenter/juliaPanelScale under
    // juliaPanel; v5 adds each panel's own maxIter/paletteType/
    // smoothColoring/progressiveMode/gridOverlay/centerMarker alongside
    // them (see SCHEMA_VERSION comment above) — flatten back out so every
    // other call site keeps using the pre-v4 flat field names. Only fields
    // actually present in the nested object are copied, so v4 data (which
    // nests just center/scale) doesn't clobber the juliaPanel* values the
    // v<5 promotion above just set from the legacy flat fields.
    const flattenPanel = (panel, keyMap) => {
      const out = {};
      if (!panel) return out;
      keyMap.forEach(([srcField, dstField]) => {
        if (panel[srcField] !== undefined) out[dstField] = panel[srcField];
      });
      return out;
    };
    const { mandelbrotPanel, juliaPanel, ...rest } = result;
    result = {
      ...rest,
      ...flattenPanel(mandelbrotPanel, [
        ["center", "mandelbrotPanelCenter"], ["scale", "mandelbrotPanelScale"],
        ["maxIter", "mandelbrotPanelMaxIter"], ["paletteType", "mandelbrotPanelPaletteType"],
        ["smoothColoring", "mandelbrotPanelSmoothColoring"], ["progressiveMode", "mandelbrotPanelProgressiveMode"],
        ["gridOverlay", "mandelbrotPanelGridOverlay"], ["centerMarker", "mandelbrotPanelCenterMarker"],
      ]),
      ...flattenPanel(juliaPanel, [
        ["center", "juliaPanelCenter"], ["scale", "juliaPanelScale"],
        ["maxIter", "juliaPanelMaxIter"], ["paletteType", "juliaPanelPaletteType"],
        ["smoothColoring", "juliaPanelSmoothColoring"], ["progressiveMode", "juliaPanelProgressiveMode"],
        ["gridOverlay", "juliaPanelGridOverlay"], ["centerMarker", "juliaPanelCenterMarker"],
      ]),
    };
  }

  // Not a schema-version migration (the wire format for these six fields
  // never changes — see below): mandelbrot.js's shareState()/
  // flattenSnapshotForShare()/restoreSettings() used to consume these under
  // bare names, matching how they were always written (pre-v5 flat top
  // level, or v5's flattenPanel above producing bare names). They now
  // expect mandelbrotPanelX, matching juliaPanelX's naming. Both branches
  // above already produce mandelbrotPanelX for v>=5 data (via the updated
  // flattenPanel keyMap); this unconditional final step only has bare
  // survivors left to rename for v<5 data, where the fields were never
  // nested (v<4) or where v4 nested just center/scale, not these six
  // (v<5 promotion above reads them by their true bare legacy name, so it
  // must run before this step, which it does).
  const {
    maxIter, paletteType, progressiveMode, smoothColoring, gridOverlay, centerMarker,
    ...withoutBareMandelbrotFields
  } = result;
  result = {
    ...withoutBareMandelbrotFields,
    ...(maxIter !== undefined && { mandelbrotPanelMaxIter: maxIter }),
    ...(paletteType !== undefined && { mandelbrotPanelPaletteType: paletteType }),
    ...(progressiveMode !== undefined && { mandelbrotPanelProgressiveMode: progressiveMode }),
    ...(smoothColoring !== undefined && { mandelbrotPanelSmoothColoring: smoothColoring }),
    ...(gridOverlay !== undefined && { mandelbrotPanelGridOverlay: gridOverlay }),
    ...(centerMarker !== undefined && { mandelbrotPanelCenterMarker: centerMarker }),
  };
  return result;
}

export const share = { buildShareUrl, parseShareParams, settingsData, loadSettingsData, SCHEMA_VERSION };
