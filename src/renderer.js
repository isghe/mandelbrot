// Requests a WebGPU adapter/device, once per app. A single device can
// configure any number of independent canvases (see attachCanvas), so this
// is called once even when the app later drives two canvases (Mandelbrot +
// Julia panels).
//
// `onDeviceLost`/`onUncapturedError` are wired up immediately after device
// creation, before anything else that could throw, so they're live even if
// a later setup step (e.g. shader compilation) fails.
// Returns null if no adapter is available.
export async function requestGPUDevice({ onDeviceLost, onUncapturedError }) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();

  device.lost.then((info) => {
    if (info.reason === "destroyed") return; // torn down intentionally
    onDeviceLost(info);
  });
  device.addEventListener("uncapturederror", (event) => {
    onUncapturedError(event.error.message);
  });

  return device;
}

// Sets up the pipeline/uniforms for one canvas's fractal render pass and
// returns a small `{ render, writePalette }` handle. Throws on setup
// failure (missing WebGPU canvas context, WGSL fetch/compile errors), for
// the caller to catch and report.
export async function attachCanvas(device, canvas, palette256) {
  const context = canvas.getContext("webgpu");
  if (!context) {
    throw new Error("Unable to create the WebGPU canvas context.");
  }
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format });

  const paletteTex = device.createTexture({
    size: [256, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  });
  const writePalette = (data) => {
    device.queue.writeTexture(
      { texture: paletteTex },
      data,
      { bytesPerRow: 256 * 4 },
      { width: 256, height: 1 }
    );
  };
  writePalette(palette256);
  const paletteSampler = device.createSampler({
    magFilter: "linear", minFilter: "linear"
  });

  // WGSL (f32 + double-single center/julia)
  const shaderResponse = await fetch("src/mandelbrot.wgsl", { cache: "no-cache" });
  if (!shaderResponse.ok) {
    throw new Error(`WGSL fetch failed: ${shaderResponse.status}`);
  }
  const shaderCode = await shaderResponse.text();
  const module = device.createShaderModule({ code: shaderCode });

  const compilationInfo = await module.getCompilationInfo();
  const shaderErrors = compilationInfo.messages.filter((message) => message.type === "error");
  if (shaderErrors.length > 0) {
    throw new Error(
      shaderErrors.map((error) => `${error.lineNum}:${error.linePos} ${error.message}`).join("\n")
    );
  }

  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs_main" },
    fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" }
  });

  // Uniform buffer: 14 logical f32 fields + 2 padding floats, since WGSL
  // rounds a uniform struct's size up to a 16-byte multiple (64 B here).
  const uniformBuffer = device.createBuffer({
    size: 16 * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: paletteSampler },
      { binding: 2, resource: paletteTex.createView() }
    ]
  });

  const render = (uniformData) => {
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 }
      }]
    });

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();

    device.queue.submit([encoder.finish()]);
  };

  return { render, writePalette };
}
