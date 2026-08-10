// Thin wrapper around the Emscripten module (build/wasm/lzdoom.{js,wasm},
// copied to public/engine/ by scripts/dev.sh). Keeps the WASM/FS-mounting
// details out of main.ts.
import type { LoadedWad } from "./wad-loader";
import type { XRControllerPose, XRLocomotion } from "./input";

interface EmscriptenFS {
  mkdirTree(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
}

export interface DoomModule {
  FS: EmscriptenFS;
  callMain(args: string[]): void;
  ccall(
    name: string,
    returnType: string | null,
    argTypes: string[],
    args: unknown[],
  ): unknown;
}

interface WebXRModule extends DoomModule {
  webxrLayerFramebuffer?: WebGLFramebuffer | null;
}

export interface XRQuaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface XRVec3 {
  x: number;
  y: number;
  z: number;
}

export interface XREyeFrame {
  eye: "left" | "right";
  viewport: { x: number; y: number; width: number; height: number };
  offset: XRVec3;
  projection: Float32Array;
}

type CreateModule = (config?: Record<string, unknown>) => Promise<DoomModule>;

let modulePromise: Promise<DoomModule> | null = null;
let engineContext: WebGL2RenderingContext | null = null;

// public/engine/lzdoom.js is a build artifact copied in by scripts/dev.sh,
// not source Vite can bundle -- a plain `import()` gets rewritten by Vite's
// import-analysis plugin even with /* @vite-ignore */. Hiding it inside
// `new Function` makes it a genuinely dynamic runtime import Vite can't see
// in its static scan.
const importEngineModule = new Function(
  "specifier",
  "return import(/* @vite-ignore */ specifier)",
) as (specifier: string) => Promise<{ default: CreateModule }>;

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

// Loads the WASM module and mounts the engine's own resource pack
// (lzdoom.pk3 -- menus, fonts, DECORATE defs; contains no game data) at the
// path it expects alongside its own "executable". Idempotent: repeated
// calls return the same module instance.
// Rooted at Vite's BASE_URL (not a hardcoded leading "/") so this also
// resolves correctly when served from a GitHub Pages project subpath
// (e.g. /doom-vr-browser/) instead of a domain root.
const ENGINE_BASE = `${import.meta.env.BASE_URL}engine/`;

export async function loadEngine(
  canvas: HTMLCanvasElement,
  onStatus: (message: string) => void,
): Promise<DoomModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      onStatus("Loading WASM module…");
      const { default: createLzdoomModule } = await importEngineModule(`${ENGINE_BASE}lzdoom.js`);

      // M6 creates the engine context up front so it can later be handed to
      // XRWebGLLayer. Emscripten must reuse this exact context to render into
      // the compositor's framebuffer.
      engineContext = canvas.getContext("webgl2", {
        alpha: false,
        depth: true,
        stencil: true,
        antialias: false,
        preserveDrawingBuffer: true,
        xrCompatible: true,
      });
      if (!engineContext) throw new Error("WebGL2 is required to start the engine.");

      const module = await createLzdoomModule({
        canvas,
        preinitializedWebGLContext: engineContext,
        print: (text: string) => console.log("[doom]", text),
        printErr: (text: string) => console.error("[doom]", text),
        locateFile: (path: string) => `${ENGINE_BASE}${path}`,
      });

      onStatus("Mounting engine resources…");
      const pk3 = await fetchBytes(`${ENGINE_BASE}lzdoom.pk3`);
      module.FS.writeFile("/lzdoom.pk3", pk3);
      // FIWadManager's constructor (d_iwad.cpp) reads its IWADINFO
      // definitions (which lump names mean "this is Doom2.wad" etc.)
      // exclusively from OPTIONALWAD, not BASEWAD -- see version.h.
      // Without this mounted, no IWAD is ever recognized.
      const gameSupportPk3 = await fetchBytes(`${ENGINE_BASE}lz_game_support.pk3`);
      module.FS.writeFile("/lz_game_support.pk3", gameSupportPk3);

      return module;
    })();
  }
  return modulePromise;
}

export function getEngineContext(): WebGL2RenderingContext {
  if (!engineContext) throw new Error("The engine WebGL2 context has not been created.");
  return engineContext;
}

// Writes the user's WAD into the virtual filesystem and returns its path.
// The filename is preserved as-is -- the engine detects IWAD type from
// content, not name (see docs/questzdoom-architecture.md §8).
export function mountWad(module: DoomModule, wad: LoadedWad): string {
  const dir = "/wads";
  module.FS.mkdirTree(dir);
  const path = `${dir}/${wad.filename}`;
  module.FS.writeFile(path, wad.bytes);
  return path;
}

