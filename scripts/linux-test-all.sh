#!/usr/bin/env bash
# Runs the full test suite (unit + e2e), stopping at the first e2e failure
# (--max-failures=1) instead of grinding through the rest, and filtering noisy
# [WebServer] access-log lines from the Playwright output while keeping the
# /index.html ones (useful to confirm each test actually loaded the app).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

time (npm run test:unit \
  && npm test -- --max-failures=1 2>&1 | grep -vP '^\[WebServer\](?!.*index\.html)')
