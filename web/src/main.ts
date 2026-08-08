import "./style.css";
import { readWadFile, type LoadedWad } from "./wad-loader";
import { loadEngine, mountWad, startDoom } from "./engine";
import { StatusLog } from "./debug";
import { enterVR, exitVR, isImmersiveVRSupported, isInXRSession } from "./xr";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <main>
    <h1>DOOM VR</h1>

    <div id="dropzone">Drop WAD here, or <label id="file-label">choose a file<input id="file-input" type="file" accept=".wad" hidden /></label></div>

    <p id="selected"></p>

    <button id="start" disabled>Start Doom</button>
    <button id="enter-vr" disabled>Enter VR</button>
    <p id="vr-support"></p>

    <canvas id="canvas" width="640" height="480" hidden></canvas>

    <h2>Status</h2>
    <div id="status"></div>
  </main>
`;

const dropzone = document.querySelector<HTMLDivElement>("#dropzone")!;
const fileInput = document.querySelector<HTMLInputElement>("#file-input")!;
const selectedEl = document.querySelector<HTMLParagraphElement>("#selected")!;
const startButton = document.querySelector<HTMLButtonElement>("#start")!;
const enterVRButton = document.querySelector<HTMLButtonElement>("#enter-vr")!;
const vrSupportEl = document.querySelector<HTMLParagraphElement>("#vr-support")!;
const canvas = document.querySelector<HTMLCanvasElement>("#canvas")!;
const status = new StatusLog(document.querySelector<HTMLDivElement>("#status")!);

let currentWad: LoadedWad | null = null;

async function handleFile(file: File): Promise<void> {
  try {
    currentWad = await readWadFile(file);
    selectedEl.textContent = `Selected: ${currentWad.filename}`;
    startButton.disabled = false;
    status.log(
      `Loaded ${currentWad.filename} (${currentWad.bytes.length.toLocaleString()} bytes) — stays in your browser.`,
    );
  } catch (err) {
    currentWad = null;
    startButton.disabled = true;
    status.error(err instanceof Error ? err.message : String(err));
  }
}

dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("dragover");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("dragover");
  const file = event.dataTransfer?.files[0];
  if (file) void handleFile(file);
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void handleFile(file);
});

startButton.addEventListener("click", async () => {
  if (!currentWad) return;
  startButton.disabled = true;
  try {
    canvas.hidden = false;
    const engine = await loadEngine(canvas, (msg) => status.log(msg));
    status.log("Mounting WAD…");
    const iwadPath = mountWad(engine, currentWad);
    status.log(`Starting engine with -iwad ${iwadPath}`);
    startDoom(engine, iwadPath);
  } catch (err) {
    status.error(err instanceof Error ? err.message : String(err));
    startButton.disabled = false;
  }
});

void isImmersiveVRSupported().then((supported) => {
  enterVRButton.disabled = !supported;
  vrSupportEl.textContent = supported
    ? "WebXR immersive-vr is supported on this browser."
    : "WebXR immersive-vr is not supported on this browser/device.";
});

enterVRButton.addEventListener("click", async () => {
  if (isInXRSession()) {
    exitVR();
    return;
  }
  enterVRButton.disabled = true;
  try {
    await enterVR(
      (msg) => status.log(msg),
      () => {
        enterVRButton.textContent = "Enter VR";
        enterVRButton.disabled = false;
      },
    );
    enterVRButton.textContent = "Exit VR";
    enterVRButton.disabled = false;
  } catch (err) {
    status.error(err instanceof Error ? err.message : String(err));
    enterVRButton.disabled = false;
  }
});
