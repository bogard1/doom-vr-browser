#!/usr/bin/env bash
# Builds the engine (if not already built), copies its output where the
# Vite dev server can serve it, and starts that dev server.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASM_OUT="${ROOT_DIR}/build/wasm"
WEB_ENGINE_DIR="${ROOT_DIR}/web/public/engine"

if [ ! -f "${WASM_OUT}/lzdoom.js" ]; then
	echo "No engine build found, running scripts/build-wasm.sh first..."
	"${ROOT_DIR}/scripts/build-wasm.sh"
fi

mkdir -p "${WEB_ENGINE_DIR}"
cp "${WASM_OUT}/lzdoom.js" "${WASM_OUT}/lzdoom.wasm" "${WASM_OUT}/lzdoom.pk3" "${WEB_ENGINE_DIR}/"

cd "${ROOT_DIR}/web"
if [ ! -d node_modules ]; then
	npm install
fi
npm run dev
