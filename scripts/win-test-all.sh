#!/usr/bin/env bash
# Runs the full test suite (unit + e2e) natively on Windows via Git Bash,
# stopping at the first e2e failure (--max-failures=1) and filtering noisy
# [WebServer] access-log lines while keeping the /index.html ones (useful to
# confirm each test actually loaded the app) — same as linux-test-all.sh.
# playwright.config.js detects process.platform === 'win32' and renders through
# the real GPU with --use-angle=d3d11 (SwiftShader has no WebGPU adapter on
# native Windows), so this needs no extra flags of its own.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

time (npm run test:unit \
  && npm test -- --max-failures=1 2>&1 | grep -vP '^\[WebServer\](?!.*index\.html)')
