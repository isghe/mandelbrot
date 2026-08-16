// @ts-check
// Reproduces, and takes apart, the native-Windows loopback stall documented in
// playwright.config.js: several concurrent Chromium instances loading the app
// over a real HTTP server on 127.0.0.1 all miss their 30s timeout, while the
// same browsers with every file fulfilled in-process load in ~1.2s.
//
// What each option answers:
//   --mode=processes|pages|clients
//                           processes: N browsers with one page each.
//                           pages: one browser with N pages, same number of
//                             concurrent requests, one process.
//                           clients: no browser at all, N concurrent Node HTTP
//                             clients — the control that says whether plain
//                             loopback concurrency is enough to trigger it.
//   --exe=<path>            launch that binary instead of Playwright's bundled
//                           chrome.exe. A copy of the same binary under another
//                           name tells whether something keys on the executable.
//   --poll                  while the browsers are stalled, a plain Node HTTP
//                           client hits the same URL every 500ms. If it sails
//                           through, the loopback path and the server are fine
//                           and only Chromium's connections are stuck.
//   --trace                 runs the server with SERVE_TRACE set, so the server
//                           side records when it accepts each connection, reads
//                           each request and finishes each response — which says
//                           whether the stall is on the way out or the way back.
//   --netlog                Chromium's own netlog per browser, for aligning
//                           socket events with the server's timestamps.
//   --port=N                serve on this port instead of the default for the
//                           scheme (8123 plain, 8443 TLS).
//   --https                 serve over TLS instead (serve.mjs --tls). Avast's
//                           WFP filters inspect TCP payload at the stream
//                           layer; encrypted payload gives them nothing to
//                           inspect, which is what the suite now relies on.
//
// Usage: node scripts/diag/loopback-stall-probe.mjs [--label=x] [--browsers=4]
//        [--loads=1] [--mode=processes] [--poll] [--trace] [--netlog] [--https]
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PORT = 8123;
const HTTPS_PORT = 8443;
const TARGET = `http://127.0.0.1:${PORT}/index.html`;
const HTTPS_TARGET = `https://127.0.0.1:${HTTPS_PORT}/index.html`;
const GOTO_TIMEOUT = 30000;
// A healthy load is ~1.2s, a stalled one hits the 30s timeout; anything past
// this is a stall whatever it does afterwards.
const STALL_MS = 5000;
const POLL_EVERY_MS = 500;

// The win32 flag set from playwright.config.js, so the browser side of the
// experiment matches the failing test run rather than a simplified one.
const GPU_ARGS = [
  '--no-sandbox',
  '--enable-unsafe-webgpu',
  '--use-angle=d3d11',
  '--disable-dawn-features=use_dxc',
];

const parseArgs = (argv) => {
  const options = {
    label: 'probe', browsers: 4, loads: 1, mode: 'processes', exe: '',
    poll: false, trace: false, netlog: false, https: false, port: 0,
  };
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`unrecognised argument: ${arg}`);
    const [, key, value] = match;
    if (!(key in options)) throw new Error(`unknown option: --${key}`);
    const current = options[key];
    options[key] = typeof current === 'number' ? Number(value)
      : typeof current === 'boolean' ? value !== 'false'
        : value;
  }
  if (!['processes', 'pages', 'clients'].includes(options.mode)) {
    throw new Error(`--mode must be processes, pages or clients, got ${options.mode}`);
  }
  return options;
};

// One plain HTTP GET on its own socket (agent: false, so no keep-alive hides a
// slow connect), reporting where the time went.
const timedGet = (url) => new Promise((resolvePromise) => {
  const started = Date.now();
  const marks = { connected: null, firstByte: null };
  const secure = url.startsWith('https:');
  const get = secure ? httpsGet : httpGet;
  // The probe's certificate is self-signed and thrown away after the run.
  const options = secure ? { agent: false, rejectUnauthorized: false } : { agent: false };
  const request = get(url, options, (response) => {
    marks.firstByte = Date.now() - started;
    response.resume();
    response.on('end', () => resolvePromise({
      ms: Date.now() - started, ...marks, status: response.statusCode, error: null,
    }));
  });
  request.on('socket', (socket) => {
    socket.on('connect', () => { marks.connected = Date.now() - started; });
  });
  request.setTimeout(GOTO_TIMEOUT, () => request.destroy(new Error('client timeout')));
  request.on('error', (error) => resolvePromise({
    ms: Date.now() - started, ...marks, status: null, error: error.message,
  }));
});

class LoopbackStallProbe {
  constructor(options) {
    this.options = options;
    // --port lets scheme and port vary independently: without it, comparing
    // http against https also compares 8123 against 8443, and the port would
    // stay a candidate explanation for any difference.
    const port = options.port || (options.https ? HTTPS_PORT : PORT);
    this.target = `${options.https ? 'https' : 'http'}://127.0.0.1:${port}/index.html`;
    this.serverArgs = options.https
      ? ['scripts/serve.mjs', String(port), '--tls']
      : ['scripts/serve.mjs', String(port)];
    this.stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.outDir = join(REPO, 'scripts', 'diag', 'out', `${options.label}-${this.stamp}`);
    this.serverTrace = join(this.outDir, 'server-trace.log');
    this.server = null;
    this.polls = [];
    this.polling = false;
    this.loads = [];
  }

  log(line) {
    console.log(`[${this.options.label}] ${line}`);
  }

  startServer() {
    const env = { ...process.env };
    if (this.options.trace) env.SERVE_TRACE = this.serverTrace;
    // stdio ignored: the server's access log is not what this measures, and an
    // undrained pipe has been a red herring here before.
    this.server = spawn('node', this.serverArgs, {
      cwd: REPO, stdio: 'ignore', windowsHide: true, env,
    });
  }

