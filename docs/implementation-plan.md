# Doom WebXR — Implementation Plan

Companion to [`questzdoom-architecture.md`](./questzdoom-architecture.md).
This plan sequences the work described in the project brief into concrete,
independently-testable milestones. Each milestone lists goal, affected
components, expected technical problems, and acceptance criteria. Work
proceeds strictly in order — do not start a milestone until the previous
one's acceptance criteria are met, per the brief's "incremental only" rule.

Engine baseline for all milestones: `DrBeef/gzdoom@questzdoom`
(LZDoom 3.88b), built from its desktop `CMakeLists.txt` under Emscripten,
`HAVE_VM_JIT=OFF`. Rationale in architecture doc §16.

---

## M0 — Research

**Goal**: Understand QuestZDoom's architecture well enough to plan the rest
of the project without re-deriving it later.

**Affected components**: none (docs only).

**Expected technical problems**: none — this is investigation, not
implementation. Risk is scope creep into "just try building it," which the
brief explicitly forbids at this stage.

**Acceptance criteria**:
- [x] `docs/questzdoom-architecture.md` written, covering engine version,
  build system, Quest-specific code, VR engine changes, rendering/input/
  filesystem/audio/threading architecture, native deps, GL dependencies,
  OS-specific code, dynamic libs, and ranked Emscripten incompatibilities.
- [x] `docs/implementation-plan.md` (this document) written with M0–M10.
- Status: **complete** (this session).

---

## M1 — WASM build

**Goal**: Produce `doomvr.wasm` / `doomvr.js` that links successfully via
Emscripten, with no functional requirement yet (a blank canvas or an
immediate crash after `main()` starts is an acceptable intermediate state).

**Affected components**: `engine/` (vendored/patched LZDoom source),
`CMakeLists.txt` (Emscripten toolchain wiring), `patches/` (diffs against
upstream), `scripts/build-wasm.sh`.

**Expected technical problems** (see architecture doc §15 for detail):
- GL4-only shaders (`#version 400/430 core`) and SSBO dynamic-lights path
  fail to compile against `-s USE_WEBGL2=1`. Likely needs the GL renderer's
  dynamic-lights path temporarily `#ifdef`'d out or stubbed to a UBO
  fallback just to get a first link.
- `asmjit`-based ZScript JIT (`HAVE_VM_JIT`) cannot target WASM — must be
  turned off at CMake configure time.
- `GL_MAP_PERSISTENT_BIT`/`COHERENT_BIT` buffer mapping calls have no
  WebGL2 equivalent — likely to be one of the last remaining link/runtime
  errors after the above two are handled.
- Static-registration-via-linker-sections pattern (`autosegs.h`, used for
  ZScript/DECORATE/action-function registration) may or may not survive
  `wasm-ld`'s section garbage collection unmodified — verify early with a
  minimal smoke test (e.g. confirm a known DECORATE actor registers) rather
  than assuming it works.
- OpenAL: decide shim-vs-WebAudio (architecture doc §16 point 6) — for M1
  audio can be entirely disabled/stubbed; defer the real decision to a later
  milestone once video output works.
- Large MIDI/synth library set (`libraries/`) may be excluded entirely for
  the first build to reduce surface area — re-add incrementally per M1
  sub-steps below, not all at once.

**Suggested sub-steps** (smallest reasonable changes, per brief's rules):
1. `emcmake cmake` configure with everything possible disabled (`HAVE_VM_JIT=OFF`,
   audio off, no threaded renderers, minimal MIDI backends) — get *anything*
   to configure.
2. Fix compile errors file-by-file, documenting each fix's category (stub/
   replace/port/disable) per the brief's debugging rules.
3. Once compiling, fix link errors (GL4/asmjit/buffer-mapping issues above).
4. If the GL4 renderer proves too costly to fix quickly, fall back to
   building `src/swrenderer/` (software renderer) for M1 only, and revisit
   the GL path in M6 (stereo rendering) — this is an explicit, documented
   tradeoff per the brief, not a silent substitution.

**Acceptance criteria**:
- `doomvr.wasm`/`doomvr.js` (or equivalent Emscripten output) produced by
  `scripts/build-wasm.sh` with no manual steps.
- `Module.callMain(["-iwad", "/wads/<file>"])` runs without immediately
  crashing (a JS console error or engine fatal-error message counts as
  partial progress worth committing, as long as it's understood and
  documented — full gameplay is M3's job, not M1's).
- Every Emscripten incompatibility encountered and fixed is documented
  (append to architecture doc or a new `docs/build.md`) with rationale for
  stub/replace/port/disable choice made.

**Status: core milestone reached.** `scripts/setup.sh` + `scripts/build-wasm.sh`
now produce a linking `lzdoom.js`/`lzdoom.wasm` from `engine/` (the real
DrBeef/gzdoom@questzdoom source, not a stub), and running it under Node
prints the real engine banner and reaches `M_LoadDefaults` before blocking in
its main loop (expected with no IWAD/canvas supplied — full canvas rendering
needs Phase 2's browser harness plus a real user-supplied WAD, not yet
attempted). The GL4-only renderer path did **not** need the software-renderer
fallback (sub-step 4) — the actual blockers were narrower than anticipated
and all fixed directly in the GL path; see the fix log below.

