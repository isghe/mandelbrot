# WebGPU Mandelbrot / Julia Fractal

[![CI](https://github.com/isghe/mandelbrot/actions/workflows/ci.yml/badge.svg)](https://github.com/isghe/mandelbrot/actions/workflows/ci.yml)

Real-time Mandelbrot and Julia set renderer using the WebGPU API, with double-single
precision arithmetic in the shader for deep zooms (~1e-13/1e-14).

**Live demo:** https://isghe.github.io/mandelbrot/

![Deep zoom example](examples/example.png)

- **Real-time WebGPU rendering** — the whole Mandelbrot/Julia iteration runs on the GPU,
  panning and zooming at interactive framerates.
- **Deep zoom** via double-single precision arithmetic in the shader, pushing past the
  ~1e-7 wall of native `f32` down to ~1e-13/1e-14.
- **Interactive Julia panel** — click anywhere on the Mandelbrot set to pin the
  corresponding Julia set; show it side by side with the Mandelbrot set, or on its own.
- **Shareable view URLs** — copy a link that reproduces the exact view, iterations,
  palette, and mode you're looking at.

  Example: https://isghe.github.io/mandelbrot/?mx=-0.7445137502875607&my=0.16445045543801942&mscale=0.007380653541488702&v=3

  ![Spiral view reached via a shared URL](examples/share-example.png)

More notable views: [examples/examples.md](examples/examples.md)

## Running

Serve the directory over `http://` or `https://` and open `index.html`:

```sh
python -m http.server
```

Then visit `http://localhost:8000/`.

`file://` will not work: the app uses a `type="module"` script with top-level `await`,
and it `fetch()`s the shader source at startup, both of which require an HTTP origin.

Requires a WebGPU-capable browser. Support varies by browser and platform:

- **Chrome / Edge / Brave** (and other Chromium-based browsers) — broadest support,
  enabled by default on desktop (Windows, macOS, ChromeOS, Linux) since 2023; also
  available on Android.
- **Firefox** — supported on Windows since late 2025; other platforms (macOS, Linux) are
  still catching up and may require enabling it manually in `about:config`.
- **Safari** — supported since Safari 18 (2024) on macOS and iOS; coverage is newer and
  some edge cases may behave differently than on Chromium-based browsers.

If the page shows a "WebGPU is not supported" error, try updating your browser or
switching to a recent Chromium-based release (Chrome, Edge, Brave).

At very deep zooms combined with a high iteration count, a single frame can take long
enough to compute that the OS/driver's GPU watchdog (e.g. Windows TDR) kills the device,
which surfaces as a **"WebGPU device lost"** error with a reload prompt. If the adapter
also fails to come back right after reloading ("No WebGPU adapter available"), that's
usually the GPU driver still recovering from the crash — try reloading again after a
minute. Since the URL still points at the same deep zoom/iteration count that caused the
crash, also try **Reset to initial condition** (it works even without a live renderer) to
clear that state before dialing the iteration count back up more gradually.

## Controls

- **☰ button** (top-left) — hide/show the settings panel for an unobstructed view of the
  fractal. Also toggleable with the **H** key.
- **Repo link** (bottom-center) — links back to this GitHub repository.
- **Drag** — pan the view.
- **Click** (without dragging) — set the zoom pivot point, and also set the Julia constant
  (regardless of mode, so it can be picked while still viewing the Mandelbrot set).
- **Scroll wheel** — zoom in/out, centered on the last pivot point.
- **Ctrl+drag** — draw a selection rectangle; releasing recenters and zooms to fit it.
- **Mandelbrot** / **Julia** checkboxes — independently show/hide each panel. Both on
  shows them side by side, each with its own independent pan/zoom; either alone shows
  that panel full-screen; both off is a black screen. The Julia panel always renders the
  set for the current pivot-selected constant.
- **Progressive mode** checkbox — reveal the fractal iteration by iteration instead of
  jumping straight to full quality.
- **Smooth coloring** checkbox (off by default) — continuous escape-time coloring instead
  of the classic per-iteration banded look.
- **Show grid** checkbox (off by default) — overlay a cartesian grid with "nice number"
  spaced gridlines and brighter x=0/y=0 axes.
- **Show center marker** checkbox (off by default) — overlay a crosshair at the current
  view center.
- **Show Julia point marker** checkbox (off by default) — overlay a diamond at the current
  Julia constant, in either mode.
- **Back / Forward** buttons — step through the view history (center, zoom, iterations,
  palette, Julia constant, progressive mode, smooth coloring). Continuous wheel-zoom
  and slider drags each count as a single history step. The grid/marker checkboxes and the
  Mandelbrot/Julia panel-visibility checkboxes above are display preferences, not view
  state, and are not part of this history — panning/zooming the Julia panel independently
  is likewise not undoable.
- **Reset to initial condition** button — restore the default view, iterations, palette,
  Julia constant, progressive mode, smooth coloring, the grid/marker overlay checkboxes
  (unchecked), and panel visibility (Mandelbrot shown, Julia hidden) — even though none of
  these are part of the Back/Forward history. Also clears the Back/Forward history. Note
  this also overwrites the persisted settings below with these defaults, once the next
  render fires.
- Iteration count and zoom level are adjustable via log-scale sliders (for precise control
  at both the low and deep-zoom ends of their range); palette is also adjustable via the
  UI panel.
- **Copy URL** button — copy a link to the clipboard that reproduces the current view,
  iterations, palette, Julia constant, the Julia panel's own independent pan/zoom,
  progressive mode, smooth coloring, grid/marker overlay checkboxes, and Mandelbrot/Julia
  panel visibility. Only fields that differ from the app's built-in defaults are encoded,
  so the address bar also updates live as you interact and collapses back to a bare URL
  after **Reset to initial condition**.

All of the above (view, iterations, palette, Julia constant, the Julia panel's own
pan/zoom, progressive mode, smooth coloring, the grid/marker overlay checkboxes, and
Mandelbrot/Julia panel visibility) is persisted to `localStorage` and restored on the
next page load, so the app reopens where you left it. Settings-panel visibility (the ☰
toggle / **H** key) is a session-only preference and is not persisted.

Opening a URL with share parameters (`?mx=...&my=...&mscale=...&v=3`, etc. — the `v=3`
is required for the current param names to be recognized; older links using the
pre-rename `?x=...&y=...&scale=...` names, with no `v=` at all, still work) always takes
precedence over `localStorage`: any field present in the URL is applied, and any field
*not* present falls back to the app's built-in defaults, not to whatever was previously
saved locally in that browser. In other words, a partial share link is not merged with
your existing local settings — it's applied against a clean slate.

## Testing

The app itself is **vanilla JS with no build step** — `package.json` and the
`devDependencies` below exist only to run the end-to-end test suite during
development; they are not required to run or serve the app (see "Running" above).

```sh
npm install
npm test
```

This runs a [Playwright](https://playwright.dev/) suite (`tests/`) that drives a
real headless browser against the app: pan, wheel-zoom, palette/Julia/progressive/
smooth toggles, the Back/Forward view history, and the grid/marker overlay checkboxes.
It launches Chromium with software rendering flags (SwiftShader) so WebGPU works in
headless/CI environments without a real GPU.

Pure-logic helpers (`src/geometry.js`, `src/precision.js`) also have a fast, browser-free unit
test suite using Node's built-in test runner:

```sh
npm run test:unit
```

`npm run test:all` runs both suites.

## Verification

Commits in this repository are GPG-signed and anchored with
[OpenTimestamps](https://opentimestamps.org/) proofs embedded directly in the commit
objects. The signing key fingerprint is `0F11E7FD 81B2D24A D6C1C75F 8E8FEE26 37C508B1`.

Note: `git log --show-signature` may report some commits as unverified depending on your
local OpenTimestamps tooling/network access (e.g. whether a Bitcoin node is reachable) —
this reflects local verification tooling quirks, not the underlying commit signatures,
which can be confirmed independently via `git cat-file -p <commit>`. This is caused by a
bug in `ots-git-gpg-wrapper`'s handling of Bitcoin RPC connection failures; a fix is
proposed in [opentimestamps-client#166](https://github.com/opentimestamps/opentimestamps-client/pull/166)
and should resolve this once merged upstream.
