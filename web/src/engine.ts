// Thin wrapper around the Emscripten module (build/wasm/lzdoom.{js,wasm},
// copied to public/engine/ by scripts/dev.sh). Keeps the WASM/FS-mounting
// details out of main.ts.
import type { LoadedWad } from "./wad-loader";

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

type CreateModule = (config?: Record<string, unknown>) => Promise<DoomModule>;

let modulePromise: Promise<DoomModule> | null = null;

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

      const module = await createLzdoomModule({
        canvas,
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

export function startDoom(module: DoomModule, iwadPath: string): void {
  module.callMain(["-iwad", iwadPath]);
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