Fixes applied (all in `engine/`, uncommitted local changes on top of the
pinned upstream commit — see "Patch tracking" note at the end of this
section):
1. **CMake/toolchain**: `-DCMAKE_POLICY_VERSION_MINIMUM=3.5` (CMake ≥4 rejects
   the engine's `cmake_minimum_required(VERSION 3.1.0)` outright).
2. **Host tools**: built `lemon`/`re2c`/`zipdir`/`gdtoa`'s `arithchk`/`qnan`
   natively first (`build/host-tools`, wired via `-DIMPORT_EXECUTABLES=...`)
   — cross-compiled builds need these to run *during* the build itself
   (parser/lexer generation, pk3 packaging), matching the
   `IMPORT_EXECUTABLES`/`CROSS_EXPORTS` mechanism already in
   `engine/CMakeLists.txt:41-44,466-468`. `tools/lemon/lemon.c` (unmodified
   1990s K&R C) needed `-std=gnu89` to compile under GCC ≥14's stricter
   defaults — host-tool-only, not shipped code.
3. **SDL2**: the engine's custom `cmake/FindSDL2.cmake` can't find Emscripten's
   linker-flag-activated SDL2 port (no real files to `find_path`/`find_library`)
   — added an `EMSCRIPTEN` branch in `src/CMakeLists.txt` that skips
   `find_package(SDL2)` and adds `-sUSE_SDL=2` directly.
4. **`strlwr`**: `src/posix/i_system.h` unconditionally redeclared `strlwr` as
   `static inline`, conflicting with the real, linkable one Emscripten's libc
   already provides via its `compat/string.h` shim — guarded with
   `#ifndef __EMSCRIPTEN__`.
5. **Dead/broken generic-POSIX GL video backend** (the single biggest finding
   this session): `gl_framebuffer.h`/`gl_swframebuffer.h` unconditionally used
   `NoSDLGLFB`/`"glvideo.h"` (`posix/nosdl/`) as the non-Windows GL framebuffer
   base — but `posix/nosdl/` is **never referenced in `src/CMakeLists.txt`'s
   source lists**, i.e. dead code, evidently because this fork only ever
   ships Windows and Android builds. The real, buildable base for an SDL
   window is `SDLGLFB`, declared in `posix/sdl/sdlglvideo.h` — except that
   header (and the sibling `posix/sdl/sdlvideo.h`) had been deleted from the
   tree while `posix/sdl/{sdlglvideo,sdlvideo}.cpp` and `hardware.cpp` still
   `#include` and depend on them (`SDLGLVideo`, `SDLBaseFB`, `SDLFB`,
   `SDLGLFB` — confirmed via `git log` that these classes existed upstream at
   commit `af32edd054` before later GZDoom history replaced them with a
   different, incompatible Cocoa-only header of the same filename). Recreated
   both headers to match what the current `.cpp` files actually implement
   (cross-referenced method-by-method against `sdlglvideo.cpp`/`sdlvideo.cpp`/
   `hardware.cpp`), and repointed `gl_framebuffer.h`/`gl_swframebuffer.h` at
   `SDLGLFB`. **This bug would block a real desktop Linux/SDL build of this
   fork too — it is not Emscripten-specific.**
6. **`gl_load.c` GL extension-proc-address loading**: `IntGetProcAddress` was
   unconditionally `#define`d to the Android-only `MOBILE_GetProcAddress`,
   even though `AppleGLGetProcAddress`/`PosixGetProcAddress` were separately
   defined right above it and never used — another non-Android-build bug.
   Added a proper per-platform chain plus an `__EMSCRIPTEN__` branch that
   returns `NULL` (correct: WebGL2 genuinely lacks the desktop-GL4-era
   extensions this loader is for).
7. **`ES_VERSION_STR`**: `gl_system.h` only defined this (used by *live*,
   runtime-`gl.es`-gated code in `gl_shader.cpp`/`gl_shaderprogram.cpp`/
   `gl_swframebuffer.cpp`, not dead code) under `__MOBILE__`. Added an
   `__EMSCRIPTEN__` branch using `"#version 300 es"` (WebGL2's real GLSL ES
   version — deliberately *not* copying mobile's `310 es`, which assumes
   compute/SSBO support WebGL2 doesn't have).
8. **`fts.h`**: `cmdlib.cpp` included it (BSD directory-tree-walking API, no
   Emscripten equivalent) but calls zero `fts_*` functions — dead include,
   excluded for `__EMSCRIPTEN__` alongside the existing `__sun` exclusion.
9. **QuestZDoom VR globals leaking into core gameplay files**: 13 engine
   files (`g_game.cpp`, `p_user.cpp`, `p_pspr.cpp`, `p_mobj.cpp`,
   `p_interaction.cpp`, `p_teleport.cpp`, `p_setup.cpp`, `v_blend.cpp`,
   `r_utility.cpp`, `g_inventory/a_weapons.cpp`, `g_statusbar/sbar_mugshot.cpp`,
   `fragglescript/t_func.cpp`, `doomstat.h`) `#include <QzDoom/VrCommon.h>` or
   `<QzDoom/VrInput.h>` and/or reference its globals/functions directly
   (`hmdorientation`, `cinemamode*`, `resetDoomYaw`, `weaponStabilised`,
   `snapTurn`, `QzDoom_GetFOV`, `QzDoom_Vibrate`, `VR_HapticEvent`,
   `QzDoom_GetScreenRes`) — confirming the architecture doc's finding that VR
   state is raw globals, not an abstraction, scattered through gameplay code.
   Added `engine/platform/emscripten-stub/QzDoom/{VrCommon.h,VrInput.h}` (a
   trimmed, Android/OVR-SDK-type-free header declaring only what's actually
   referenced, cross-checked file-by-file) plus `vr_stub.cpp` defining inert
   defaults (no VR, zero movement). **This stub is explicitly not the M4+
   WebXR abstraction** — it exists only so M1–M3 compile; M4+ should design
   the real `VRPose`/`VRControllerState` bridge from scratch and this stub
   should then be deleted, not extended.
10. **`OpenXRDeviceMode`/`MonoView` selection**: `Stereo3DMode::getCurrentMode()`
    unconditionally selected `OpenXRDeviceMode` (Android-only, not compiled
    outside Android) with no fallback — guarded with `#ifdef __ANDROID__`,
    falling back to the existing `MonoView` (plain non-stereo rendering,
    exactly what M1–M3 want).
11. **Duplicate `FArgs *Args` / `main`-equivalent**: `d_main.cpp` unconditionally
    defined its own `Args` global and a `VR_DoomMain()` JNI entry point
    (Android's `main()` replacement, called from the QzDoom Android glue) —
    conflicting with `posix/sdl/i_main.cpp`'s own `Args`/`main()`. Guarded with
    `#ifdef __ANDROID__` (would also break a real desktop Linux/Windows build
    of this fork; `win32/i_main.cpp` defines its own `Args` too).
12. **OpenMP / threaded renderers**: passed `-DNO_OPENMP=ON` (already an
    existing, just previously-unused CMake option) — Emscripten's OpenMP
    support needs `-pthread`/shared memory, which conflicts with the
    single-threaded, no-cross-origin-isolation goal from the project brief.
13. **POSIX realtime timers**: `hardware.cpp`'s FPS-limiter used
    `timer_create`/`timer_delete`/`timer_settime` (no Emscripten equivalent);
    excluded via the *already-existing* Apple/OpenBSD no-op fallback branch,
    extended to `__EMSCRIPTEN__`.
14. **OpenAL menu list functions**: `menu/menudef.cpp` unconditionally called
    `I_BuildALDeviceList`/`I_BuildALResamplersList`, but `oalsound.cpp` only
    defines them inside its own `#ifndef NO_OPENAL` block — guarded the call
    sites the same way.
15. **C++ exceptions**: added `-fexceptions` (compile) and matching linker
    flags in `scripts/build-wasm.sh` — ZDoom's own fatal-error path
    (`I_FatalError`/`I_Error`) throws a C++ exception caught by `main()`'s own
    `try`/`catch` (`d_main.cpp`); without `-fexceptions` this exact path (the
    *first* thing that runs when no IWAD is found) hard-aborts the whole
    module instead of printing a clean error and exiting.

**Patch tracking**: all of the above are captured in
`patches/engine/0001-emscripten-wasm-port.patch` (generated from the local
`engine/` submodule edits, applied via `scripts/apply-engine-patches.sh`),
keeping the submodule pointer on a real upstream commit
(`DrBeef/gzdoom@questzdoom`) rather than a fork-specific one. The working
copy under `engine/` currently already has these changes applied directly
(that's what `build-wasm.sh` built and ran above) — the patch file is for
reproducing the same state on a fresh checkout, and for review.

---

## M2 — WAD loader

**Goal**: Get a user-supplied WAD file from a browser file picker/drop zone
into the Emscripten virtual filesystem and passed to the engine as `-iwad`,
regardless of filename.

**Affected components**: `web/src/wad-loader.ts`, `web/src/engine.ts`,
`web/index.html`.

**Expected technical problems**:
- IWAD *type* detection (Doom vs. Doom2 vs. Heretic vs. Freedoom, etc.) is
  normally done by the engine itself scanning the WAD header/lump names
  (`src/d_iwad.cpp`) — confirm this still works when the file is renamed
  arbitrarily and mounted at a path the engine wasn't expecting (should work
  per architecture doc §8, since the engine reads content, not filename, but
  must be verified).
- `FS.mkdirTree`/`FS.writeFile` timing relative to `Module.callMain` —
  filesystem writes must complete before `main()` starts scanning for IWADs.
- Large WAD files (Doom2.wad ~14MB) copied into MEMFS means holding two
  copies in memory (original `ArrayBuffer` + MEMFS copy) — note but don't
  optimize yet per brief's "measure before optimizing" rule.

**Acceptance criteria**:
- User can drag/drop or file-select any legally-obtained IWAD.
- WAD bytes never leave the browser (verify via network tab — zero requests
  containing WAD data).
- Engine correctly identifies IWAD type without requiring a specific
  filename.
- Clear error shown for invalid/non-WAD files rather than a silent hang.

**Status: plumbing done; real-gameplay verification is now an M3 blocker, not
an M2 one.** The WAD-loader pipeline itself (file → FS → callMain) is fully
working end-to-end with a real, user-supplied `DOOM2.WAD` — see M3's status
note below for what was found testing it for real, and the current blocker.

`web/` (Vite + TS, per Phase 2's preferred stack) has
`src/wad-loader.ts` (drag/drop + file-input, validates the IWAD/PWAD magic
client-side before accepting), `src/engine.ts` (loads the ES-module build of
`lzdoom.js`, mounts `lzdoom.pk3` and the user's WAD into MEMFS, calls
`callMain`), `src/debug.ts` (status log), wired up in `src/main.ts`.
`scripts/dev.sh` copies the engine build into `web/public/engine/` and runs
`npm run dev`. Verified end-to-end in a real browser via a synthetic
12-byte placeholder WAD (`IWAD` magic + zero lumps — deliberately *not* any
real game data, just enough to exercise our own plumbing): file selected →
WASM module loaded → `lzdoom.pk3` and the WAD mounted into the virtual FS →
`callMain(["-iwad", "/wads/test.wad"])` → the real engine prints its banner
and reaches `M_LoadDefaults` before hitting an assertion
(`Class != nullptr` in `GetClass`) — expected, since a zero-lump WAD has no
actual game data for ZScript class registration to find. This confirms the
full browser↔WASM↔FS bridge works; M3 needs a real user-supplied WAD to
verify actual gameplay.

One build change was needed to make this work cleanly: `scripts/build-wasm.sh`
now also links with `-sMODULARIZE=1 -sEXPORT_ES6=1
-sEXPORT_NAME=createLzdoomModule -sINVOKE_RUN=0
-sEXPORTED_RUNTIME_METHODS=callMain,FS -sFORCE_FILESYSTEM=1` so `lzdoom.js`
is a proper ES module `engine.ts` can import (instead of Emscripten's default
global-`Module`-variable/script-tag pattern) and doesn't call `main()` until
we've mounted the WAD. Vite's import-analysis plugin still rewrites/rejects a
literal `import("/engine/lzdoom.js")` of a `public/` build artifact even with
`/* @vite-ignore */`; worked around in `engine.ts` by hiding the dynamic
import inside `new Function(...)` so Vite's static scanner never sees it.

---

## M3 — Desktop gameplay

**Goal**: Full non-VR Doom gameplay in a browser canvas: video, keyboard
input, and (best-effort) audio, matching Phase 1/2 of the project brief.

**Affected components**: `web/src/main.ts`, `web/src/engine.ts`,
engine input backend (`src/posix/` or new `src/web/` platform backend).

**Expected technical problems**:
- Emscripten's `-s USE_SDL=2`-style input/video glue vs. this engine's own
  `src/posix/sdl/` backend — need to decide whether to route through SDL2
  (Emscripten has a port of SDL2) or write a minimal new platform backend
  directly against `emscripten_set_main_loop`/canvas/keyboard events,
  mirroring the "external glue + engine main()" pattern the Android port
  already uses (architecture doc §13).
- Frame pacing: `emscripten_set_main_loop` with `simulate_infinite_loop`
  vs. the engine's own timing (`i_time.cpp`) — verify no double-timing bugs
  (e.g. game running at half/double speed).
- Audio: resolve the OpenAL-shim-vs-WebAudio decision deferred from M1.

**Acceptance criteria** (mirrors project brief's Phase 1 criteria exactly):
- Browser loads app, user selects a WAD, WAD stays local, engine starts,
  Doom renders to canvas, keyboard input works, audio works if feasible, no
  VR code involved.
- Playable end-to-end on a desktop browser (Chrome/Firefox) at a stable
  frame rate for a full level.

**Status: in progress, real engine startup got much further than expected,
current blocker identified.** Tested with the user's own `DOOM2.WAD` (2026
08-07/08 session, same day as M1/M2). This surfaced several real engine bugs
beyond the M1 compile/link fixes — all in `engine/`, folded into
`patches/engine/0001-emscripten-wasm-port.patch`:

1. **Silent fatal errors** — `I_ShowFatalError` (`src/posix/sdl/i_system.cpp`)
   had `#ifdef __APPLE__ / #elif __linux__ / #else // ???` — the `#else` did
   *nothing*. Since `D_DoomMain()`'s top-level `catch (const std::exception&)`
   calls exactly this function before setting `ret = -1`, every fatal error
   during startup was completely silent (process just exits) unless run
   under a native-message-box platform. This cost the most debugging time
   this session, by far — added an `__EMSCRIPTEN__` branch that
   `fprintf(stderr, ...)`s the message, which is what finally surfaced every
   other bug below.
2. **A second, deeper linker-section registration bug**: beyond `CReg`
   (M1's `PClass::StaticInit` fix), **`AReg`** (native action functions,
   `DEFINE_ACTION_FUNCTION*`), **`GReg`** (DECORATE properties), **`YReg`**
   (MAPINFO options), and **`FReg`** (native ZScript field/global exports,
   `DEFINE_FIELD*`/`DEFINE_GLOBAL*` — ~50+ call sites) all use the exact same
   broken linker-section-probing trick as CReg (confirmed empirically: same
   symptom, `Head`/`Tail` sentinels adjacent in memory with nothing found
   between them). Fixed all five with one shared mechanism: `autosegs.h` now
   has an `__EMSCRIPTEN__` branch defining `RegListNode`/`RegListHead`/
   `RegListPusher` (an intrusive linked list populated by ordinary global
   constructors, which wasm-ld *does* run reliably, unlike section layout)
   and a matching `FAutoSegIterator` that walks it with the same
   `while (*++probe != nullptr)` call-site interface as before -- zero
   changes needed at any of the 8 *consumer* call sites
   (`dobjtype.cpp`/`d_main.cpp`/`g_mapinfo.cpp`/`thingdef_data.cpp`). The 13
   *producer* macro sites (`_DECLARE_TI` in `dobject.h`; 3
   `DEFINE_ACTION_FUNCTION*` in `vm.h`; 9 `DEFINE_FIELD*`/`DEFINE_GLOBAL*` in
   `vm.h`; 3 property macros in `thingdef.h`; 1 in `g_level.h`) each got a
   small `AREG_REGISTER`/`FREG_REGISTER`/`GREG_REGISTER` helper-macro
   invocation added, guarded the same way. Without this, ZScript compilation
   failed with ~950 "Variable X not found in Actor" errors (every native
   field access) — this is not an Emscripten-only bug; it would affect any
   non-MSVC/non-GCC-with-working-section-merge toolchain.
3. **`OPTIONALWAD` filename mismatch** (`src/version.h`): defined as
   `"game_support.pk3"` for non-Android, but `wadsrc_extra/CMakeLists.txt`'s
   `add_pk3(lz_game_support.pk3 ...)` unconditionally produces
   `lz_game_support.pk3` on every platform. `FIWadManager`'s constructor
   (`d_iwad.cpp`) loads *all* of its `IWADINFO` definitions (the "these lumps
   mean this is Doom2.wad" rules) from `OPTIONALWAD` specifically, not
   `BASEWAD` — so with the wrong name, `FResourceFile::OpenResourceFile`
   silently returned null, `mIWadInfos` stayed empty, and *no* IWAD could
   ever be recognized regardless of its content, with the fatal error
   swallowed per bug #1. Fixed the define to match reality; `engine.ts` now
   also fetches and mounts `lz_game_support.pk3` alongside `lzdoom.pk3`.
4. **Emscripten resource limits**: added `-sALLOW_MEMORY_GROWTH=1
   -sINITIAL_MEMORY=134217728` (ZScript compilation OOM'd against the
   64MB-ish default) and `-sSTACK_SIZE=16777216` (16MB; hit a wasm stack
   overflow at the default 64KB during actor/class initialization) to
   `scripts/build-wasm.sh`'s linker flags.

With all of the above, `DOOM2.WAD` now loads for real: `W_Init` adds
`lzdoom.pk3`/`lz_game_support.pk3`/the WAD (2919 lumps), ZScript/DECORATE
compile cleanly, sound/status-bar/map-info init run, and the browser tab
title changes to `LZDOOM qzd...` (set via `SDL_SetWindowTitle`, i.e.
`SDL_InitSubSystem(SDL_INIT_VIDEO)` succeeded) — confirmed both under Node
(headless, fails later at `_emscripten_get_screen_size` since Node has no
`window.screen`, expected) and in a real Chrome tab via claude-in-chrome.

**Both remaining blockers from the above are now fixed. M3's core goal
(Doom actually rendering and responding to input in a real browser tab) is
done.**

5. **`RangeError: Maximum call stack size exceeded`, root-caused**: genuine
   infinite recursion, not a JS/wasm trampoline artifact. `Gamma`'s own
   `CUSTOM_CVAR` callback (`v_palette.cpp`) does
   `if (screen != NULL) screen->SetGamma(self);`, and both
   `SDLFB::SetGamma` (`posix/sdl/sdlvideo.cpp`) and
   `OpenGLSWFrameBuffer::SetGamma` (`gl_swframebuffer.cpp`) — the two
   *software*-rendering-path framebuffer classes, as opposed to
   `OpenGLFrameBuffer::SetGamma` in `gl_framebuffer.cpp`, which does **not**
   have this bug — did `Gamma = gamma;` as their first line. `FBaseCVar`'s
   callback dispatch (`c_cvars.h`) has no "value unchanged" short-circuit
   and only guards *virtual* CVars against reentrant callbacks (`Flags &
   CVAR_VIRTUAL`, which `Gamma` doesn't have), so that assignment
   unconditionally re-invokes Gamma's own callback, which calls
   `screen->SetGamma()` again, forever. This is a genuine upstream bug (the
   comment in the fix explains why), not Emscripten-specific — it would
   crash identically on any platform that actually exercises the software
   framebuffer path with CVar callbacks enabled. Fixed by deleting the
   self-reassignment in both classes (matching the already-correct
   `OpenGLFrameBuffer` pattern, which only ever *reads* `Gamma`, never
   writes it back).
6. **Native blocking main loop**: even with #5 fixed, `D_DoomLoop`'s
   `for (;;) { ...one tic...; D_Display(); ... }` (`d_main.cpp`) never
   yields to the browser's event loop, so the tab just hangs forever the
   instant the game reaches its main loop -- there is no per-tic
   sleep/delay call to hang an Asyncify port off of, and enabling
   whole-program `-sASYNCIFY=1` to force one in made the tab's renderer
   process **run out of memory and crash outright** (94MB `.wasm`, up from
   57MB, presumably from instrumenting this engine's entire, very large
   call graph — abandoned rather than trying to hand-scope an
   `ASYNCIFY_ONLY` allowlist, which seemed likely to be fragile for a
   codebase this size). Fixed properly instead: factored the loop body out
   into `D_DoomLoopTic()` and, under `__EMSCRIPTEN__`, drive it via a real
   `emscripten_set_main_loop(callback, 0, 1)` instead of the native
   `for (;;)` (non-Emscripten platforms keep the original loop unchanged).
   **Known limitation**: `emscripten_set_main_loop(..., simulate_infinite_loop=1)`
   never returns to its caller by design (that's what lets it replace a
   real infinite loop) — so a CCMD-triggered restart (renderer switch etc.)
   can no longer resume `D_DoomMain_Internal`'s enclosing `do { ... } while
   (1)` the way it used to. For now a restart request just stops the main
   loop with a console message instead of actually restarting; making
   restart work for real (likely: move the do/while's setup logic into the
   restart path and re-register a fresh main loop) is follow-up work, not
   needed to get gameplay rendering.

**Verified working end-to-end in Chrome** (via claude-in-chrome): dropped in
the user's own `DOOM2.WAD`, the canvas renders the real DOOM2 title screen
(logo, "id SOFTWARE" splash) and correctly advances through the
title→credits→demo cycle and back on Enter/Escape keypresses — genuine
interactive rendering, not a static frame. `docs/questzdoom-architecture.md`
and this file should be treated as reflecting a **working desktop (non-VR)
build** as of this fix.

**Audio: verified working, 2026-08-08.** M1 deferred this by building with
`NO_OPENAL=ON`; revisited by actually enabling it. `src/CMakeLists.txt`'s
OpenAL detection had the same `find_package()`-finds-nothing-under-Emscripten
problem as M1's SDL2 fix (§ fix log above) — Emscripten provides OpenAL as a
linker-flag-activated port (`-lopenal`, mapping onto Web Audio) the same way
`-sUSE_SDL=2` provides SDL2, so there's nothing on disk for `find_package`
to locate. Unlike SDL2, though, `-lopenal` alone doesn't make headers
resolve for `oalsound.h`'s plain `#include "al.h"`/`"alc.h"` (quoted, not
`<AL/al.h>`) — pointed those at the `al.h`/`alc.h` this repo already vendors
under `src/sound/thirdparty/` instead (real function prototypes, not the
`AL_NO_PROTOTYPES`/`DYN_OPENAL` function-pointer style that header set also
supports but we don't need, since we're linking directly against
`-lopenal`'s real symbols, `DYN_OPENAL=OFF`). `scripts/build-wasm.sh` now
passes `-DNO_OPENAL=OFF`.

Verified end-to-end in real Chrome: engine console log shows
`I_InitSound: Initializing OpenAL` → `Opened device Emscripten OpenAL`
(the "unsupported OpenAL implementation, install OpenAL Soft" lines right
after are just the engine's generic compatibility-warning heuristic
misfiring on Emscripten's shim identifying itself differently than desktop
OpenAL Soft -- cosmetic, not an error). Confirmed a real `AudioContext` is
created (sample rate 48000Hz) and reaches `state: "running"` -- but **only**
after a genuine user-initiated click; browser autoplay policy correctly
keeps it `"suspended"` for synthetic/automation-dispatched clicks (expected,
standard browser behavior, not a bug in this port). Practical implication
for `web/`: real users clicking "Start Doom" satisfies this automatically
since that's a genuine gesture; no JS-side workaround needed for the normal
flow, but worth remembering if a future *automated* smoke test wants to
assert on audio state.

**Two more real bugs found once audio was actually exercised end-to-end
with a real user (2026-08-08)** — both reported by the user as
`FATAL ERROR: Could not realloc 4294967288 bytes` on a fresh, real Chrome
run (not just my own automation):

1. **Integer overflow in source-count detection**
   (`sound/backend/oalsound.cpp`, `OpenALSoundRenderer`'s constructor).
   `alcGetIntegerv(Device, ALC_MONO_SOURCES/ALC_STEREO_SOURCES, ...)` is
   supposed to report how many audio sources the hardware supports; the
   existing code comment already knew some implementations don't return
   meaningful values here ("At least Apple's OpenAL implementation returns
   zeroes"). Emscripten's OpenAL-over-WebAudio shim goes further and
   reports **both as `INT_MAX`** (there's no real hardware limit to
   report). `numSources = numMono + numStereo` then overflows a 32-bit
   signed int (`INT_MAX + INT_MAX` wraps to `-2`, confirmed via added
   diagnostics), and `Sources.Resize(std::min(numChannels, numSources))`
   interpreted that `-2`-element request as a ~4GB allocation
   (`-2 elements * 4 bytes = -8 bytes`, which as an unsigned `size_t` is
   `4294967288` — matches the error message exactly). Fixed by widening the
   existing `if (0 == numSources)` fallback to `if (numSources <= 0)`,
   catching the overflow case the same way the already-anticipated
   "returns zero" case was handled.
2. **Music streaming needs a thread this build doesn't have.** Once #1 was
   fixed, gameplay init proceeded further and hit
   `D_DoAdvanceDemo() → S_ChangeMusic() → S_CreateStream() →
   OpenALSoundRenderer::CreateStream()`, which lazily spawns one
   `std::thread` (`BackgroundProc`) to feed the streaming/music audio
   buffers. This build has no `-pthread` (that needs SharedArrayBuffer +
   cross-origin-isolation response headers on *every* deployment, which the
   project brief explicitly says to avoid unless actually required), so
   `std::thread`'s constructor throws `std::system_error: thread
   constructor failed: Not supported` — and since nothing in
   `D_DoomLoopTic()`'s catch clauses matches that exception type, it
   propagated all the way up through `TryRunTics()` into the
   `emscripten_set_main_loop` callback and **silently killed every future
   frame** (confirmed: the canvas just stays black forever after, no
   further console output). Fixed by catching `std::system_error` around
   the thread-creation call under `__EMSCRIPTEN__` and returning `NULL`
   (matching `CreateStream`'s existing failure-to-init path) instead of
   letting it escape: **streamed music is unavailable, one-shot sound
   effects (`StartSound`, no thread needed) are unaffected.** Revisiting
   real music support later means either enabling `-pthread` for real (and
   accepting the COOP/COEP deployment requirement) or reworking
   `BackgroundProc`'s feed loop to run without a dedicated thread (e.g.
   polled from the main tic loop) — not done now, since it wasn't blocking
   the actual goal (gameplay working).

Verified via the same real-Chrome flow as before (real click, not
automation): title→credits rendering resumes correctly with both fixes,
console shows no further errors beyond the one pre-existing harmless
`emscripten_set_main_loop_timing` warning.

Remaining loose ends: the ~50 non-fatal `"Unknown property
'sky1'/'cluster'/'music'/etc. found in map definition"` MAPINFO-parser
warnings noted earlier are still unexplained (engine continues past them
without apparent ill effect, but worth checking whether they're the same
registration-mechanism family as this session's other fixes), and whether
sound *effects* (as opposed to music) are actually audible hasn't been
checked yet (only that `OpenALSoundRenderer` initializes and the
`AudioContext` reaches `"running"`).

**Keyboard input fixed, 2026-08-08.** User asked whether keyboard gameplay
should work yet. It didn't: `I_StartTic()` — the function that calls
`SDL_PollEvent` and feeds keyboard/mouse events into `D_PostEvent` — was
never called anywhere in the live tic loop. This is **not** an
Emscripten-specific bug: `git blame` traces the commented-out call in
`NetUpdate()` (`src/d_net.cpp:993`) to commit `c57551034a1`, "Merge
QuestZDoom source into lzdoom mobile" (2021-06-19) — QuestZDoom disabled the
classic desktop SDL input pump because on real Quest hardware input comes
from Oculus VR controllers through a separate Android-side native module
(there is no `VrInput.cpp` implementation in this source tree at all, only
the headers our `platform/emscripten-stub/` currently stubs out). The
title→credits→demo cycling observed in earlier manual testing was the
automatic demo-advance timer, not a response to keypresses — confirmed by
instrumenting `I_GetEvent()` with a temporary `fprintf` and reproducing in a
real Chrome tab via `claude-in-chrome`: before the fix, zero `SDL_PollEvent`
calls ever returned an event (verified two ways — the diagnostic printed
nothing, and the format string itself was dead-stripped from the final
linked `.wasm` by `wasm-ld`, proving the whole code path was unreachable).
Fixed with a one-line uncomment of `I_StartTic();` in `NetUpdate()` (the
`TryRunTics()`-driven path used whenever `singletics` is false, i.e. always
during normal play — the `d_main.cpp` copies of this same commented call
are inside the `singletics` demo/timedemo branch and were left alone).
Verified end-to-end after rebuilding: `SDL_KEYDOWN`/`SDL_KEYUP` (types
`768`/`769`) now appear in the event queue on a real keypress, and pressing
Return for real genuinely advances the title screen to the skill-select
menu. Diagnostic removed before committing; patch regenerated.

**Third `std::thread` crash found + fixed, 2026-08-08.** With keyboard input
working, the user actually started a level for the first time and hit
`Uncaught std::__2::system_error: thread constructor failed: Not supported`
from `DrawerThreads::StartThreads()` (`src/swrenderer/drawers/r_thread.cpp`)
— the software/poly-renderer's multithreaded span/column drawer pool, a
third independent `std::thread` call site (distinct from the OpenAL music
thread fixed earlier). Menu navigation never hit it because 2D menu/title
drawing doesn't route through `DrawerCommandQueue`; the real 3D level scene
does (`swrenderer/scene/r_scene.cpp`, `polyrenderer/poly_renderthread.cpp`).
`r_multithreaded` (the CVar gating this) defaults to `1`, and even
`r_multithreaded == 0` still spawned exactly one real `std::thread` in the
old code — not a true single-threaded fallback. Investigated
`DrawerCommandQueue::Push()` (`r_thread.h`) and found it already has a
genuine thread-free inline-execute branch, taken whenever
`r_multithreaded != 0` is false: `command.Execute(&threads->single_core_thread)`,
no `std::thread` involved. Confirmed `DrawerThreads::Execute()` early-returns
before ever calling `StartThreads()` when the command list is empty, which
it always is once `Push()` stops enqueueing — so forcing the CVar's
*compiled default* to `0` under `__EMSCRIPTEN__` is a complete, root-cause
fix, not a workaround (same smallest-correct-fix pattern as every other fix
this session). No bundled config overrides the default (grepped
`wadsrc*/` — none), and this build's MEMFS mount is fresh every page load,
so no persisted `CVAR_GLOBALCONFIG` value can resurrect `1` across sessions.
Verified in real Chrome: navigated title → new game → skill select → MAP01
loads and renders (visible level geometry, HUD, weapon sprite). The `Up`
arrow "movement" observed in that test turned out to be a false positive —
see the next entry.

**No default WASD/mouse controls exist — found and fixed, 2026-08-08.** User
asked which buttons move/switch weapons/fire. Checking revealed the
apparent movement in the previous test was actually just a nearby animated
lift/gate, not the player: querying the live engine's own console
(`bind`/`bind mouse1`, real Chrome, output mirrors to the browser console
via `Module.print`) showed **zero** keyboard/mouse bindings for
`+forward`/`+back`/`+moveleft`/`+moveright`/`+attack` — only `Space
"+use"` and gamepad-only binds (`RTrigger "+attack"`, `Pad_A "+use"`)
existed. Root cause, found via `git log -p -- wadsrc/static/defbind1.txt`:
commit `2462d71885`, "removed binds that are not used on questzdoom"
(2021-10-12, same QuestZDoom fork, after the merge commit that broke
keyboard input), deleted the entire "modern" WASD+mouse control scheme —
QuestZDoom expects real VR-controller input instead, which doesn't exist in
this browser port. `defbind0.txt`/`defbind2.txt`/`defbind3.txt` (the other
control-scheme presets) were stripped the same way; `defbinds.txt`
(universal, not stripped) only ever had menu/UI/automap binds, never
movement. Fixed by restoring `wadsrc/static/defbind1.txt`'s exact original
content (recovered from the git history of the same file, not invented):
```
w +forward
s +back
a +moveleft
d +moveright
e +jump
x crouch
mouse2 +altattack
mouse3 +speed
mouse1 +attack
```
`k_modern` (which DEFBIND lump loads) defaults to `1`, so this is live by
default. This is a pure data-file change (packed into `lzdoom.pk3` by the
`zipdir` build step) — no C++ recompile needed, `bash scripts/build-wasm.sh`
only re-zipped the pk3. Verified in real Chrome: `w` now visibly walks the
player forward through MAP01 (confirmed against the corrected baseline,
distinct from the earlier lift/gate false positive), and `mouse1` clicks
fire the pistol (ammo counter dropped 50→49 in the HUD). Weapon switching
already worked via the universal `defbinds.txt` binds (number keys `1`-`0`
→ `slot N`, mouse wheel → `weapnext`/`weapprev`) since those were never
stripped. Patch regenerated (1430 lines).

---

## M4 — WebXR session

**Goal**: Detect WebXR support, present an "Enter VR" UI affordance, and
successfully open/close an `immersive-vr` XRSession — no engine integration
yet, per Phase 3 of the brief.

**Affected components**: `web/src/xr.ts`, `web/src/debug.ts`,
`web/index.html`.

**Expected technical problems**:
- Quest Browser's exact `immersive-vr` + `local-floor` reference-space
  support quirks (test on real hardware, not just Chrome desktop's XR
  emulator, which can mask reference-space issues).
- HTTPS requirement for WebXR — dev server must serve over HTTPS (self-signed
  cert or a tool like `mkcert`) even for local Quest Browser testing over
  the LAN.
- `requestAnimationFrame`-vs-`XRSession.requestAnimationFrame` loop
  transition (leaving the Emscripten main loop running while also driving an
  XR frame loop) needs a clear ownership model before M5 adds real data
  flow.

**Acceptance criteria** (from the brief, verbatim):
- Quest Browser detects `immersive-vr` via
  `navigator.xr.isSessionSupported("immersive-vr")`.
- "Enter VR" opens an XR session.
- Head pose can be read (log to debug overlay).
- Controller input sources can be enumerated (log to debug overlay).
- No regression to M3's desktop-mode gameplay.

**Status: implemented 2026-08-08, verified as far as desktop Chrome allows.**
`web/src/xr.ts` is a new, self-contained module — deliberately not wired
into `engine.ts` at all, per "no engine integration yet": it creates its
*own* `<canvas>`/WebGL2 context (`{ xrCompatible: true }`) purely to satisfy
`XRWebGLLayer`'s constructor requirement, entirely separate from the
Emscripten canvas M3 owns, so there's no shared-context/shared-canvas risk.
`main.ts` gained an "Enter VR" button (disabled until
`isImmersiveVRSupported()` resolves) that toggles enter/exit and relabels
itself from the session's own `end` event, independent of whether a WAD is
loaded — matches the brief's framing of this as a standalone capability
check, not gameplay.

Session loop: `requestReferenceSpace("local-floor")` with a `"local"`
fallback (some runtimes don't support floor-relative tracking), then a
`session.requestAnimationFrame` loop that calls `getViewerPose()` and reads
`session.inputSources` — both throttled to ~once/second
(`LOG_EVERY_N_FRAMES = 90`) so the debug panel doesn't scroll at
90-144 lines/sec once eventually running with tracking. Needed adding
`@types/webxr` as a `devDependency` and adding `"webxr"` to `tsconfig.json`'s
`"types"` array (it's excluded from auto-inclusion by the existing
`"types": ["vite/client"]` restriction) — `npx tsc --noEmit` is clean.

Verified in real Chrome (no headset, no WebXR emulator extension
installed): `navigator.xr` exists and `window.isSecureContext` is `true` on
`http://localhost` (Chrome treats localhost as secure — no HTTPS/mkcert
needed for *this* kind of dev testing), but `isSessionSupported("immersive-vr")`
correctly resolves `false`, so the button stays disabled and shows "WebXR
immersive-vr is not supported on this browser/device." — the negative path
works exactly as designed, fails safe, throws nothing. Confirmed zero
regression: WAD drop → Start Doom → real gameplay in MAP01 still works
unchanged after these `main.ts` edits.

**Not yet verified** (needs either real Quest Browser or the WebXR API
Emulator Chrome extension, neither available in this sandboxed browser):
the actual `requestSession("immersive-vr")` → `XRWebGLLayer` →
`getViewerPose()`/`inputSources` positive path. Real-device testing over
LAN will also need HTTPS (self-signed cert / `mkcert`) per the brief's own
risk note — `http://localhost` being secure doesn't extend to
`http://<lan-ip>:5173` from the Quest Browser. Not set up yet; flagged as
the concrete next step before this can be tried on real hardware.

---

## M5 — Head tracking

**Goal**: Feed real HMD orientation (yaw → pitch → roll → position, added
incrementally in that order per the brief) into the engine's camera, with
body yaw and head yaw kept separate, mirroring QuestZDoom's
`doomYaw`/`hmdorientation` split (architecture doc §5).

**Affected components**: new `platform/web/vr_webxr.cpp`/`.h` (VR
abstraction implementation), a new `WebXRDeviceMode : Stereo3DMode` seam
(structurally, even before stereo rendering exists — mono rendering can read
head pose through the same seam), `web/src/xr.ts` (pose extraction and
JS→WASM bridge calls).

**Expected technical problems**:
- Defining the C ABI (`vr_set_head_pose(...)`) and getting quaternion/Euler
  conversions consistent with the engine's internal angle representation
  (fixed-point angles in older Doom code vs. float degrees used by the VR
  code paths — QuestZDoom's `QuatToYawPitchRoll` helper is a direct
  reference).
- Avoiding the "whole player rotates with head" bug explicitly called out in
  the brief — must verify by looking left while walking forward and
  confirming movement direction doesn't follow the head.
- JS↔WASM call overhead if done naively per-property; batch into a single
  call per frame (brief explicitly says not to prematurely optimize, but a
  single struct-passing call vs. a dozen scalar calls is the "smallest
  reasonable" choice, not a premature one).

**Acceptance criteria**:
- In VR, turning your head changes the rendered view direction without
  changing movement direction.
- Body/head yaw separation verified by a manual test: walk forward via
  locomotion input (even keyboard-simulated for this milestone if
  controller locomotion isn't built yet) while turning the head — character
  continues in the original direction.
- Yaw, pitch, and roll all verified working (added incrementally, each
  tested before the next).

**Status: implemented 2026-08-08, verified as far as no-headset/no-emulator
desktop Chrome allows -- real-hardware verification is the user's next step,
not done here.**

New `engine/platform/web/vr_webxr.h`/`.cpp`: a `WebXRDeviceMode : Stereo3DMode`
(mono-only for now, mirroring `MonoView`'s single `EyePose` -- stereo per-eye
rendering is M6) whose `SetUp()` is where the actual work happens. Confirmed
by reading `gl_scene.cpp`'s `RenderViewpoint()` that `R_SetupFrame()` (which
derives `r_viewpoint.Angles` from the player actor's real body angle) always
runs *before* `Stereo3DMode::SetUp()`, so `WebXRDeviceMode::SetUp()` can add
the head-orientation offset straight onto `r_viewpoint.Angles` after the fact
without ever touching the player actor -- body/head separation falls out of
that ordering for free, rather than needing `doomYaw`/`hmdorientation`-style
bookkeeping to keep them in sync.

`Stereo3DMode::getCurrentMode()` (`gl_stereo_cvars.cpp`) gained an
`__EMSCRIPTEN__` branch that switches to `WebXRDeviceMode` while
`WebXR_IsActive()` is true and back to `MonoView` otherwise, so exiting VR
falls straight back to M3's untouched desktop rendering.

Two new `extern "C"` entry points, exported via `-sEXPORTED_FUNCTIONS` and
called from JS through `-sEXPORTED_RUNTIME_METHODS=...,ccall`
(`scripts/build-wasm.sh`):
- `VR_WebXR_SetActive(int)` -- session open/close.
- `VR_WebXR_SetHeadPose(qx,qy,qz,qw, px,py,pz)` -- one call per XR frame with
  the raw `XRRigidTransform` (`web/src/xr.ts`'s `onPose` callback, wired
  through `web/src/engine.ts`'s `setWebXRActive`/`setWebXRHeadPose` from
  `main.ts`, which is the only file that knows both the WebXR session and the
  DoomModule exist -- `xr.ts` itself stays unaware of `ccall`/`DoomModule`,
  same separation-of-concerns M4 established).

Quaternion → yaw/pitch/roll uses the standard YXZ Tait-Bryan extraction
(gimbal-free for the ranges a human neck produces -- the same reason
three.js's `PointerLockControls` picks that Euler order for camera look),
derived analytically rather than copied from QuestZDoom's
`QuatToYawPitchRoll` (that helper lives in `QzDoom_OpenXR.cpp`/`TBXR_Common.cpp`,
outside this submodule and not available in this tree -- see architecture
doc §4). Sign conventions were worked out by reading `src/d_main.cpp`'s
mouse-look handling (`D_PostEvent`): a positive mouse-X turn *decreases*
`Angles.Yaw`, and a positive mouse-Y look *increases* pitch (down); yaw and
roll from the quaternion extraction come out CCW-positive in WebXR's
right-handed space and need negating to match, pitch already matches
directly. **Roll's sign is the least certain of the three** -- Doom has no
native roll input to cross-check against, so if it looks inverted on real
hardware, flip the sign in `vr_webxr.cpp`'s `rollDeg` line; this is exactly
the kind of per-axis check the milestone's staged yaw→pitch→roll plan
anticipated needing real hardware for.

Yaw is recentered on session start (and via a new `vr_recenter` CCMD): the
first head-pose sample after `VR_WebXR_SetActive(1)` is captured as the "look
straight ahead" baseline, so whichever way the player physically faced when
putting on the headset lines up with the body's existing keyboard/mouse
facing direction. Pitch/roll are used as-is, not recentered, since "which way
is down" is gravity-defined, not arbitrary. A basic vertical (stand/crouch)
head-height offset is also applied to `r_viewpoint.Pos.Z`, gated by a new
`vr_webxr_use_position` CVar; horizontal room-scale translation is
deliberately deferred (needs collision-aware handling the map's actual walls
don't know about) -- not required by this milestone's acceptance criteria.

Verified: engine builds clean under Emscripten with the new files/CMake
wiring and the new exported symbols show up in the built `lzdoom.js`; full
M3 regression re-run in real desktop Chrome (drop `DOOM2.WAD`, title →
skill select → MAP01 → move with `w`) shows no behavior change and no new
console errors, confirming the `WebXR_IsActive() == false` default path is
identical to the old hardcoded `MonoView` selection. **Not verified**: any
actual VR rendering/tracking, since no Quest hardware or WebXR emulator
extension is available in this environment -- the yaw/pitch/roll sign
analysis above is analytical, not empirically confirmed. That verification,
plus M4's still-outstanding positive-session-path check, is the user's next
step on real hardware.

**Real-hardware findings, 2026-08-08 (Quest 2, same session)**: entering VR
showed solid black. Root cause: M4/M5 never rendered into the XR session's
own framebuffer at all -- `web/src/xr.ts` created a separate canvas/GL
context purely to read pose data, and never drew anything into it, while
the Emscripten canvas kept rendering mono Doom into a *different* canvas the
headset compositor never reads from. Fixed with an interim (not M6) mirror
renderer: `xr.ts` now blits the Emscripten canvas into both eyes' viewports
as a textured quad every XR frame (identical flat image both eyes, no
per-eye depth -- M6 replaces this with real per-eye rendering straight into
the XR layer). Requires `-sGL_TESTING=1` (`scripts/build-wasm.sh`) so the
Emscripten canvas's WebGL context keeps `preserveDrawingBuffer:true`;
otherwise its backbuffer is undefined by the time the separate XR frame
loop reads it.

Second finding from the same hardware test: the mirrored image was frozen
(and, while frozen, showed corrupted colors/banding -- almost certainly a
transitional frame caught mid-render right as the session opened, then
never replaced because nothing re-rendered afterward). Root cause: `D_DoomLoop()`
(`d_main.cpp`) drives the *entire* engine -- ticking and rendering alike --
via `emscripten_set_main_loop(..., 0, 1)`, which defaults to
`EM_TIMING_RAF` tied to the *window's* `requestAnimationFrame`. Quest
Browser stops delivering that once an immersive session opens (the flat 2D
canvas isn't being displayed anymore), silently freezing the whole engine,
not just its rendering. Fixed in `vr_webxr.cpp`'s `VR_WebXR_SetActive` by
calling `emscripten_set_main_loop_timing(EM_TIMING_SETTIMEOUT, 16)` on VR
session start (wall-clock timer, independent of window rAF) and switching
back to `EM_TIMING_RAF` on exit (normal vsync-paced timing, no wasted CPU
outside VR). Not yet re-verified on hardware -- that's the user's immediate
next step.

---

## M6 — Stereo renderer

**Goal**: Real per-eye stereo rendering via a `WebXRDeviceMode`/
`WebXRDeviceEyePose` pair implemented against the existing
`Stereo3DMode`/`EyePose` seam (architecture doc §5), consuming per-eye pose/
projection/viewport from `XRFrame.getViewerPose(...).views`.

**Affected components**: `platform/web/vr_webxr.cpp`/`.h`, `src/d_main.cpp`,
the hardware GL renderer, `web/src/engine.ts`, `web/src/main.ts`, and
`web/src/xr.ts`.

**Expected technical problems**:
- This is where any GL4/WebGL2 gaps deferred in M1 become blocking for real
  (stereo rendering exercises the renderer far more than M3's desktop mono
  path did) — expect to return to the dynamic-lights/buffer-mapping rework
  here if it wasn't fully resolved earlier.
- Correct per-eye viewport + projection wiring: unlike `vr_ipd` (a CVar in
  the native OpenXR path, architecture doc §5), WebXR's `XRView.transform`
  and `XRView.projectionMatrix` should be used directly and live, per-frame
  — do not hardcode IPD.
- Performance: two renders per frame on Quest 2's mobile GPU is the highest
  perf-risk item in the whole project — instrument frame time (per the
  brief's instrumentation requirement) from this milestone onward.

**Acceptance criteria**:
- Genuine stereoscopic depth perceivable in-headset (not the same
  framebuffer duplicated to both eyes — the brief explicitly calls this out
  as unacceptable).
- Frame time instrumentation in place and visible in a debug overlay.
- Playable (even if rough) on Quest 2 hardware, not just Chrome's WebXR
  emulator.

### Current implementation status (2026-08-08)

M6's direct-rendering implementation is complete in source and ready for
hardware validation:

- `engine.ts` creates the engine's WebGL2 context with `xrCompatible: true`
  before loading Emscripten and supplies it as `preinitializedWebGLContext`.
  `XRWebGLLayer` therefore shares the exact context the hardware renderer
  uses; the former second XR canvas and flat-image mirror have been removed.
- `XRWebGLLayer.framebuffer` is registered by `EM_JS` in
  `platform/web/vr_webxr.cpp` in Emscripten's `GL.framebuffers` table. C++
  treats its handle as borrowed and invalidates it on session end; it never
  deletes the WebXR-owned framebuffer.
- Each `XRFrame` forwards the two views' viewport, viewer-relative eye offset,
  and projection matrix to `WebXRDeviceMode`. The engine's stereo path uses
  those values when rendering the left and right eyes.
- Player sprites are rendered in scene space on a fixed head-relative plane,
  rather than as an independent 2D image in each eye. This gives the weapon
  correct stereo disparity; controller-pose-driven weapon placement remains
  follow-up work for M7.
- The normal Emscripten loop is paused for an immersive session. The WebXR
  animation-frame callback runs exactly one engine tick/render via
  `VR_WebXR_RunFrame`, while the XR framebuffer is valid, then schedules the
  next XR frame. The normal loop resumes when the session ends.
- Doom starts with the hardware renderer from the browser UI, so VR can be
  entered either before or after loading a WAD without trying to switch
  renderers in-process.

`bash scripts/build-wasm.sh`, `npm run build` from `web/`, and
`node scripts/smoke-gl.mjs http://localhost:5173 <path-to-DOOM2.WAD>` pass in
desktop Chromium. The remaining M6 acceptance work requires a Quest or
another real WebXR runtime: confirm both eye views, projection/axis signs,
head tracking, session exit/re-entry, frame time, and playable performance.
Frame-time instrumentation is not implemented yet, so M6 is not complete
until that and the hardware checks pass.

`-sGL_TESTING=1` remains temporarily even though the mirror renderer no longer
uses it. The preinitialized context now requests `preserveDrawingBuffer`
itself; remove the linker flag after direct rendering is validated on hardware.

### Historical pre-implementation investigation (superseded)

The notes below record the failures found while bringing up the WebGL2
renderer before the direct M6 implementation. They are retained for context;
their TODOs and statements about the current wall are no longer current.

**In progress, 2026-08-08 -- much larger than originally scoped, real
findings so far (all reproduced/verified in desktop Chrome, no headset
needed for this part):**

Discovered the actual blocker before writing a single line of stereo code:
`vid_renderer` (`posix/sdl/hardware.cpp`) defaults to **0 = software
renderer**, and `src/swrenderer/` never references `Stereo3DMode` anywhere
-- confirmed via `grep`. That means M5's `WebXRDeviceMode::SetUp()` hook
almost certainly never executed on real hardware either, despite compiling
and linking cleanly; the "enemies moving" observed in the M5 hardware test
was just the game ticking (the freeze fix), not evidence of working head
tracking. M6 needs the hardware GL renderer (`gl_scene.cpp`,
`Stereo3DMode`, per-eye viewports/FBOs are hardware-GL-only concepts), which
had never actually been exercised since M1 -- M1's own scope was "compile
and link only", and M2-M5 all happened to work fine on the software
renderer path instead. This reframes M6 from "add stereo to a working
renderer" to "first get the hardware renderer working under Emscripten at
all, *then* add stereo" -- confirmed by forcing `vid_renderer 1` via a
`+vid_renderer 1` command-line override (`web/src/engine.ts`'s `startDoom`,
temporarily, not committed) and hitting real failures three layers deep so
far:

1. **`FATAL ERROR: Failed to load OpenGL functions.`** --
   `gl/system/gl_load.c`'s `Emscripten_GetProcAddress()` (added during M1)
   unconditionally returned `NULL` for every function name. The intent
   (per its own comment) was only to correctly report GL4-only extensions
   (`ARB_buffer_storage` etc.) as absent under WebGL2, but the exact same
   stub also caught every *required* core function this loader requests
   (every single `gl*` call in this codebase is macro-redirected through
   `_ptrc_gl*` function pointers populated by this loader --
   `#define glClearColor _ptrc_glClearColor` in `gl_load.h`, uniformly, not
   just for extensions). **Fixed**: swapped in Emscripten's real, built-in
   `emscripten_webgl_get_proc_address()` (backed by
   `-sGL_ENABLE_GET_PROC_ADDRESS`, on by default) -- correctly resolves
   real WebGL2/GLES3 functions and returns NULL for genuinely-unavailable
   GL4 extensions. Also had to add `-sMAX_WEBGL_VERSION=2
   -sMIN_WEBGL_VERSION=2` (`scripts/build-wasm.sh`) -- without it Emscripten
   never creates a WebGL2 context regardless of what SDL requests, and this
   renderer needs GL3-era features (UBOs, VAOs) WebGL1 doesn't have.
2. **`TypeError: Cannot read properties of undefined (reading 'version')`**
   inside Emscripten's own `emscriptenWebGLGet` (`GL.currentContext` itself
   undefined at the point `ogl_LoadFunctions()` probes
   `GL_NUM_EXTENSIONS`). `posix/sdl/sdlglvideo.cpp`'s context-creation path
   (non-`__MOBILE__`) defaults to requesting a *desktop* `CORE` profile
   context (`glver` fallback ladder from `{4,5}` down to `{2,0}`) -- not the
   `PROFILE_ES` branch that code already has and that Android/real Quest
   actually uses. **Worked around** (command-line only so far, not yet a
   code fix) by passing `-glversion 3.0 +gl_es 1` to force the existing
   `if (gl_es)` branch (`PROFILE_ES`, matching what real Quest hardware
   requests) instead of the desktop core-profile ladder.
3. **`RuntimeError: null function`** inside
   `OpenGLFrameBuffer::InitializeState()` itself, at the very first basic
   calls (`glClearColor`/`glClearDepth`/`glDepthFunc`/`glEnable`) -- same
   crash address regardless of `-glversion 2.0` vs `3.0`, meaning it isn't
   version-gated. Root cause not yet fixed: Emscripten's
   `emscripten_webgl_get_proc_address()` apparently does not guarantee
   resolving *core* function names either (some GL/EGL implementations
   only guarantee GetProcAddress for extensions, expecting core functions
   to be statically linked instead) -- so fix #1 above was necessary but
   not sufficient. The real fix is architectural, not another one-line
   patch: stop macro-redirecting core GLES3 functions through
   `_ptrc_gl*`/loader indirection at all under `__EMSCRIPTEN__` (they're
   directly-linkable Emscripten C symbols, no runtime loading needed --
   that whole indirection layer exists only because *desktop* GL needs
   `wglGetProcAddress`/`glXGetProcAddress` for anything beyond GL 1.1), and
   reserve the proc-address loader path for the small set of genuinely
   optional GL4 extensions this file also probes. This is a real, if
   mechanical, editing pass over `gl_load.h`'s ~2000 lines of `#define`s,
   not yet started.

Not yet touched at all: the GLSL 400/430 → GLSL ES 300 shader
compatibility gap (architecture doc §6) -- unknown how large this is until
the loader/linking issue above is fully resolved and shaders actually get a
chance to compile. The `if (gl.es)` branches already present in
`gl_shader.cpp` (`ES_VERSION_STR`) are an encouraging sign this may be
smaller than fresh porting work, since QuestZDoom's real Android/Quest
build already exercises a GLES3 shader path in production -- but this is
not yet verified empirically.

None of the above required real Quest hardware -- the hardware GL renderer
fails to even boot in desktop Chrome, so all three bugs were found and (two
of three) fixed there. The temporary `+vid_renderer 1`/`-glversion`/`gl_es`
command-line overrides used to reach each failure were not committed;
`vid_renderer` still defaults to 0 (software) for normal play, unaffected
by any of this work so far.

### Historical handoff notes (2026-08-08, superseded)

This was the pre-implementation handoff. The current M6 status above replaces
its list of remaining work; retain the investigation details only as history.

**Exactly what's committed vs. not, right now:**
- Committed (pushed to `origin/master`) as of this writing: M1-M5, the
  interim WebXR mirror renderer, the WebXR-session main-loop-timing fix,
  the GPLv3 `LICENSE`. See `git log --oneline` for the exact commits.
- **Uncommitted in the working tree** (left this way intentionally so they
  can be reviewed/amended before committing, not because anything is
  broken):
  - `engine/src/gl/system/gl_load.c` -- the `Emscripten_GetProcAddress` fix
    (real fix, safe, doesn't touch the software-renderer default path at
    all -- `ogl_LoadFunctions()` is *only* called from
    `OpenGLFrameBuffer::InitializeState()`, which normal play with
    `vid_renderer 0` never reaches).
  - `scripts/build-wasm.sh` -- adds `-sMAX_WEBGL_VERSION=2
    -sMIN_WEBGL_VERSION=2` (real fix, same safety argument: irrelevant to
    the software renderer, and WebGL2 is a superset of what M4/M5's
    existing rendering needs, so this shouldn't regress anything already
    working).
  - `web/src/xr.ts` -- the small "release the XR canvas's GL context on
    session end" robustness fix from the freeze/tearing investigation
    (unrelated to M6 specifically, just hadn't been committed yet).
  - `patches/engine/0001-emscripten-wasm-port.patch` -- regenerated to
    match the `gl_load.c` change (`git -C engine diff > patches/engine/...`
    after `git -C engine add -A -N .`; see the note on the patch strategy
    at the top of this file's M1 section).
  - `docs/implementation-plan.md` -- this section.
- **NOT present anywhere** (tested via temporary command-line args, then
  explicitly reverted, never committed): the `-glversion 3.0 +gl_es 1`
  workaround for bug #2 above. `web/src/engine.ts`'s `startDoom()` currently
  reads exactly `module.callMain(["-iwad", iwadPath])` -- if you want to
  reproduce bug #2/#3, you need to re-add the extra args yourself (see
  "how to reproduce" below). This was left out of `startDoom()`
  permanently because it's a workaround, not a fix -- the real fix is
  changing `posix/sdl/sdlglvideo.cpp`'s default context-request path so
  desktop/Emscripten builds go through the `PROFILE_ES` branch without
  needing a CVar/CLI override (see TODO list below).

**How to reproduce every failure above, from scratch, in desktop Chrome
(no headset needed):**
1. Build: `bash scripts/build-wasm.sh` (picks up whatever's currently in
   `engine/gl_load.c` and `scripts/build-wasm.sh` -- both already have the
   two committed-to-working-tree fixes applied as of this writeup).
2. Copy build output + a WAD into `web/public/`: see `scripts/dev.sh` for
   the exact file list, or just `cp build/wasm/lzdoom.{js,wasm,pk3}
   build/wasm/lz_game_support.pk3 web/public/engine/` and drop a WAD at
   `web/public/DOOM2.WAD` for same-origin `fetch()` in a quick manual test
   (cross-origin `fetch` of a file:// or different-port WAD hits CORS —
   same-origin under `web/public/` is the simplest way around that when
   scripting a WAD "drop" via `DragEvent`/`DataTransfer` instead of a real
   file picker).
3. Temporarily edit `web/src/engine.ts`'s `startDoom()`:
   `module.callMain(["-iwad", iwadPath, "-glversion", "3.0", "+gl_es", "1",
   "+vid_renderer", "1"])` -- reproduces bug #3 (the current wall) with
   today's code. Drop the `-glversion`/`gl_es` args to reproduce bug #2
   instead (desktop core-profile path, `GL.currentContext` undefined).
   Drop the `gl_load.c` fix too (revert it) to reproduce bug #1 from
   scratch.
4. `npm run dev` in `web/`, load the page, drop/select a WAD, click "Start
   Doom". Watch the browser console -- but note **the error surfaces as a
   caught JS exception that `web/src/main.ts`'s `catch` block reduces to
   just `err.message`**, losing the stack trace. To get the full stack
   (essential for narrowing down *which* GL call/line failed), either
   temporarily add `console.error(err)` in that catch block (there are
   three near-identical catch blocks in `main.ts`; the one in the
   "Start Doom" button handler is the relevant one), or register
   `window.addEventListener('error', e => console.log(e.error?.stack))`
   before triggering, and read it back afterward. Don't leave either of
   these committed -- they're diagnostic-only.

**Prioritized TODO to actually finish M6, in the order that makes sense to
attempt them (each one is a real, separate unit of work -- don't attempt
to skip ahead):**
1. **Make `PROFILE_ES` the default under `__EMSCRIPTEN__`** in
   `engine/src/posix/sdl/sdlglvideo.cpp`'s context-attribute-setup function
   (~line 341-360) -- add an `#elif defined(__EMSCRIPTEN__)` branch
   alongside the existing `#ifdef __MOBILE__` one, requesting
   `SDL_GL_CONTEXT_PROFILE_ES` with a sensible major/minor (3.0 matches
   what reproduced furthest above) unconditionally, rather than relying on
   the `-glversion`/`+gl_es` CLI workaround. This turns bug #2's workaround
   into a real fix and is a prerequisite for bug #3's fix to even be
   testable without hand-typed CLI args every time.
2. **Fix `gl_load.h`'s core-function indirection** (bug #3, the current
   wall) -- under `__EMSCRIPTEN__`, functions that Emscripten provides
   directly (essentially all of GLES3/WebGL2's real API surface) should
   NOT go through the `_ptrc_gl*`/proc-address loader at all; only the
   genuinely optional desktop-GL4 extensions this file also defines
   (`ogl_ext_ARB_buffer_storage` and friends, already flagged separately)
   should. Concretely: either (a) conditionally `#undef` the
   `#define glXxx _ptrc_glXxx` redirections for core functions under
   `__EMSCRIPTEN__` so the plain `glXxx` symbol resolves directly via
   normal linking against Emscripten's real implementation, or (b) keep
   the indirection but populate `_ptrc_glXxx` with the *real* function
   pointer directly (e.g. `_ptrc_glClearColor = glClearColor;`, using
   Emscripten's actual linked symbol, not a runtime string-based lookup)
   for every core function, reserving `IntGetProcAddress`/
   `emscripten_webgl_get_proc_address` calls for the true extensions only.
   (b) is probably less invasive (doesn't require touching the huge
   `#define` list in `gl_load.h`, just changing what `Load_*` functions in
   `gl_load.c` do for the core subset) but requires enumerating exactly
   which of `gl_load.c`'s `Load_*` functions are "core" vs "extension" --
   skim the file for `ogl_ext_*` flags to tell them apart; anything never
   gated behind an `ogl_ext_*` check afterward is core and unconditionally
   required.
3. **Get past `OpenGLFrameBuffer::InitializeState()` entirely, reach first
   frame render** -- once #2 is fixed, expect more of the same class of
   bug (missing/null function pointers) further into init, and then into
   the first actual `RenderViewpoint()` call. Iterate using the same
   reproduce-in-desktop-Chrome-with-`vid_renderer 1` loop; each fix should
   get measurably further (further console log lines / further stack
   frames) -- if a fix doesn't move the failure point, it's the wrong fix.
4. **Shader compatibility (GLSL 400/430 → GLSL ES 300)** -- once actual
   shader compilation is reached (not before -- don't try to pre-emptively
   fix this without a concrete compile error in hand), expect failures in
   `gl_shader.cpp`/the shader source lumps themselves
   (`#version 400 core`/`#version 430 core` won't parse under WebGL2's
   GLSL ES 3.00). The `if (gl.es)` branches already in `gl_shader.cpp`
   (grep `ES_VERSION_STR`) suggest this path may already substantially
   exist (built for real Android/Quest GLES3) rather than needing to be
   written from scratch -- but this is *unverified*, treat it as the next
   real unknown, not a known quantity.
5. **Only then**: the actual M6 work as originally scoped --
   `gl_webxrdevice.cpp`/`.h` (`WebXRDeviceMode`/`WebXRDeviceEyePose`),
   wiring real per-eye viewport/projection from
   `XRFrame.getViewerPose(...).views` into `Stereo3DMode`'s existing
   per-eye render loop (`gl_scene.cpp`'s `RenderViewpoint()`), and getting
   the XR session's own `layer.framebuffer` bound as the render target for
   each eye (this needs a way to give Emscripten's `GL.framebuffers[]`
   table an entry for the JS-side `XRWebGLLayer.framebuffer` object so C++
   `glBindFramebuffer()` calls can target it -- not yet researched in
   depth; community Emscripten+WebXR examples commonly do this via a small
   `EM_JS`/JS-library snippet calling `GL.getNewId(GL.framebuffers)`, but
   verify this against the actual Emscripten version vendored here rather
   than assuming). At this point, replace the interim mirror renderer in
   `web/src/xr.ts` (delete `createMirrorRenderer` and its call sites) --
   it's explicitly a throwaway bridge, not something to build on top of.

**Known risks / things that could still go sideways, roughly in order of
how likely/scary they are:**
- **Shader porting scope is completely unknown.** This is the single
  biggest remaining unknown in the whole milestone. It could be almost
  nothing (if the ES paths already in `gl_shader.cpp` just work) or a
  multi-day shader-by-shader port (if WebGL2's stricter GLSL ES 3.00
  validation rejects things the real Android GLES3 driver tolerated, or if
  SSBO-dependent lighting paths have no ES equivalent at all and need a
  UBO-based fallback written from scratch -- the architecture doc already
  flags SSBOs as unavailable in WebGL2).
- **Performance is completely unmeasured.** Software renderer performance
  (what's shipped today) says nothing about hardware-GL performance on
  Quest's mobile GPU, especially once stereo doubles the per-frame draw
  count. The plan's own M6 acceptance criteria calls this the highest
  perf-risk item in the project; no instrumentation exists yet to even
  measure it.
- **The `_ptrc_gl*` indirection removal (TODO #2) touches a ~2000-line
  generated-looking file.** Low conceptual risk (mechanical), but
  meaningful chance of missing a function that's actually used somewhere
  non-obvious, producing a *new* null-function crash further into
  rendering that looks superficially like a different bug. Cross-check
  against `ogl_ext_*` flag usage sites (`grep -rn "ogl_ext_" src/gl/`)
  before assuming something is "core".
- **Never tested**: whether `SDL_GL_CreateContext`'s retry-ladder logic in
  `sdlglvideo.cpp` (tries `{4,5}` down to `{2,0}` on the desktop path)
  behaves sanely under Emscripten at all -- i.e. whether failed attempts
  actually fail cleanly (returning NULL so the loop retries) or silently
  "succeed" with a context that then misbehaves. TODO #1 above sidesteps
  this by skipping the ladder entirely for Emscripten, but if that turns
  out to be wrong for some reason, this ladder's actual behavior under
  Emscripten is unverified terrain.
- **Not yet re-verified**: that the default (`vid_renderer 0`) desktop
  path still works after the `gl_load.c`/`build-wasm.sh` changes currently
  sitting uncommitted. It was verified once after making them (title
  screen loaded, normal `[doom]` log sequence, no new console errors) but
  the screenshot tool itself became flaky/unresponsive near the end of
  this session (likely browser-extension fatigue from many repeated
  WebGL-context-churning test iterations in one tab, not a sign of a real
  regression) -- worth one more clean verification pass (fresh tab) before
  trusting this completely.

**Dead ends / things already ruled out, don't re-try these:**
- The interim WebXR mirror renderer (`web/src/xr.ts`'s
  `createMirrorRenderer`) is not a path toward real stereo -- it reads
  back a second canvas via `texImage2D` with no synchronization between
  the engine's own render loop and the XR session's frame loop, which is
  *why* M6 (real per-eye rendering into the XR layer's own framebuffer)
  is necessary in the first place, not an alternative to it.
- Simply flipping `vid_renderer` to 1 without the `gl_load.c` fix just
  produces the silent-hang/fatal-error from bug #1 -- don't waste time
  re-diagnosing that from scratch, the fix is already in the working tree.
- `-sGL_TESTING=1` (added earlier for the mirror renderer's
  `preserveDrawingBuffer` need) and `-sMAX_WEBGL_VERSION=2
  -sMIN_WEBGL_VERSION=2` (added for this work) are unrelated flags for
  unrelated problems -- don't assume one subsumes the other or try to
  remove one while debugging the other's problem space.

---

## M7 — Controller input

**Goal**: Enumerate `XRInputSource`s + `Gamepad` data each frame and route
buttons/axes into the engine's existing key-binding system
(`c_bind.cpp`/`g_input.h`), mirroring how QuestZDoom's `VrInputDefault.cpp`
synthesizes key events from OpenXR action state (architecture doc §7).

**Affected components**: `web/src/input.ts`, C ABI additions
(`vr_set_left_controller_pose`, `vr_set_left_controller_input`, etc., per the
project brief's example signatures), `platform/web/vr_webxr.cpp`.

**Expected technical problems**:
- WebXR's `Gamepad`-via-`XRInputSource.gamepad` mapping is less
  standardized across controller types than OpenXR's interaction profiles —
  the brief explicitly warns against hardcoding one Quest mapping; use
  `gamepad.mapping === "xr-standard"` and its documented button/axis order
  rather than positional guessing.
- Edge-detection for button-press events (down→pressed-this-frame vs.
  held) needs the same old/new-state-diff pattern QuestZDoom uses
  (`Joy_GenerateButtonEvents`) — implement once as a small shared helper,
  not duplicated per button.

**Acceptance criteria**:
- Right trigger fires, A opens/uses, B cycles weapons (or configured
  equivalents) — matching the brief's suggested default mapping.
- Mapping is table-driven/configurable, not hardcoded to a single physical
  controller model.
- Haptic pulse (`VR_HapticPulse`) triggers on at least one game event (e.g.
  firing) as a smoke test — full haptic design can wait, but the ABI path
  must be proven end-to-end here.

---

## M8 — Locomotion

**Goal**: Left-thumbstick smooth locomotion (forward/back/strafe) and
right-thumbstick snap turning (default 30°), with configurable
controller-relative vs. head-relative direction, per Phase 6 of the brief.

**Affected components**: engine-side movement input consumption (wherever
`VR_GetMove`'s equivalent feeds `p_user.cpp` movement, per architecture doc
§5), `web/src/input.ts` (axis reading), settings/config plumbing for
locomotion direction mode.

**Expected technical problems**:
- Reproducing QuestZDoom's dual movement-source model (thumbstick-driven +
  real positional HMD-translation-driven movement, architecture doc §5) or
  deliberately simplifying to thumbstick-only for MVP — this is a scope
  decision to make explicitly and document, not stumble into.
- Snap-turn interacting correctly with M5's body/head yaw separation — snap
  turn should rotate body yaw, not head yaw.

**Acceptance criteria**:
- Left stick moves the player; direction is controller-relative by default
  and configurable.
- Right stick snap-turns at a configurable angle (default 30°).
- No motion-sickness-inducing artifacts from incorrect yaw composition
  (manual playtest checklist, not automatable).

---

## M9 — 6DoF weapon

**Goal**: Right-controller-driven weapon position/orientation, with the
actual hitscan/projectile firing vector derived from controller orientation
rather than body yaw — reusing the `weaponangles`/`weaponoffset` →
`AttackAngle`/`AttackPitch`/`AttackPos` wiring already present in
`gl_openxrdevice.cpp:568-576` (architecture doc §5), staged per the brief's
5-step plan (static → direction-follows → visual-follows → correct firing
vector → two-handed stabilization).

**Affected components**: engine weapon-transform code (adapted from
`gl_openxrdevice.cpp`'s `GetHandTransform`), `platform/web/vr_webxr.cpp`
(right-controller pose feed), weapon rendering (viewmodel matrix).

**Expected technical problems**:
- Getting visual weapon transform and firing-vector transform consistent
  with each other (both must derive from the same controller pose sample
  within a frame, or aim will visually mismatch actual hit direction).
- Two-handed stabilization (off-hand grip overriding yaw/pitch) is a later
  stage — don't attempt it before stages 1–4 are solid, per the brief's
  explicit staging.

**Acceptance criteria**:
- Weapon visually tracks the right controller's position and orientation.
- Firing direction matches where the weapon is visually pointed, verified by
  aiming off-body-forward and confirming hits land where aimed.
- Each of the 5 sub-stages independently testable and committed separately.

---

## M10 — Quest optimization

**Goal**: Reach the brief's ≥72 FPS target on real Quest 2/3 hardware, using
the instrumentation added in M6, investigating WASM SIMD / OffscreenCanvas /
WebGL2 optimization only after measuring where time actually goes (per the
brief's "measure first" rule) — WASM threads only if proven necessary, given
their COOP/COEP deployment cost.

**Affected components**: build flags (`-msimd128` if adopted), renderer hot
paths identified by profiling, JS/WASM bridge call batching if proven to be
a bottleneck.

**Expected technical problems**:
- Distinguishing JS/WASM bridge overhead from genuine GPU-bound rendering
  cost vs. WASM CPU-bound game-logic cost — needs the frame-time/render-
  time/XR-frame-time/bridge-time instrumentation categories the brief
  specifies, not just an aggregate FPS counter.
- Any remaining GL4-pattern leftovers from M1/M6 (e.g. buffer orphaning
  done naively) are a likely first optimization target on mobile GPUs.

**Acceptance criteria**:
- Sustained ≥72 FPS on Quest 2 for representative gameplay (a full level,
  not just an empty room).
- Instrumentation report showing where frame budget goes, informing whether
  SIMD/threads/OffscreenCanvas are worth pursuing further (this milestone
  may conclude "good enough, stop here" rather than exhausting every
  optimization listed in the brief — that's an acceptable outcome).

---

## Summary answers to the brief's closing questions

1. **Recommended engine**: `DrBeef/gzdoom@questzdoom` (LZDoom 3.88b) built
   from its desktop CMake config under Emscripten, `HAVE_VM_JIT=OFF`. Reject
   switching to PrBoom+/dsda-doom/Chocolate Doom — they'd compile far more
   easily but have none of the VR camera/weapon/stereo machinery this
   project needs, making the engine swap a false economy (architecture doc
   §16).
2. **Can QuestZDoom's exact engine realistically compile under Emscripten?**
   Yes, with moderate, well-scoped effort. No blocker found is unfixable —
   the two real blockers (GL4 SSBO/persistent-buffer-mapping renderer path,
   and the asmjit JIT) both have known, bounded fixes (renderer rewrite to
   UBO/orphaning; and a config flag to the existing bytecode interpreter,
   respectively). The bigger unknown is effort/calendar time for the
   renderer rework, not feasibility.
3. **Three highest-risk technical problems**:
   - GL4→WebGL2 renderer gap (SSBOs, persistent-mapped buffers) — the
     largest unknown-effort item, could cascade into needing the software
     renderer as a fallback.
   - Quest 2/3 mobile GPU performance for real stereo rendering at ≥72 FPS
     (M6/M10) — the project's core hardware constraint, unresolved until
     measured on real hardware.
   - Getting the visual weapon transform and the actual firing vector to
     agree frame-to-frame (M9) — a correctness bug here silently breaks
     gameplay feel without throwing any errors, easy to ship broken.
4. **Smallest experiment to validate/invalidate the project**: Configure
   and attempt an Emscripten build of the engine with the GL4 renderer
   entirely stubbed out and `HAVE_VM_JIT=OFF`, targeting only a successful
   *link* (not correct rendering) of `doomvr.wasm`. If that fails for
   reasons beyond the ones already identified in this document, the
   project's core technical premise needs re-evaluation before any further
   investment. If it succeeds, M1 is essentially validated and the rest of
   the plan is de-risked.
5. **Exact next coding task**: Set up the Emscripten toolchain and attempt
   `emcmake cmake` configure + build against
   `research/QuestZDoom/Projects/Android/jni/gzdoom-g3.3mgw_mobile`'s
   *desktop* `CMakeLists.txt`, with `HAVE_VM_JIT=OFF` and the GL4-specific
   dynamic-lights code path disabled via an `#ifdef`, working through
   compile errors one at a time per the brief's incremental rules (M1,
   sub-steps 1–2) — this is the smallest possible next commit and directly
   tests risk item #1 above.
