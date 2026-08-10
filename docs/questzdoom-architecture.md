# QuestZDoom Architecture Study

Research performed against a fresh clone of:

- `Team-Beef-Studios/QuestZDoom` (top-level Android app/launcher project)
- submodule `DrBeef/gzdoom` @ branch `questzdoom`, path
  `Projects/Android/jni/gzdoom-g3.3mgw_mobile/` (the actual game engine)

Clone location used for this research: `research/QuestZDoom/` (not vendored into
the final project — see "Recommended Web Port Strategy" for what, if anything,
should be imported).

## 1. Engine version

- `VERSIONSTR "QuestZDoom-1.6.0 (LZDoom 3.88b)"` (`src/version.h`).
- LZDoom is a fork of **GZDoom 3.3** that keeps the old DDRAW/D3D backends and
  GL2 compatibility path, and still supports non-SSE2 CPUs — i.e. it is an
  *older, more portable* branch of the GZDoom family, not current GZDoom
  (which has since moved to Vulkan/GL4-only paths in places).
- Upstream lineage: `id Software`/`Raven Software` Doom source → ZDoom →
  GZDoom 3.3 → LZDoom → `DrBeef/gzdoom` (Quest VR fork, many branches:
  `g3.3mgw`, `g3.3mgw_mobile`, `questxdoom`/OpenXR variants, plus a long tail
  of fix branches merged into `questzdoom`).
- License: **GPLv3** (top-level `LICENSE`), with additional per-contributor
  licenses under `docs/licenses/` in the engine submodule. Any code we reuse
  or derive from this tree inherits GPLv3 obligations — see the Licensing
   section of the top-level project plan; the top-level `LICENSE` covers the
   combined browser port and this document records the relevant upstream
   provenance.

## Current web-port status

This study began before implementation. The browser port now builds the engine
under Emscripten, runs Doom with keyboard input and OpenAL-over-WebAudio sound
effects, and uses the hardware WebGL2 renderer. WebXR shares that renderer's
context with `XRWebGLLayer`, renders the two eye views directly, and has been
validated on headset hardware for session lifecycle, head tracking, world
stereo, and a fixed head-relative weapon viewmodel.

The page now displays rolling XR frame cadence and JS/WASM engine CPU time.
M7 translates `xr-standard` controller transitions to the engine's normal
virtual gamepad keys and has been validated on Quest. M8 supplies analog-stick
locomotion and snap-turn through the same Emscripten bridge; headset validation
is still needed for that new movement path. M9 now bridges the right controller
grip pose into the weapon's world transform and attack origin/direction, pending
hardware aim validation. The analysis and strategy sections below retain the
original risks and decisions; where they describe a future porting task, the
later status notes supersede them.

## 2. Relevant repositories / submodules

| Repo | Role |
|---|---|
| `Team-Beef-Studios/QuestZDoom` | Android Gradle app shell: Activity/JNI glue, launcher assets, packaging |
| `DrBeef/gzdoom` (branch `questzdoom`) | The actual LZDoom 3.88b engine, git submodule at `Projects/Android/jni/gzdoom-g3.3mgw_mobile/` |
| (in-tree, not a submodule) `Projects/Android/jni/QzDoom/` | Hand-written native glue: OpenXR session/swapchain management, controller input mapping, Android activity lifecycle — sits *between* the Android app and the engine |
| (in-tree) `Projects/Android/jni/SupportLibs/` | Vendored native deps built via `ndk-build` (OpenAL Soft, libjpeg, libpng, libzip, fluidsynth-lite, libmpg123, libsndfile, flac) |

The engine submodule itself vendors its own copies of most portable libraries
under `libraries/` (zlib, bzip2, dumb, game-music-emu, wildmidi, timidity,
timidityplus, oplsynth, opnmidi, adlmidi, zmusic, asmjit, sigc++, rapidjson) —
these are **not** part of the Android SupportLibs set, which duplicates a few
of them for the ndk-build pipeline (see §4).

