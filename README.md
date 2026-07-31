# WebGPU Mandelbrot / Julia Fractal

Real-time Mandelbrot and Julia set renderer using the WebGPU API, with double-single
precision arithmetic in the shader for deep zooms (~1e-13/1e-14).

**Live demo:** https://isghe.github.io/mandelbrot/

![Deep zoom example](example.png)

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

## Controls

- **☰ button** (top-left) — hide/show the settings panel for an unobstructed view of the
  fractal. Also toggleable with the **H** key.
- **Drag** — pan the view.
- **Click** (without dragging) — set the zoom pivot point, and also set the Julia constant
  (regardless of mode, so it can be picked while still viewing the Mandelbrot set).
- **Scroll wheel** — zoom in/out, centered on the last pivot point.
- **Ctrl+drag** — draw a selection rectangle; releasing recenters and zooms to fit it.
- **Julia mode** checkbox — switch between the Mandelbrot set and the Julia set for the
  current pivot-selected constant.
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
  palette, Julia mode/constant, progressive mode, smooth coloring). Continuous wheel-zoom
  and slider drags each count as a single history step. The grid/marker checkboxes above
  are display preferences, not view state, and are not part of this history.
- **Reset to initial condition** button — restore the default view, iterations, palette,
  Julia mode/constant, progressive mode, and smooth coloring. Also clears the Back/Forward
  history.
- Iteration count and zoom level are adjustable via log-scale sliders (for precise control
  at both the low and deep-zoom ends of their range); palette is also adjustable via the
  UI panel.

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

Pure-logic helpers (`geometry.js`, `precision.js`) also have a fast, browser-free unit
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
