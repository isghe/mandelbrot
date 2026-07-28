# WebGPU Mandelbrot / Julia Fractal

Real-time Mandelbrot and Julia set renderer using the WebGPU API, with double-single
precision arithmetic in the shader for deep zooms (~1e-13/1e-14).

## Running

Serve the directory over `http://` or `https://` and open `mandelbrot.html`:

```sh
python -m http.server
```

Then visit `http://localhost:8000/mandelbrot.html`.

`file://` will not work: the app uses a `type="module"` script with top-level `await`,
and it `fetch()`s the shader source at startup, both of which require an HTTP origin.

Requires a WebGPU-capable browser (recent Chrome or Edge).

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
- **Reset to initial condition** button — restore the default view, iterations, palette,
  Julia mode/constant, and progressive mode.
- Iteration count, zoom level, and palette are also adjustable via the UI panel.
