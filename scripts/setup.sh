#!/usr/bin/env bash
# Installs/activates the Emscripten SDK used by scripts/build-wasm.sh.
# System packages (cmake, ninja) are expected to already be installed
# (e.g. `sudo pacman -S --needed cmake ninja` on Arch, `apt install cmake ninja-build` on Debian/Ubuntu).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMSDK_DIR="${ROOT_DIR}/.tools/emsdk"

if ! command -v cmake >/dev/null 2>&1; then
	echo "error: cmake not found on PATH. Install it first (see comment above)." >&2
	exit 1
fi

if [ ! -d "${EMSDK_DIR}" ]; then
	echo "Cloning emsdk into ${EMSDK_DIR}..."
	git clone https://github.com/emscripten-core/emsdk.git "${EMSDK_DIR}"
fi

cd "${EMSDK_DIR}"
./emsdk install latest
./emsdk activate latest

echo ""
echo "Setup complete. Run scripts/build-wasm.sh to build the engine."