## 3. Build system

- **Not CMake on Android**, despite a full desktop `CMakeLists.txt` (18KB)
  existing in the engine submodule. Android uses classic **ndk-build**:
  `build.gradle` → `externalNativeBuild { ndkBuild { path 'jni/Android.mk' } }`.
- `Application.mk`: `APP_PLATFORM := android-29`, `APP_STL := c++_shared`.
  `build.gradle`: NDK `26.1.10909125`, `abiFilters 'arm64-v8a'` only (single
  ABI, matches Quest 2/3 hardware), `minSdk 29` / `targetSdk 34`.
- `jni/Android.mk` includes, in order: `SupportLibs/*` (prebuilt-from-source
  native deps), then `gzdoom-g3.3mgw_mobile/mobile/Android.mk`.
- The engine's own `mobile/` directory is a **parallel, hand-maintained build
  description** (`Android_zlib.mk`, `Android_bzip2.mk`, `Android_gme.mk`,
  `Android_dumb.mk`, `Android_opnmidi.mk`, `Android_timidity(plus).mk`,
  `Android_adlmidi.mk`, `Android_wildmidi.mk`, `Android_zmusic.mk`,
  `Android_src.mk`, …) that recompiles the same `libraries/` sources for
  ndk-build, independent of the desktop CMake build. **This means the desktop
  `CMakeLists.txt` is the more relevant reference for a new Emscripten build**
  (CMake targets a real Emscripten toolchain file cleanly; ndk-build does
  not), but none of the actual Android/OpenXR-specific `.mk` logic transfers.
- Native dependency: `openxr_loader_for_android` AAR, extracted to a `.so` at
  build time (`build.gradle`) — the only prebuilt-binary (non-source)
  dependency, and it is Android/Quest-specific — irrelevant to a web port.

## 4. Quest/Android-specific code

Lives almost entirely **outside** the gzdoom engine submodule, in
`Projects/Android/jni/QzDoom/` and `java/com/drbeef/...`:

- **OpenXR session/frame lifecycle**: `TBXR_Common.cpp` — `xrCreateSession`
  (~L1629), `xrCreateSwapchain` (~L709), `xrLocateViews` (~L2166), the
  `xrWaitFrame`/`xrBeginFrame`/`xrEndFrame` loop (~L2076–2287), all driven from
  a dedicated native app thread (`pthread_create(&appThread->Thread, ...,
  AppThreadFunction, ...)`, ~L1301).
- **Controller input**: `OpenXrInput.cpp` — `TBXR_InitActions()` (~L131)
  creates one `XrActionSet "gameplay"` bound to
  `/interaction_profiles/oculus/touch_controller` (Pico controller profile
  tried as a fallback); `TBXR_UpdateControllers()` (~L430) syncs actions and
  populates `ovrInputStateTrackedRemote` structs (buttons/touches/trigger/
  grip/joystick) per hand.
- **Input → Doom key mapping**: `VrInputDefault.cpp` / `VrInputCommon.cpp` —
  `HandleInput_Default()` and `Joy_GenerateButtonEvents()` do edge-detection
  on old/new button bitfields and synthesize Doom key events (trigger→
  `KEY_PAD_RTRIGGER`, A/X→`KEY_PAD_A`, thumbstick clicks→weapon-cycle keys,
  etc.). The dominant-hand grip button acts as a "shift" layer selecting a
  secondary key-binding set.
- **Haptics**: `TBXR_Vibrate()` (~L508) queues per-hand duration/intensity;
  `TBXR_ProcessHaptics()` (~L527) calls `xrApplyHapticFeedback` once per
  frame.
- **Android lifecycle / JNI**: `QzDoom_OpenXR.cpp` (JNI entry points, e.g.
  `chdir("/sdcard/QuestZDoom")` at ~L243 to root all relative file I/O),
  `java/com/drbeef/questzdoom/GLES3JNIActivity.java` (Activity, asset
  extraction, permissions).

