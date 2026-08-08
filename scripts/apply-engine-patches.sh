#!/usr/bin/env bash
# Applies patches/engine/*.patch on top of a freshly-checked-out engine/
# submodule. Run this after `git submodule update` on a clean checkout,
# before scripts/build-wasm.sh, if engine/ has no local modifications yet.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_DIR="${ROOT_DIR}/engine"
PATCH_DIR="${ROOT_DIR}/patches/engine"

for patch in "${PATCH_DIR}"/*.patch; do
	[ -e "$patch" ] || continue
	echo "Applying $(basename "$patch")..."
	git -C "${ENGINE_DIR}" apply --check "$patch" || {
		echo "Already applied or conflicts with $(basename "$patch"); skipping." >&2
		continue
	}
	git -C "${ENGINE_DIR}" apply "$patch"
done
