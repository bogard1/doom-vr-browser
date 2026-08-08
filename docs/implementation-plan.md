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

**Status: done.** `web/` (Vite + TS, per Phase 2's preferred stack) has
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

---

## M6 — Stereo renderer

**Goal**: Real per-eye stereo rendering via a `WebXRDeviceMode`/
`WebXRDeviceEyePose` pair implemented against the existing
`Stereo3DMode`/`EyePose` seam (architecture doc §5), consuming per-eye pose/
projection/viewport from `XRFrame.getViewerPose(...).views`.

**Affected components**: `src/gl/stereo3d/gl_webxrdevice.cpp`/`.h` (new,
modeled on `gl_openxrdevice.cpp`/`.h`), GL renderer fixes carried over from
M1 (GL4→WebGL2 shader/buffer rework, if not already fully resolved).

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