None of this is reusable as-is for a browser port — it is 100% OpenXR-on-
Android plumbing — but the **shape** of the glue layer (a thin native module
that owns the XR session and pokes a handful of extern globals/functions that
the renderer reads) is a useful pattern to mirror with a JS↔WASM bridge.

## 5. VR-specific engine changes (inside the gzdoom submodule)

### Stereo rendering / eye abstraction

`src/gl/stereo3d/` already contains a **generic strategy-pattern abstraction**
for stereo output, predating the Quest port:

- `class Stereo3DMode` (`gl_stereo3d.h:71`) — abstract base with pure-virtual
  `Present()`, overridable `SetUp()`/`TearDown()`/`AdjustViewports()`/
  `GetHandTransform()`/`GetWeaponTransform()`/`GetTeleportLocation()`.
- `class EyePose` (`gl_stereo3d.h:51`) — per-eye `GetProjection()`/
  `GetViewport()`/`GetViewShift()`.
- Concrete strategies: `MonoView`, `ShiftedEyePose`-based `LeftEyeView`/
  `RightEyeView` (`gl_stereo_leftright.h:35`), `QuadStereoMode`
  (quad-buffered/anaglyph/side-by-side desktop 3D modes), and
  **`OpenXRDeviceMode : public Stereo3DMode`** (`gl_openxrdevice.h:61`) with
  **`OpenXRDeviceEyePose : public ShiftedEyePose`** (`gl_openxrdevice.h:38`).
- Mode selection is a CVar: `vr_mode` (`gl_stereo_cvars.cpp:40`), dispatched
  in `setCurrentMode()` (`gl_stereo_cvars.cpp:113`).

This `Stereo3DMode`/`EyePose` pair is the reuse point used by the WebXR port:
`platform/web/vr_webxr.cpp` implements `WebXRDeviceMode` and
`WebXRDeviceEyePose` against this seam. It consumes live `XRView` projection
matrices and viewer-relative eye offsets rather than the native mode's fixed
IPD CVar, and presents into the WebXR layer framebuffer registered in
Emscripten's GL table.

Important nuance: **`gl_openxrdevice.cpp` itself contains zero direct OpenXR
API calls.** It calls a small set of `extern` free functions
(`TBXR_FrameSetup`, `TBXR_prepareEyeBuffer/finishEyeBuffer/submitFrame`,
`VR_GetMove`, `VR_GetVRProjection`, `VR_HapticEnable`,
`QzDoom_GetScreenRes`) that are implemented in `QzDoom/TBXR_Common.cpp` and
`QzDoom/QzDoom_OpenXR.cpp`, outside the engine submodule. So there already
*is* a thin C-function boundary between "engine" and "XR runtime" — it's just
OpenXR/Quest-specific on the runtime side, not a generic interface, and the
data crossing it is raw mutable globals rather than a struct.

### HMD pose / body-vs-head separation

- Globals declared `extern` in `gl_openxrdevice.cpp` (~L92–101): `vec3_t
  hmdPosition`, `vec3_t hmdorientation` (pitch/yaw/roll), `float playerYaw`,
  `float doomYaw`. Populated in `QzDoom_OpenXR.cpp` from OpenXR pose data
  (`QuatToYawPitchRoll(...)` in `TBXR_Common.cpp` ~L1940).
- `OpenXRDeviceMode::updateHmdPose()` (`gl_openxrdevice.cpp:669`) is the key
  function: computes yaw/pitch delta vs. the previous frame, calls
  `G_AddViewAngle`/`G_AddViewPitch`, and explicitly separates:
  - **body/world yaw** — `doomYaw`, the persistent player-facing direction
    used for movement and weapon-relative math, and
  - **head yaw/pitch/roll** — `hmdorientation`, applied to
    `r_viewpoint.Angles` for the rendered camera only.
  This is exactly the "don't rotate the whole player every head turn"
  behavior the project brief asks for — QuestZDoom already implements it, we
  should port the *concept*, not necessarily the exact globals.