export function startDoom(module: DoomModule, iwadPath: string, useHardwareRenderer = false): void {
  const args = ["-iwad", iwadPath];
  const query = new URLSearchParams(window.location.search);
  // XR sessions can be started after Doom, but its renderer cannot be switched
  // safely in-process. Start the browser UI on this path from the outset.
  if (useHardwareRenderer || query.get("renderer") === "gl") {
    args.push("+vid_renderer", "1");
  }
  // M9 is opt-in until its Quest grip-space calibration is hardware-validated.
  if (query.get("controllerWeapon") === "1") {
    args.push("+vr_webxr_controller_weapon", "1");
  }
  module.callMain(args);
}

// M5: WebXR head-tracking bridge -- see engine/platform/web/vr_webxr.h.
// active=true switches the engine's render mode from desktop MonoView to
// WebXRDeviceMode (gl_stereo_cvars.cpp); active=false switches it back, so
// exiting VR falls straight back to M3's normal desktop rendering.
export function setWebXRActive(module: DoomModule, active: boolean): void {
  module.ccall("VR_WebXR_SetActive", null, ["number"], [active ? 1 : 0]);
}

// Forwards one XR frame's head pose. orientation/position are exactly
// XRRigidTransform's fields (right-handed, Y-up, -Z-forward, meters,
// relative to the session's reference space) -- the yaw/pitch/roll
// conversion and body/head separation all happen engine-side.
export function setWebXRHeadPose(
  module: DoomModule,
  orientation: XRQuaternion,
  position: XRVec3,
): void {
  module.ccall(
    "VR_WebXR_SetHeadPose",
    null,
    ["number", "number", "number", "number", "number", "number", "number"],
    [orientation.x, orientation.y, orientation.z, orientation.w, position.x, position.y, position.z],
  );
}

// M7: injects an xr-standard controller transition into Doom's ordinary input
// queue, preserving the normal console/menu/game responder order.
export function postWebXRKey(module: DoomModule, key: number, down: boolean): void {
  module.ccall("VR_WebXR_PostKeyEvent", null, ["number", "number"], [key, down ? 1 : 0]);
}

// M8: sends the latest analog sticks and grip heading to the engine. Movement
// is consumed once per Doom tic by VR_GetMove; snap-turn is edge-triggered
// natively so it remains stable at all headset refresh rates.
export function setWebXRLocomotion(module: DoomModule, locomotion: XRLocomotion): void {
  module.ccall(
    "VR_WebXR_SetLocomotion",
    null,
    ["number", "number", "number", "number", "number", "number", "number"],
    [
      locomotion.validMask,
      locomotion.leftX,
      locomotion.leftY,
      locomotion.rightX,
      locomotion.rightY,
      locomotion.leftYawDeg,
      locomotion.rightYawDeg,
    ],
  );
}

// M9: forwards the right-hand grip pose used by both the world-space weapon
// matrix and the engine's hitscan/projectile origin and direction.
export function setWebXRRightControllerPose(module: DoomModule, pose: XRControllerPose): void {
  module.ccall(
    "VR_WebXR_SetRightControllerPose",
    null,
    ["number", "number", "number", "number", "number", "number", "number", "number"],
    [
      pose.valid ? 1 : 0,
      pose.orientation.x,
      pose.orientation.y,
      pose.orientation.z,
      pose.orientation.w,
      pose.position.x,
      pose.position.y,
      pose.position.z,
    ],
  );
}

// M6: forwards the viewer-relative pose, viewport and projection supplied by
// one XRView. The engine stays mono until the XR layer framebuffer is
// registered, so this can be wired and validated independently of presenting
// into the headset.
export function setWebXREye(module: DoomModule, frame: XREyeFrame): void {
  if (frame.projection.length !== 16) {
    throw new Error(`Expected a 4x4 projection matrix for the ${frame.eye} eye.`);
  }
  const eye = frame.eye === "left" ? 0 : 1;
  module.ccall(
    "VR_WebXR_SetEyeViewport",
    null,
    ["number", "number", "number", "number", "number"],
    [eye, frame.viewport.x, frame.viewport.y, frame.viewport.width, frame.viewport.height],
  );
  module.ccall(
    "VR_WebXR_SetEyeOffset",
    null,
    ["number", "number", "number", "number"],
    [eye, frame.offset.x, frame.offset.y, frame.offset.z],
  );
  module.ccall(
    "VR_WebXR_SetEyeProjection",
    null,
    ["number", ...Array<string>(16).fill("number")],
    [eye, ...Array.from(frame.projection)],
  );
}

export function runWebXRFrame(module: DoomModule): void {
  module.ccall("VR_WebXR_RunFrame", "number", [], []);
}

export function registerWebXRFramebuffer(module: DoomModule, framebuffer: WebGLFramebuffer): void {
  // EM_JS in vr_webxr.cpp owns the translation from this opaque object to an
  // Emscripten GL handle. Keep it on the module closure, not window globals.
  (module as WebXRModule).webxrLayerFramebuffer = framebuffer;
  module.ccall("VR_WebXR_RegisterFramebuffer", null, ["number"], [0]);
}

export function invalidateWebXRFramebuffer(module: DoomModule): void {
  module.ccall("VR_WebXR_InvalidateFramebuffer", null, [], []);
}
