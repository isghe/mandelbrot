# WebGPU Mandelbrot / Julia Fractal

Real-time Mandelbrot and Julia set renderer using the WebGPU API, with double-single
precision arithmetic in the shader for deep zooms (~1e-13/1e-14).

**Live demo:** https://isghe.github.io/mandelbrot/

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

- **Drag** — pan the view.
- **Click** (without dragging) — set the zoom pivot point; in Julia mode, also sets the
  Julia constant.
- **Scroll wheel** — zoom in/out, centered on the last pivot point.
- **Ctrl+drag** — draw a selection rectangle; releasing recenters and zooms to fit it.
- **Julia mode** checkbox — switch between the Mandelbrot set and the Julia set for the
  current pivot-selected constant.
- **Progressive mode** checkbox — reveal the fractal iteration by iteration instead of
  jumping straight to full quality.
- **Smooth coloring** checkbox (off by default) — continuous escape-time coloring instead
  of the classic per-iteration banded look.
- **Reset to initial condition** button — restore the default view, iterations, palette,
  Julia mode/constant, progressive mode, and smooth coloring.
- Iteration count and zoom level are adjustable via log-scale sliders (for precise control
  at both the low and deep-zoom ends of their range); palette is also adjustable via the
  UI panel.