- `SetUp()` (`gl_openxrdevice.cpp:504`) calls `updateHmdPose()` every frame
  and also derives crouch/standing height (`getHmdAdjustedHeightInMapUnit`)
  and positional (room-scale) movement from HMD translation.

### Projection / eye matrices / IPD

- `OpenXRDeviceEyePose::GetProjection()` (`gl_openxrdevice.cpp:202`) delegates
  to `VR_GetVRProjection(eye, zNear, zFar, matrix)`
  (`QzDoom_OpenXR.cpp` ~L306), which builds the matrix from the **live
  per-eye FOV returned by `xrLocateViews`** — i.e. projection *is* read live
  from the runtime, matching what `XRView.projectionMatrix` gives for free in
  WebXR.
- `OpenXRDeviceEyePose::GetViewShift()` (`gl_openxrdevice.cpp:177`) computes
  eye separation as `(vr_ipd * 0.5) * vr_vunits_per_meter * ±1` — **`vr_ipd`
  is a CVar (default 0.064 m), not read live from the HMD.** In WebXR, the
  per-eye `XRView.transform` already encodes the true device IPD, so this is
  one spot where the web port can be *more correct* than the native one by
  using the live view offset instead of a fixed CVar.

### Controller-driven weapon (6DoF) and firing vector

- `VrInputDefault.cpp` (in `QzDoom/`, ~L145–202): dominant-hand `weaponoffset`
  = controller position − `hmdPosition`, yaw-corrected by
  `getViewpointYaw() - hmdorientation[YAW]`; `weaponangles` from the
  controller's orientation quaternion. Off-hand equivalent
  (`offhandoffset`/`offhandangles`) supports two-handed stabilization
  (overrides yaw/pitch when the off-hand grip is held).
- Engine side: `GetHandTransform()` (`gl_openxrdevice.cpp:351`) builds the
  view-model weapon matrix from these globals. Critically,
  **`gl_openxrdevice.cpp:568–576` sets `player->mo->AttackPitch` /
  `AttackAngle` / `AttackRoll` / `AttackPos` directly from `weaponangles` /
  `weaponoffset`** — i.e. the actual hitscan/projectile direction already
  comes from controller orientation, not body yaw. This satisfies Phase 8 of
  the project brief; the "transitional" static-weapon stage is only needed
  because WebXR controller plumbing won't exist on day one, not because the
  underlying engine needs new hooks.

### Locomotion

- `VR_GetMove()` (`QzDoom_OpenXR.cpp:204`) combines two independently-tracked
  movement sources: off-hand-thumbstick-driven smooth movement
  (`remote_movementForward/Sideways`) and real HMD-translation-driven
  positional movement (`positional_movementForward/Sideways`, computed in
  `VrInputDefault.cpp` ~L204–220). Movement direction is either off-hand-
  controller-yaw-relative (`vr_move_use_offhand`) or HMD-forward-relative.
- Snap turn: `VrInputDefault.cpp` ~L266–300, adjusts a `snapTurn` accumulator
  by `vr_snapTurn` degrees when the dominant stick crosses a ±0.6 X
  threshold; consumed inside `VR_GetMove` as `hmdorientation[YAW] + snapTurn`.
- Teleport: armed by pushing the off-hand stick forward
  (`ready_teleport`/`trigger_teleport` flags), raycast + actual XY move
  happens engine-side (`gl_openxrdevice.cpp` ~L604–634, `P_LineTrace` /
  `P_XYMovement`).

### Browser M8 locomotion status

The browser bridge deliberately implements only the smooth-thumbstick portion
of the model above. Each WebXR frame supplies left/right `xr-standard` axes and
optional grip yaw to `VR_WebXR_SetLocomotion`; its cached output is read by the
Emscripten `VR_GetMove()` at each game tic. A radial 0.20 deadzone avoids
controller drift. Movement is head-relative by default and becomes
movement-controller-relative with `vr_move_use_offhand`; `vr_switch_sticks`
swaps movement and turn sticks. The turn stick applies one `vr_snapTurn`
increment when it crosses +/-0.60, and must return below +/-0.45 to rearm.

