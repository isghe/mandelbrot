// @ts-check
// The same static file service as scripts/serve.mjs, over TLS with a throwaway
// self-signed certificate. It exists for one question: Avast's WFP filters
// inspect TCP payload at the stream layer, and that inspection is what the
// loopback stall points at — does the stall survive when the payload is
// encrypted and there is nothing to inspect?
//
// Not a replacement for serve.mjs: it is only used by the probe, with a browser
// launched with --ignore-certificate-errors.
//
// Usage: node scripts/diag/serve-https.mjs [port] [certDir]
import { createReadStream, readFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:https';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DEFAULT_PORT = 8443;

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

const TRACE_PATH = process.env.SERVE_TRACE;
const trace = TRACE_PATH
  ? (event, detail) => appendFileSync(TRACE_PATH, `${Date.now()} ${new Date().toISOString()} ${event} ${detail}\n`)
  : () => {};

const resolveTarget = async (requestUrl) => {
  const { pathname } = new URL(requestUrl, 'https://localhost');
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

const port = Number(process.argv[2] ?? DEFAULT_PORT);
const certDir = process.argv[3] ?? join(ROOT, 'scripts', 'diag', 'out', 'cert');

const server = createServer({
  key: readFileSync(join(certDir, 'key.pem')),
  cert: readFileSync(join(certDir, 'cert.pem')),
}, async (req, res) => {
  const url = req.url ?? '/';
  const remote = req.socket.remotePort;
  trace('request', `port=${remote} ${req.method} ${url}`);
  res.on('finish', () => trace('response-end', `port=${remote} ${url}`));

  const target = await resolveTarget(url);
  if (!target) {
    trace('response-head', `port=${remote} 404 ${url}`);
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found\n');
    return;
  }
  trace('response-head', `port=${remote} 200 ${url}`);
  res.writeHead(200, {
    'content-type': contentTypeOf(target.path),
    'content-length': String(target.size),
    'cache-control': 'no-store',
  });
  createReadStream(target.path).pipe(res);
});

// 'connection' is the raw socket, before the TLS handshake: that is the moment
// to compare against, since the plain-HTTP run measures the same thing.
server.on('connection', (socket) => {
  const remote = socket.remotePort;
  trace('connection', `port=${remote}`);
  socket.on('close', () => trace('connection-close', `port=${remote}`));
});

server.listen(port, () => {
  trace('listening', `port=${port}`);
  console.log(`Serving ${ROOT} on https://localhost:${port}/`);
});
