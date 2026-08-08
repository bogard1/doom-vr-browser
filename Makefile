.DEFAULT_GOAL := help

.PHONY: setup wasm dev build apply-patches diff-patches clean distclean help

setup: ## Init the engine submodule, install the Emscripten SDK, apply engine patches, install web/ deps
	git submodule update --init --recursive
	./scripts/setup.sh
	./scripts/apply-engine-patches.sh
	cd web && npm install

wasm: ## Cross-compile the engine to WebAssembly -> build/wasm/lzdoom.{js,wasm,pk3,...}
	./scripts/build-wasm.sh

dev: ## Build the engine if needed, copy it into web/public/engine, start the Vite dev server
	./scripts/dev.sh

build: wasm ## Production build of the web frontend (implies wasm)
	mkdir -p web/public/engine
	cp build/wasm/lzdoom.js build/wasm/lzdoom.wasm build/wasm/lzdoom.pk3 build/wasm/lz_game_support.pk3 web/public/engine/
	cd web && npm install && npm run build

apply-patches: ## Re-apply patches/engine/*.patch onto a freshly checked-out engine/
	./scripts/apply-engine-patches.sh

diff-patches: ## Regenerate patches/engine/*.patch from the current engine/ working tree
	cd engine && git add -A && git diff --cached > ../patches/engine/0001-emscripten-wasm-port.patch && git reset >/dev/null

clean: ## Remove build output (keeps the Emscripten SDK and node_modules)
	rm -rf build web/public/engine

distclean: clean ## Also remove the Emscripten SDK and web/node_modules
	rm -rf .tools/emsdk web/node_modules

help: ## Show this help
	@echo "Targets:"
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/:.*## /|/' | awk -F'|' '{printf "  %-15s %s\n", $$1, $$2}'