This avoids modifying the native head-pose path: snap-turn calls
`G_AddViewAngle`, which rotates the player body, while the headset's recentered
yaw continues to drive the independent view offset. There is no browser
room-scale movement, teleport implementation, or controller weapon pose yet.

### Threading model

Single native "app thread" (via `pthread_create`) owns both the OpenXR frame
loop and the game logic tick — there is no separate render-thread/game-thread
split for VR state, and the HMD/controller globals are unsynchronized plain
globals updated and consumed within that one thread per frame. A
`pthread_mutex_t`-guarded queue exists only for Android lifecycle events
(surface create/destroy) between the Java UI thread and the native thread —
irrelevant to a single-threaded browser main-loop port.

Separately, inside the engine itself, `std::thread`/`pthread`/`<mutex>` show
up **only** in two optional rendering backends
(`src/polyrenderer/poly_renderthread.*`, `src/swrenderer/drawers/r_thread.*` +
`r_scene.cpp`, gated by `r_multithreaded`/CVars, not used on the GL path) and
in the OpenAL backend's streaming thread. Core gameplay code (`p_*.cpp`,
`g_*.cpp`, `nodebuild_*.cpp`) is single-threaded throughout.

## 6. Rendering architecture

The following was the pre-implementation audit. Its GL4/WebGL2 gaps have been
addressed for the current hardware renderer: GLES3/WebGL2 shader paths are
selected, dynamic lights use a UBO-compatible path, persistent mapping is
replaced with CPU staging and `glBufferSubData`, and desktop-only GL state is
guarded. Desktop Chromium smoke tests and headset stereo rendering now work;
Quest performance still needs measurement.

- GL renderer (`src/gl/`) targets **desktop GL 3.x/4.x**, not pure GLES3/
  WebGL2: shaders declare `#version 400 core` / `#version 430 core`
  (`gl_shader.cpp`) and the dynamic-lights path uses
  `GL_ARB_shader_storage_buffer_object` (SSBOs) — unavailable in WebGL2.
- More seriously, `glMapBufferRange` is called with
  `GL_MAP_PERSISTENT_BIT`/`GL_MAP_COHERENT_BIT`
  (`src/gl/data/gl_vertexbuffer.cpp:140`,
  `src/gl/dynlights/gl_lightbuffer.cpp:79`, `gl_models.cpp`) — persistent-
  coherent buffer mapping is a GL4.4 (`ARB_buffer_storage`) feature with **no
  WebGL2/GLES3 equivalent at all**. This is the single largest renderer-level
  Emscripten blocker and needs a `glBufferSubData`/orphaning rewrite, not a
  flag flip.
- No compute shaders and no real `glDrawElementsIndirect`/multi-draw call
  sites in use (only declared, unused, in the desktop GL extension loader) —
  not a real blocker.
- A software renderer (`src/swrenderer/`, `src/polyrenderer/`) remains in the
  engine, but the browser UI starts the hardware GL renderer because
  `Stereo3DMode` is required for direct WebXR stereo output.

## 7. Input architecture

See §5 "Controller-driven weapon" and "Locomotion" above for the VR-specific
input pipeline. Outside VR, the engine's core input system
(`c_bind.cpp`/`g_input.h`) is a conventional key/button-binding table that the
Quest glue feeds synthetic key events into — meaning **a browser port can
feed WebXR-derived synthetic key/button events through this exact same
binding table**, exactly like QuestZDoom does for OpenXR, without needing to
touch `p_user.cpp`/gameplay code at all for basic (non-weapon-transform)
input.

## 8. Filesystem assumptions

- Startup does a plain `opendir`/`readdir` directory scan
  (`src/posix/i_system_posix.cpp`) to locate IWADs — no `mmap`, no symlinks.
  This maps cleanly onto Emscripten's `MEMFS` (mount a virtual `/wads`
  directory, `FS.writeFile` the user-provided WAD into it).
