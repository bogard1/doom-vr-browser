import "./style.css";
import { readWadFile, type LoadedWad } from "./wad-loader";
import { getEngineContext, invalidateWebXRFramebuffer, loadEngine, mountWad, registerWebXRFramebuffer, runWebXRFrame, startDoom, setWebXRActive, setWebXREye, setWebXRHeadPose, type DoomModule } from "./engine";
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
// M5: the engine module and the WebXR session load/start independently
// (Enter VR works before a WAD is even chosen, per M4) -- these two flags
// track whichever pairing has actually happened so the head-pose bridge
// activates exactly when both sides are ready, in either order.
let currentModule: DoomModule | null = null;
let xrActive = false;
let doomStarted = false;

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
    currentModule = engine;
    if (xrActive) setWebXRActive(engine, true);
    status.log("Mounting WAD…");
    const iwadPath = mountWad(engine, currentWad);
    status.log(`Starting engine with -iwad ${iwadPath}`);
    doomStarted = true;
    startDoom(engine, iwadPath, xrActive);
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
    const engine = currentModule ?? await loadEngine(canvas, (msg) => status.log(msg));
    currentModule = engine;
    await enterVR(
      (msg) => status.log(msg),
      () => {
        xrActive = false;
        if (currentModule) {
          invalidateWebXRFramebuffer(currentModule);
          setWebXRActive(currentModule, false);
        }
        enterVRButton.textContent = "Enter VR";
        enterVRButton.disabled = false;
      },
      (framebuffer) => registerWebXRFramebuffer(engine, framebuffer),
      () => {
        if (doomStarted) {
          status.error("Restart Doom after entering VR to use the hardware stereo renderer.");
          exitVR();
          return;
        }
        xrActive = true;
        setWebXRActive(engine, true);
      },
      (orientation, position) => {
        if (currentModule) setWebXRHeadPose(currentModule, orientation, position);
      },
      (views) => {
        if (currentModule) {
          for (const view of views) setWebXREye(currentModule, view);
        }
      },
      () => {
        runWebXRFrame(engine);
      },
      getEngineContext(),
    );
    enterVRButton.textContent = "Exit VR";
    enterVRButton.disabled = false;
  } catch (err) {
    status.error(err instanceof Error ? err.message : String(err));
    enterVRButton.disabled = false;
  }
});
