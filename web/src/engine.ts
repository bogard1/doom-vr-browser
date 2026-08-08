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
export async function loadEngine(
  canvas: HTMLCanvasElement,
  onStatus: (message: string) => void,
): Promise<DoomModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      onStatus("Loading WASM module…");
      const { default: createLzdoomModule } = await importEngineModule("/engine/lzdoom.js");

      const module = await createLzdoomModule({
        canvas,
        print: (text: string) => console.log("[doom]", text),
        printErr: (text: string) => console.error("[doom]", text),
        locateFile: (path: string) => `/engine/${path}`,
      });

      onStatus("Mounting engine resources…");
      const pk3 = await fetchBytes("/engine/lzdoom.pk3");
      module.FS.writeFile("/lzdoom.pk3", pk3);

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
