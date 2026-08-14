// @ts-check
// Minimal static file server for the repo root, used by playwright.config.js
// (and usable by hand: `node scripts/serve.mjs [port]`).
//
// It replaces `python3 -m http.server`, which handles one request at a time:
// with several Playwright workers loading the app at once the requests queue up
// until page.goto times out waiting for the load event — observed on native
// Windows (2026-08-14 17:55:00), where every test failed at 30s while a single browser
// loaded the same page in ~1.1s. linux-serve-page.sh had already moved to a
// Node server for related stalls. Node is already needed to run Playwright, so
// this costs no new dependency.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_PORT = 8123;

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

const server = createServer(async (req, res) => {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';
  const send = (status) => {
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
});

const port = Number(process.argv[2] ?? DEFAULT_PORT);
server.listen(port, () => console.log(`Serving ${ROOT} on http://localhost:${port}/`));