  async waitForServer(deadlineMs = 10000) {
    const until = Date.now() + deadlineMs;
    while (Date.now() < until) {
      const { error } = await timedGet(this.target);
      if (!error) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('server did not come up');
  }

  async pollLoop() {
    while (this.polling) {
      const result = await timedGet(this.target);
      this.polls.push(result);
      if (result.error || result.ms >= STALL_MS) {
        this.log(`poll ms=${result.ms} connect=${result.connected} firstByte=${result.firstByte}${result.error ? ` ERROR=${result.error}` : ''}`);
      }
      await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
    }
  }

  browserArgs(index) {
    // The https variant serves a self-signed certificate, which Chromium must
    // be told to accept or it never gets as far as the socket question.
    const base = this.options.https ? [...GPU_ARGS, '--ignore-certificate-errors'] : GPU_ARGS;
    if (!this.options.netlog) return base;
    return [
      ...base,
      `--log-net-log=${join(this.outDir, `netlog-${index}.json`)}`,
      '--net-log-capture-mode=Everything',
    ];
  }

  launch(index) {
    return chromium.launch({
      args: this.browserArgs(index),
      env: { ...process.env, DISPLAY: '' },
      ...(this.options.exe ? { executablePath: this.options.exe } : {}),
    });
  }

  async loadOnce(page, browser, load) {
    const startedAt = Date.now();
    let error = null;
    try {
      await page.goto(this.target, { waitUntil: 'load', timeout: GOTO_TIMEOUT });
    } catch (e) {
      error = e.message.split('\n')[0];
    }
    const record = { browser, load, startedAt, ms: Date.now() - startedAt, error };
    this.loads.push(record);
    this.log(`browser=${browser} load=${load} start=${new Date(startedAt).toISOString()} ms=${record.ms}${error ? ` ERROR=${error}` : ''}`);
  }

  // N browser processes, each loading the page `loads` times in sequence.
  async runProcesses() {
    await Promise.all(Array.from({ length: this.options.browsers }, async (_, index) => {
      const browser = await this.launch(index);
      try {
        for (let load = 0; load < this.options.loads; load++) {
          const page = await browser.newPage();
          await this.loadOnce(page, index, load);
          await page.close();
        }
      } finally {
        await browser.close();
      }
    }));
  }

  // One browser process, N pages loading at the same time: same concurrent
  // request count as runProcesses, one process instead of N.
  async runPages() {
    const browser = await this.launch(0);
    try {
      for (let load = 0; load < this.options.loads; load++) {
        const pages = await Promise.all(
          Array.from({ length: this.options.browsers }, () => browser.newPage()),
        );
        await Promise.all(pages.map((page, index) => this.loadOnce(page, index, load)));
        await Promise.all(pages.map((page) => page.close()));
      }
    } finally {
      await browser.close();
    }
  }

  // No browser in sight: N plain Node clients fetching the same URL at once,
  // `loads` rounds of them. The control for everything the browser modes show.
  async runClients() {
    for (let load = 0; load < this.options.loads; load++) {
      const startedAt = Date.now();
      const results = await Promise.all(
        Array.from({ length: this.options.browsers }, () => timedGet(this.target)),
      );
      results.forEach((result, index) => {
        this.loads.push({ browser: index, load, startedAt, ms: result.ms, error: result.error });
        if (result.error || result.ms >= STALL_MS) {
          this.log(`client=${index} load=${load} ms=${result.ms} connect=${result.connected} firstByte=${result.firstByte}${result.error ? ` ERROR=${result.error}` : ''}`);
        }
      });
    }
  }

  report() {
    const stalled = this.loads.filter((r) => r.error || r.ms >= STALL_MS);
    const healthy = this.loads.filter((r) => !r.error && r.ms < STALL_MS)
      .map((r) => r.ms).sort((a, b) => a - b);
    const median = healthy.length ? healthy[Math.floor(healthy.length / 2)] : null;
    this.log(
      `SUMMARY mode=${this.options.mode} browsers=${this.options.browsers} ` +
      `loads=${this.options.loads} stalled=${stalled.length}/${this.loads.length} ` +
      `median_ok=${median === null ? 'n/a' : `${median}ms`}`,
    );

    if (this.polls.length) {
      const slow = this.polls.filter((p) => p.error || p.ms >= STALL_MS);
      const times = this.polls.map((p) => p.ms).sort((a, b) => a - b);
      this.log(
        `POLL n=${this.polls.length} slow=${slow.length} ` +
        `median=${times[Math.floor(times.length / 2)]}ms max=${times[times.length - 1]}ms`,
      );
    }
    if (this.options.trace) this.log(`server trace: ${this.serverTrace}`);
    if (this.options.netlog) this.log(`netlogs: ${this.outDir}`);
  }

  async run() {
    mkdirSync(this.outDir, { recursive: true });
    this.startServer();
    try {
      await this.waitForServer();
      let pollingDone = null;
      if (this.options.poll) {
        this.polling = true;
        pollingDone = this.pollLoop();
      }
      if (this.options.mode === 'processes') await this.runProcesses();
      else if (this.options.mode === 'pages') await this.runPages();
      else await this.runClients();
      this.polling = false;
      if (pollingDone) await pollingDone;
      this.report();
    } finally {
      this.polling = false;
      this.server?.kill();
    }
  }
}

await new LoopbackStallProbe(parseArgs(process.argv.slice(2))).run();
