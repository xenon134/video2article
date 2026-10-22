#!/usr/bin/env bash
# Start the local server, preferring the optional model virtualenv.
set -euo pipefail
cd "$(dirname "$0")"
if [[ -x .venv/bin/python ]]; then
    exec .venv/bin/python server.py "$@"
fi
exec python3 server.py "$@"
