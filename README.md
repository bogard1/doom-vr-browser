# Doom VR (browser)

Run your own legally-owned Doom WAD directly in a browser, compiled to
WebAssembly from a VR-focused GZDoom/LZDoom fork
([QuestZDoom](https://github.com/Team-Beef-Studios/QuestZDoom)). WebXR/VR
support is planned but not built yet — see [Status](#status) below.

The WAD you supply never leaves your browser: it's read into memory
client-side and mounted directly into the WASM module's virtual filesystem.
Nothing is uploaded anywhere.

## Status

- ✅ Engine compiles and runs under Emscripten
- ✅ WAD upload → in-browser gameplay (video, keyboard input, audio)
- ✅ Verified end-to-end in Chrome with a real `DOOM2.WAD`
- 🚧 WebXR / VR controls — not started (see `docs/implementation-plan.md`, M4+)
- ⚠️ Known limitation: in-game renderer-restart (a rarely-used CCMD) doesn't
  work in the browser build; regular gameplay is unaffected

Full architecture notes and the fix log for every Emscripten-porting issue
found along the way live in [`docs/questzdoom-architecture.md`](docs/questzdoom-architecture.md)
and [`docs/implementation-plan.md`](docs/implementation-plan.md).

## Requirements

- **cmake** and **ninja** (e.g. `sudo pacman -S --needed cmake ninja` on
  Arch, `sudo apt install cmake ninja-build` on Debian/Ubuntu, `brew install
  cmake ninja` on macOS)
- **Node.js** + npm (for the web frontend)
- **git**
- A C/C++ toolchain able to build a handful of small native host tools
  (gcc/clang, whatever your OS ships)
- ~2GB free disk space (the Emscripten SDK + build artifacts)
- Your own legally-obtained Doom IWAD (`DOOM.WAD`, `DOOM2.WAD`,
  [Freedoom](https://freedoom.github.io/), etc.) — not included, and never
  will be

The Emscripten SDK itself is installed automatically by `make setup` into
`.tools/emsdk/` (project-local, no sudo, gitignored).

## Quick start

```sh
make setup   # one-time: init the engine submodule, install emsdk, apply patches, npm install
make dev     # build the engine (first run only, ~5-10 min) and start the dev server
```

Then open the printed `http://localhost:5173/` URL, drop in your WAD file,
and click **Start Doom**.

Rebuilding after an `engine/` source change: just re-run `make dev` (it
detects the missing build and reruns `make wasm` automatically), or run
`make wasm` directly.

## Project layout

```
engine/                    git submodule: DrBeef/gzdoom@questzdoom (LZDoom 3.88b)
patches/engine/*.patch     Emscripten-porting fixes applied on top of engine/
platform/emscripten-stub/  (inside engine/) temporary stand-in for QuestZDoom's
                           Android/Oculus-only VR globals -- not the WebXR bridge
web/                       Vite + TypeScript frontend
  src/wad-loader.ts        client-side WAD file handling
  src/engine.ts            loads the WASM module, mounts files, starts the engine
  src/main.ts               UI wiring
scripts/
  setup.sh                 installs the Emscripten SDK
  build-wasm.sh             cross-compiles engine/ -> build/wasm/lzdoom.{js,wasm,pk3}
  dev.sh                    build-wasm.sh + copy output into web/public/ + vite dev
  apply-engine-patches.sh   re-applies patches/engine/*.patch to a fresh engine/ checkout
docs/
  questzdoom-architecture.md   research on the upstream engine's VR architecture
  implementation-plan.md        milestone plan + detailed fix log for every bug found
```

## Other Makefile targets

Run `make help` for the full list. Highlights:

- `make wasm` — cross-compile the engine only, without touching the frontend
- `make build` — production build of the web frontend (`web/dist/`)
- `make diff-patches` — after editing files under `engine/` directly,
  regenerate `patches/engine/*.patch` from the diff
- `make clean` / `make distclean` — remove build output (and, for
  `distclean`, the Emscripten SDK and `node_modules` too)

## Why a submodule + patch files, not a fork?

`engine/` tracks the real upstream `DrBeef/gzdoom` repository at its
`questzdoom` branch, unmodified. All Emscripten-porting changes live as
patch files under `patches/engine/`, applied on top at setup time
(`make apply-patches`, which `make setup` already runs). This keeps the
diff reviewable on its own and the submodule pointer meaningful, instead of
silently diverging from upstream in a fork nobody can diff against.

If you edit files under `engine/` directly during development, run
`make diff-patches` afterward to fold your changes back into the patch
file before committing.

## Troubleshooting

- **No sound**: browsers block audio until a real user gesture happens on
  the page. Clicking "Start Doom" counts; if you scripted/automated the
  click (e.g. in a test), it won't. This is normal browser behavior, not a
  bug.
- **Build fails at the "host tools" step**: the engine's build needs to run
  a few tiny native tools (a parser generator, etc.) *during* the
  cross-compiled build itself. `scripts/build-wasm.sh` builds these
  natively first (`build/host-tools/`) — if this step fails, you're likely
  missing a native C/C++ toolchain, independent of Emscripten.
- **"cmake not found"**: install cmake/ninja via your OS package manager
  first (see [Requirements](#requirements)); `scripts/setup.sh` won't
  install these for you.

## Legal

This project contains **no commercial Doom game data**. You must supply
your own legally-obtained WAD file. It is read entirely client-side and is
never uploaded, cached, or transmitted anywhere.

`engine/` (DrBeef/gzdoom, itself derived from GZDoom/LZDoom/ZDoom) is
licensed under GPLv3 — see `engine/LICENSE` and `engine/docs/licenses/` for
full attribution and third-party license terms.