- IWAD/PWAD resolution (`src/d_iwad.cpp:554` and surrounding) reads `-iwad`
  from command-line args and searches a small set of standard paths (cwd,
  `$DOOMWADDIR`, `$HOME/.config/zdoom`, …) — entirely generic POSIX, no
  Android-specific file APIs (`AAssetManager`, JNI) anywhere inside the
  engine submodule. The only hardcoded path in the whole stack is
  `chdir("/sdcard/QuestZDoom")` in `QzDoom_OpenXR.cpp`, which is glue-layer
  code we don't port.
- Practical implication for the web port: we can pass `-iwad
  /wads/<whatever the user named their file>` on `Module.callMain([...])`
  exactly as the project brief's example flow describes, with no engine
  changes required to detect a non-standard filename.

## 9. Audio architecture

- Backend: **OpenAL (Soft)**, selected via `IsOpenALPresent()` /
  `GSnd = new OpenALSoundRenderer` (`src/sound/backend/i_sound.cpp:267`).
  Notably the engine `dlopen`s `libopenal` at runtime rather than
  link-time-linking it (`FModule OpenALModule{"OpenAL"}`,
  `src/sound/backend/oalsound.cpp`), matching the `DYN_OPENAL` CMake option.
  No SDL_mixer anywhere.
- On Android, OpenAL Soft is vendored/built from source
  (`Projects/Android/jni/SupportLibs/openal/`) with Android-specific backends
  (`Alc/backends/opensl.c`, `android.c`) that obviously don't apply to Web.
- The port uses Emscripten's OpenAL-compatible `-lopenal` shim, which maps to
  Web Audio. A real user click is required by autoplay policy. One-shot sound
  effects work; streamed music is disabled because its backend requires a
  thread and this build intentionally avoids WASM threads.
- MIDI/synth stack (WildMidi, Timidity/Timidity++, OPN/OPL FM synths,
  game-music-emu for tracker/console formats, ZMusic wrapper) is large in
  code size (`libraries/` ≈ 14 MB) and mostly there for music-format
  flexibility Doom itself barely needs (Doom's default MUS format only needs
  one FM/WildMidi path) — a strong candidate to strip for the initial WASM
  build to cut .wasm size and build complexity.

## 10. Thread usage

Covered in §5 — no gameplay-critical threading; two optional renderer
backends and the OpenAL streaming thread are the only real
`std::thread`/`pthread` usage in the engine, and QzDoom's Quest glue runs
everything (XR frame loop + game tick) on one native thread. **Conclusion:
the WASM build should target a single-threaded main loop
(`emscripten_set_main_loop`), avoiding `-pthread` and its
COOP/COEP-cross-origin-isolation deployment requirement entirely**, matching
the project brief's stated preference to avoid WASM threads unless required.

## 11. Native dependencies / vendored libraries

`libraries/` (≈14 MB) is almost entirely portable, pure C, already built
for a non-x86 target (ARM64, for Quest) — meaning most of it should port to
Emscripten with only build-flag changes: `zlib`, `bzip2`, `lzma`, `libjpeg`,
`gdtoa`, `dumb`, `game-music-emu`, `wildmidi`, `timidity`/`timidityplus`,
`oplsynth`, `opnmidi`, `adlmidi`, `zmusic`, `sigc++`, `rapidjson`. A grep for
inline assembly across `libraries/` found only 6 files with `asm`/`__asm`
tokens, all CPU-feature-detection guards (low risk, usually already
`#ifdef`-guarded out on non-x86).

