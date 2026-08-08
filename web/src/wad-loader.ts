// Reads a user-supplied WAD file entirely client-side. The bytes never
// leave the browser -- see engine.ts for where they get mounted into the
// Emscripten virtual filesystem.

export interface LoadedWad {
  filename: string;
  bytes: Uint8Array;
}

const WAD_MAGIC = ["IWAD", "PWAD"];

function looksLikeWad(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  return WAD_MAGIC.includes(magic);
}

export async function readWadFile(file: File): Promise<LoadedWad> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!looksLikeWad(bytes)) {
    throw new Error(
      `"${file.name}" doesn't look like a WAD file (missing IWAD/PWAD header).`,
    );
  }
  return { filename: file.name, bytes };
}
