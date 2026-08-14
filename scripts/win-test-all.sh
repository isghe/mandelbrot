#!/usr/bin/env bash
# Runs the full test suite (unit + e2e) natively on Windows via Git Bash.
# playwright.config.js detects process.platform === 'win32' and renders through
# the real GPU with --use-angle=d3d11 (SwiftShader has no WebGPU adapter on
# native Windows), so this needs no extra flags beyond linux-test-all.sh.
# Filters noisy [WebServer] access-log lines from the Playwright output while
# keeping the /index.html ones (useful to confirm each test actually loaded the app).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

time npm run test:all 2>&1 | grep -vP '^\[WebServer\](?!.*index\.html)'
