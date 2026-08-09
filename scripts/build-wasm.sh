#!/usr/bin/env bash
# Configures and builds the engine/ submodule (DrBeef/gzdoom@questzdoom, LZDoom 3.88b)
# under Emscripten. This is the M1 milestone from docs/implementation-plan.md:
# get *anything* to link as doomvr.wasm/doomvr.js, no VR/gameplay guarantees yet.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMSDK_DIR="${ROOT_DIR}/.tools/emsdk"
ENGINE_DIR="${ROOT_DIR}/engine"
BUILD_DIR="${ROOT_DIR}/build/wasm"
HOST_TOOLS_DIR="${ROOT_DIR}/build/host-tools"
BUILD_TYPE="${BUILD_TYPE:-Debug}"

# The engine's build needs a handful of native host tools (lemon, re2c,
# zipdir, gdtoa's arithchk/qnan) to run *during* the cross-compiled build
# (parser/lexer generation, pk3 packaging) — these can't be WASM binaries.
# Build them natively first; see docs/questzdoom-architecture.md and the
# comment in engine/CMakeLists.txt:41-44 (IMPORT_EXECUTABLES).
IMPORT_EXECUTABLES="${HOST_TOOLS_DIR}/ImportExecutables.cmake"
if [ ! -f "${IMPORT_EXECUTABLES}" ]; then
	echo "Building native host tools (lemon/re2c/zipdir/gdtoa) into ${HOST_TOOLS_DIR}..."
	cmake -S "${ENGINE_DIR}" -B "${HOST_TOOLS_DIR}" -G Ninja \
		-DCMAKE_BUILD_TYPE=Release \
		-DCMAKE_POLICY_VERSION_MINIMUM=3.5
	cmake --build "${HOST_TOOLS_DIR}" --target lemon re2c zipdir arithchk qnan
fi

if [ ! -f "${EMSDK_DIR}/emsdk_env.sh" ]; then
	echo "error: emsdk not found at ${EMSDK_DIR}. Run scripts/setup.sh first." >&2
	exit 1
fi

# shellcheck disable=SC1091
source "${EMSDK_DIR}/emsdk_env.sh" >/dev/null

mkdir -p "${BUILD_DIR}"

# Linker flag notes:
# -sMODULARIZE/-sEXPORT_ES6: emit an ES module exporting a factory function
#   (web/src/engine.ts imports it directly) instead of the default
#   global-`Module`-variable script-tag pattern.
# -sINVOKE_RUN=0: don't call main() the instant the module finishes loading
#   -- engine.ts needs to mount the user's WAD into FS first.
# -sEXPORTED_RUNTIME_METHODS=callMain,FS,ccall / -sFORCE_FILESYSTEM=1: expose
#   the things engine.ts/xr.ts call directly (mounting the WAD, starting
#   main() once it's mounted, and -- from M5 -- pushing WebXR head-pose
#   samples into the engine every XR frame via ccall).
# -sEXPORTED_FUNCTIONS: _main plus the M5/M6 WebXR bridge entry points
#   (platform/web/vr_webxr.cpp) -- listing EXPORTED_FUNCTIONS at all
#   overrides Emscripten's implicit "_main"-only default, so _main must be
#   repeated here or callMain stops working.
# -sGL_TESTING=1: originally enabled for M5's removed mirror renderer. M6's
#   preinitialized WebGL2 context requests preserveDrawingBuffer directly, so
#   this may now be redundant. Keep it until direct XR rendering is validated
#   on hardware; then remove it if the shared context still behaves correctly.
# -sMAX_WEBGL_VERSION=2/-sMIN_WEBGL_VERSION=2: the hardware GL renderer
#   (src/gl/, needed for M6's real per-eye stereo -- the software renderer
#   M1-M5 ran on never touches Stereo3DMode at all) requires GL3-era
#   features (UBOs, VAOs) that WebGL1/GLES2 doesn't have. Without
#   MAX_WEBGL_VERSION=2, Emscripten never creates a WebGL2 context no
#   matter what version SDL_GL_SetAttribute requests; MIN=2 skips a silent
#   fallback to WebGL1 in browsers that lack WebGL2 (none of this
#   project's targets do) so a missing WebGL2 context fails loudly instead.
# -sGL_ENABLE_GET_PROC_ADDRESS=1: gl_load.c still uses Emscripten's
#   name-to-function resolver while the legacy GL loader is being narrowed
#   to core WebGL2 functions. Keep it explicit rather than relying on the
#   SDK default, which has changed between Emscripten releases.
# -sGL_PREINITIALIZED_CONTEXT=1: accept the WebGL2 context created by
#   engine.ts. M6 will share that exact context with XRWebGLLayer instead of
#   rendering through a second canvas.
emcmake cmake \
	-S "${ENGINE_DIR}" \
	-B "${BUILD_DIR}" \
	-G Ninja \
	-DCMAKE_BUILD_TYPE="${BUILD_TYPE}" \
	-DNO_OPENAL=OFF \
	-DDYN_FLUIDSYNTH=OFF \
	-DDYN_OPENAL=OFF \
	-DDYN_SNDFILE=OFF \
	-DDYN_MPG123=OFF \
	-DFORCE_INTERNAL_ZLIB=ON \
	-DFORCE_INTERNAL_JPEG=ON \
	-DFORCE_INTERNAL_BZIP2=ON \
	-DFORCE_CROSSCOMPILE=ON \
	-DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
	-DIMPORT_EXECUTABLES="${IMPORT_EXECUTABLES}" \
	-DNO_OPENMP=ON \
	-DCMAKE_CXX_FLAGS="-fexceptions" \
	-DCMAKE_EXE_LINKER_FLAGS="-fexceptions -sEXCEPTION_STACK_TRACES -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createLzdoomModule -sINVOKE_RUN=0 -sEXPORTED_RUNTIME_METHODS=callMain,FS,ccall -sEXPORTED_FUNCTIONS=_main,_VR_WebXR_SetActive,_VR_WebXR_SetHeadPose,_VR_WebXR_RegisterFramebuffer,_VR_WebXR_InvalidateFramebuffer,_VR_WebXR_SetEyeViewport,_VR_WebXR_SetEyeOffset,_VR_WebXR_SetEyeProjection,_VR_WebXR_RunFrame -sFORCE_FILESYSTEM=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=134217728 -sSTACK_SIZE=16777216 -sGL_TESTING=1 -sMAX_WEBGL_VERSION=2 -sMIN_WEBGL_VERSION=2 -sGL_ENABLE_GET_PROC_ADDRESS=1 -sGL_PREINITIALIZED_CONTEXT=1" \
	"$@"

cmake --build "${BUILD_DIR}"
