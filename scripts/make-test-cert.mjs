// @ts-check
// Makes the throwaway certificate the test server uses on native Windows, where
// the suite has to run over TLS: an HTTP content inspector there holds
// plain-text loopback payload for ~10s at a time, which is what made parallel
// workers unusable (playwright.config.js explains it, scripts/diag/README.md
// has the measurements). Encrypted payload gives the inspector nothing to read.
//
// Called from playwright.config.js before the web server starts, and by
// `node scripts/serve.mjs <port> --tls` when serving by hand. Regenerates only
// when the certificate is missing or about to expire, so a test run normally
// pays nothing for it.
//
// Usage: node scripts/make-test-cert.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const CERT_DIR = join(ROOT, 'scripts', '.test-cert');
export const KEY_PATH = join(CERT_DIR, 'key.pem');
export const CERT_PATH = join(CERT_DIR, 'cert.pem');

const DAYS = 90;
// Regenerated a day before it expires rather than on the day, so a run started
// just before midnight cannot find itself with a certificate that dies mid-run.
const RENEW_WITHIN_MS = 24 * 60 * 60 * 1000;

// openssl comes with Git for Windows, which is a given here: this path only
// runs on Windows, and the repo is worked on through Git Bash. Checked in the
// order of "whatever is on PATH first, then the known Git location".
const OPENSSL_CANDIDATES = [
  'openssl',
  'C:/Program Files/Git/usr/bin/openssl.exe',
  'C:/Program Files (x86)/Git/usr/bin/openssl.exe',
];

const findOpenssl = () => {
  for (const candidate of OPENSSL_CANDIDATES) {
    try {
      execFileSync(candidate, ['version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // Not this one; try the next.
    }
  }
  throw new Error(
    `no usable openssl found (tried ${OPENSSL_CANDIDATES.join(', ')}). ` +
    'It ships with Git for Windows; install it or put openssl on PATH.',
  );
};

const stillValid = () => {
  if (!existsSync(KEY_PATH) || !existsSync(CERT_PATH)) return false;
  try {
    const { validTo } = new X509Certificate(readFileSync(CERT_PATH));
    return Date.parse(validTo) - Date.now() > RENEW_WITHIN_MS;
  } catch {
    // Unreadable or malformed: treat it as absent and make a new one.
    return false;
  }
};

/**
 * Ensures scripts/.test-cert holds a valid self-signed certificate for
 * localhost, and returns its directory.
 * @returns {string}
 */
export const ensureTestCert = () => {
  if (stillValid()) return CERT_DIR;
  mkdirSync(CERT_DIR, { recursive: true });
  execFileSync(findOpenssl(), [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-days', String(DAYS),
    '-subj', '/CN=localhost',
    // Chromium needs the name it connects to inside the certificate even with
    // --ignore-certificate-errors on some paths, and both forms get used.
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', KEY_PATH,
    '-out', CERT_PATH,
  ], { stdio: 'ignore' });
  return CERT_DIR;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(ensureTestCert());
}
