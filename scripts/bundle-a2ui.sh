#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# RISC-V: rolldown/lightningcss lack prebuilt binaries; skip A2UI bundling
if [ "$(uname -m)" = "riscv64" ]; then
  echo "Skipping A2UI bundle on riscv64 (rolldown/lightningcss unavailable)" >&2
  exit 0
fi

exec node "$ROOT_DIR/scripts/bundle-a2ui.mjs" "$@"
