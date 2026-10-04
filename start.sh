#!/bin/sh
# Serves rackplanner-3d at http://localhost:8080 (or the port given as $1).
# The server runs in the foreground in the same process — Ctrl+C (or
# killing the script) stops it, and nothing is left behind.
set -eu
cd "$(dirname "$0")"
PORT="${1:-8080}"
if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "start.sh: need python3 (or python) to serve the site." >&2
  exit 1
fi
echo "Rackplanner 3D → http://localhost:${PORT}/   (Ctrl+C to stop)"
exec "$PY" -m http.server "$PORT" --bind 127.0.0.1
