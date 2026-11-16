#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
for tool in bin/fly bin/uv go/bin/go; do
  [ -x "$root/.factory-tools/$tool" ] || { echo "Missing pinned workflow tool: $tool; run scripts/install-host-tools.sh during build" >&2; exit 1; }
done
export PATH="$root/.factory-tools/bin:$root/.factory-tools/go/bin:$PATH"
for tool in fly uv go git jq node npm curl python3; do
  command -v "$tool" >/dev/null || { echo "Missing workflow host tool: $tool; run scripts/install-host-tools.sh during build" >&2; exit 1; }
done
fly version
uv --version
go version
if [ "${1:-}" = --check ]; then exit 0; fi
cd "$root"
exec npm run start:workflows
