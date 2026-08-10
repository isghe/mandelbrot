#!/usr/bin/env bash
# Serves the app as static files on port 8229 (this sandbox's dev port,
# not README's default 8000) using a Node static server instead of
# python3 -m http.server, which repeatedly stalled here.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

npx --yes http-server -p 8229 -c-1 .
