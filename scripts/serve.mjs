// @ts-check
// Minimal static file server for the repo root, used by playwright.config.js
// (and usable by hand: `node scripts/serve.mjs [port] [--tls]`).
//
// It replaces `python3 -m http.server`, which handles one request at a time:
// with several Playwright workers loading the app at once the requests queue up
// until page.goto times out waiting for the load event — observed on native
// Windows (2026-08-14 17:55:00), where every test failed at 30s while a single browser
// loaded the same page in ~1.1s. linux-serve-page.sh had already moved to a
// Node server for related stalls. Node is already needed to run Playwright, so
// this costs no new dependency.

import { appendFileSync, createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureTestCert } from './make-test-cert.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_PORT = 8123;

// Set SERVE_TRACE to a file path to record when each connection is accepted,
// each request arrives and each response finishes, on the wall clock so the
// lines line up with a client's own timings. It exists for the native Windows
// loopback stall (see playwright.config.js): the browser's page loads time out
// at 30s, and this is what says whether the request ever reached this process.
// Off unless the variable is set, and appended synchronously so nothing is lost
// when the server is killed at the end of a run.
const TRACE_PATH = process.env.SERVE_TRACE;
const trace = TRACE_PATH
  ? (event, detail) => appendFileSync(TRACE_PATH, `${Date.now()} ${new Date().toISOString()} ${event} ${detail}\n`)
  : () => {};

// Only the types this repo actually serves. A generic fallback would not do:
// the browser refuses an ES module that does not arrive as JavaScript.
const CONTENT_TYPES = new Map([
  ['html', 'text/html; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'],
  ['css', 'text/css; charset=utf-8'],
  ['json', 'application/json; charset=utf-8'],
  ['wgsl', 'text/plain; charset=utf-8'],
  ['png', 'image/png'],
  ['svg', 'image/svg+xml'],
  ['ico', 'image/x-icon'],
]);

const contentTypeOf = (path) =>
  CONTENT_TYPES.get(path.split('.').pop()?.toLowerCase() ?? '') ?? 'application/octet-stream';

// Maps a request path to a file inside ROOT, or null if it escapes the repo
// (e.g. /../../etc/passwd) or is not a readable file.
const resolveTarget = async (requestUrl) => {
  const { pathname } = new URL(requestUrl, 'http://localhost');
  const candidate = resolve(join(ROOT, decodeURIComponent(pathname)));
  if (candidate !== ROOT && !candidate.startsWith(ROOT + sep)) return null;

  try {
    const info = await stat(candidate);
    if (!info.isDirectory()) return { path: candidate, size: info.size };
    const index = join(candidate, 'index.html');
    return { path: index, size: (await stat(index)).size };
  } catch {
    return null;
  }
};

const handle = async (req, res) => {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';
  const port = req.socket.remotePort;
  trace('request', `port=${port} ${method} ${url}`);
  res.on('finish', () => trace('response-end', `port=${port} ${url}`));
  const send = (status) => {
    trace('response-head', `port=${port} ${status} ${url}`);
    // Same shape as python3 -m http.server's access log, which the test scripts
    // filter on (they keep the /index.html lines to show each test loaded the app).
    console.log(`${method} ${url} ${status}`);
  };

  if (method !== 'GET' && method !== 'HEAD') {
    send(405);
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }

  const target = await resolveTarget(url);
  if (!target) {
    send(404);
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found\n');
    return;
  }

  send(200);
  res.writeHead(200, {
    'content-type': contentTypeOf(target.path),
    'content-length': String(target.size),
    // The app is edited between runs and its modules are cached aggressively
    // otherwise, which makes a reload silently serve the previous build.
    'cache-control': 'no-store',
  });
  if (method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(target.path).pipe(res);
};

// `--tls` serves the same files over TLS with the throwaway certificate from
// scripts/make-test-cert.mjs. Native Windows needs it: an HTTP content
// inspector there holds plain-text loopback payload for ~10s at a time, which
// is what stalled parallel test workers (playwright.config.js explains it).
// One server rather than a TLS copy of it, so the two transports cannot drift
// apart and a comparison between them stays honest.
const args = process.argv.slice(2);
const tls = args.includes('--tls');
const port = Number(args.find((arg) => !arg.startsWith('--')) ?? DEFAULT_PORT);

const server = tls
  ? createHttpsServer(
    (() => {
      const dir = ensureTestCert();
      return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
    })(),
    handle,
  )
  : createHttpServer(handle);

// The raw socket, before any TLS handshake, so the traced timings mean the same
// thing under both transports.
server.on('connection', (socket) => {
  // Captured now: by the time 'close' fires the socket no longer knows it, and
  // the port is what ties these lines to the client's own view of the run.
  const remotePort = socket.remotePort;
  trace('connection', `port=${remotePort}`);
  socket.on('close', () => trace('connection-close', `port=${remotePort}`));
});

server.listen(port, () => {
  trace('listening', `port=${port}`);
  console.log(`Serving ${ROOT} on ${tls ? 'https' : 'http'}://localhost:${port}/`);
});