**The one real hard blocker in this category: `libraries/asmjit/` (2.4 MB)**,
used by `src/scripting/vm/jit*.cpp` to JIT-compile ZScript bytecode to native
machine code at runtime (`HAVE_VM_JIT`, on by default,
root `CMakeLists.txt:212,354-370`). asmjit cannot target WASM. This must be
built with `HAVE_VM_JIT=OFF`, falling back to the engine's existing bytecode
interpreter (`src/scripting/vm/vmexec.h`) — already a supported, tested
non-JIT configuration (used whenever asmjit doesn't support the host CPU),
so this is a config flag, not new code.

## 12. OpenGL / OpenGL ES dependencies

Covered in §6. The originally identified SSBO and persistent-mapping blockers
were ported to WebGL2-compatible paths. The hardware renderer is now the
browser default and direct WebXR stereo route; remaining work is performance
profiling rather than basic GL compatibility.

## 13. Operating-system-specific code

`src/posix/` is a reasonably clean platform seam (`i_system.h`,
`i_system_posix.cpp`, `videomodes.h`, plus per-platform subfolders `sdl/`,
`cocoa/`, `osx/`, `unix/`, `nosdl/`) — but **there is no `android/` subfolder
inside it**. Android support is bolted on entirely from *outside* the engine
submodule (`mobile/src/i_specialpaths_android.cpp`, despite its name, is
generic-POSIX; real Android specifics live in `QzDoom/` and the Java
Activity), calling into the engine's `main()` rather than implementing a
proper `i_video`/platform backend. **This is actually good news for a web
port**: it confirms the pattern of "write a new POSIX-ish platform backend
under `src/posix/` (or a new `src/web/` sibling) plus an external glue layer
for the browser/XR-specific bits" rather than needing to unwind
Android-specific code scattered through the engine.

## 14. Dynamic libraries

Only two dynamic-loading points found in the whole tree: OpenAL (`dlopen`,
cross-platform, intentional — Emscripten equivalent needs a decision, see
§9) and Win32-only GL entry-point loading (`gl_load.c`, irrelevant to
Emscripten). The Android build's one *prebuilt binary* dependency
(`openxr_loader_for_android` .so) is Quest-specific and dropped entirely for
the web port (WebXR needs no client library — it's a browser JS API).

## 15. Original Emscripten incompatibility audit

The table records the risks identified before implementation. Items 1, 2, 3,
6, and the OpenAL part of item 5 have been resolved in the committed patch;
the remaining practical concern is Quest performance and the intentionally
thread-free streamed-music limitation.

| # | Issue | Severity | Fix |
|---|---|---|---|
| 1 | GL4 SSBO dynamic-lights path + `GL_MAP_PERSISTENT_BIT`/`COHERENT_BIT` buffer mapping | **Blocker** | Rewrite dynamic-lights buffer path to UBO + `glBufferSubData`/orphaning for WebGL2; verify no other GL4-only call sites via `EMSCRIPTEN_HAS_UNBOUND_TYPE_NAMES`-style audit during first build attempt |
| 2 | `libraries/asmjit` ZScript JIT | **Blocker** (but trivial fix) | Build with `HAVE_VM_JIT=OFF`, use existing bytecode interpreter |
| 3 | Desktop-only `#version 400/430 core` shaders | **Blocker** (renderer) | Port/rewrite shader set to GLSL ES 3.00, likely alongside #1 |
| 4 | Large MIDI/synth stack (~14 MB source) | Moderate (size/complexity, not correctness) | Strip to Doom's actual needs for MVP; revisit if music quality matters later |
| 5 | Optional threaded software renderer / OpenAL streaming thread | Minor | Simply don't enable `r_multithreaded`; single-thread OpenAL backend or replace with WebAudio |
| 6 | Static registration via linker-section tricks (`autosegs.h`) for ZScript/DECORATE | Moderate (needs early verification) | Confirm `wasm-ld` handles these sections correctly before deep integration work; this is a "test on day 1" item, not a known blocker |
| 7 | SSE intrinsics in software rasterizer paths | Minor | Reuse the build's existing `-DNO_SSE`/ARM path (already used for the Quest ARM build) — no new porting work |
| 8 | ndk-build (`Android.mk`) build description is not portable to Emscripten | Moderate (tooling, not code) | Use the engine's *desktop* `CMakeLists.txt` as the Emscripten starting point instead, with an Emscripten toolchain file; ignore all `mobile/Android_*.mk` files |
| 9 | `chdir("/sdcard/QuestZDoom")` and other Quest-glue assumptions | None (not in engine tree) | Simply don't port `QzDoom/` — write a new, much smaller web glue layer instead |

## 16. Original Web Port Strategy

The strategy below guided the completed M1-M8 implementation. The current
architecture is summarized at the top of this document and in the M8 status
of `implementation-plan.md`; M9-M10 remain future work.

1. **Engine choice: adapt LZDoom/`DrBeef/gzdoom@questzdoom` itself**, not a
   simpler engine (PrBoom+/dsda-doom/Crispy/Chocolate Doom). Those engines
   are much easier to compile under Emscripten (multiple such ports already
   exist in the wild) but are vanilla-Doom-renderer-only — they have **none**
   of the 6DoF weapon / stereo-mode / body-vs-head-yaw machinery the project
   brief explicitly wants to reuse. Given §5 shows this machinery is already
   fairly cleanly seamed (`Stereo3DMode`, `weaponangles`/`weaponoffset` →
   `AttackAngle`/`AttackPitch`), throwing it away would mean **reimplementing
   from scratch** the exact hardest part of the project (Phases 4–9) in a
   different, less VR-aware codebase. The extra Emscripten porting cost of
   GZDoom/LZDoom vs. a simpler engine is real but bounded (§15) and is a
   one-time cost; discarding the VR logic would be a recurring cost across
   every later phase.
2. **Build system: start from the desktop `CMakeLists.txt`**, not the
   Android `Android.mk` tree. Add an Emscripten toolchain invocation
   (`emcmake cmake ...`), set `HAVE_VM_JIT=OFF`, `DYN_OPENAL=OFF` (or point it
   at Emscripten's OpenAL shim), disable the software/poly threaded
   renderers, and strip unneeded MIDI backends via existing CMake options
   (`FORCE_INTERNAL_*` / library-enable flags already present at
   `CMakeLists.txt:335-449`) before touching any engine source.
3. **Initial compile target: get *anything* to link**, expecting the GL4
   renderer to fail first. If the GL renderer proves too costly to get
   rendering correctly in the short term, the software renderer
   (`src/swrenderer/`) is a legitimate fallback to reach "Doom renders to a
   canvas" (Phase 1's acceptance criterion) faster, with the GL/stereo work
   deferred to Phase 5 once gameplay is proven end-to-end.
4. **VR abstraction seam: `Stereo3DMode`/`EyePose`.** Implement
   `WebXRDeviceMode`/`WebXRDeviceEyePose` following the exact shape of
   `OpenXRDeviceMode`/`OpenXRDeviceEyePose`, but source pose/projection data
   from a small set of C-ABI setter functions
   (`vr_set_head_pose`, `vr_set_left_controller_pose`, etc., per the project
   brief) fed by a new `platform/web/vr_webxr.cpp`, mirroring the role
   `QzDoom/TBXR_Common.cpp` plays for OpenXR today — but with a real
   `VRPose`/`VRControllerState` struct instead of loose globals, since we're
   writing this glue fresh.
5. **Weapon/firing vector: reuse as-is.** The `weaponangles`/`weaponoffset`
   → `AttackAngle`/`AttackPitch`/`AttackPos` wiring in `gl_openxrdevice.cpp`
   already does exactly what Phase 8 asks for; the web port only needs to
   populate the same globals (or their renamed equivalents) from WebXR
   controller poses instead of OpenXR ones.
6. **Audio: defer the decision.** Try Emscripten's OpenAL shim first (lowest
   effort, reuses 100% of existing sound code); fall back to a WebAudio
   backend only if the shim proves inadequate for latency/quality on Quest
   Browser. Strip the MIDI/synth libraries for the MVP regardless, to shrink
   the .wasm and cut build complexity — Doom needs at most one music path.
