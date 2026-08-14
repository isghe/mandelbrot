#!/usr/bin/env bash
# Serves the app as static files on port 8229 (this sandbox's dev port,
# not README's default 8000), using the same dependency-free Node server
# the e2e suite runs (scripts/serve.mjs) instead of python3 -m http.server,
# which repeatedly stalled here.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

node scripts/serve.mjs 8229
