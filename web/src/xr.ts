// WebXR session plumbing only -- no engine integration yet (that's M5+).
// Proves out session lifecycle, head pose, and controller enumeration on a
// dedicated canvas/GL context, entirely separate from the Emscripten canvas
// main.ts/engine.ts drive, so there is zero risk of regressing M3.

export type XRLogFn = (message: string) => void;

let session: XRSession | null = null;
let refSpace: XRReferenceSpace | null = null;
let frameCount = 0;

// Roughly once a second regardless of the headset's refresh rate, so the
// debug log stays readable instead of scrolling at 90-144 lines/sec.
const LOG_EVERY_N_FRAMES = 90;

export async function isImmersiveVRSupported(): Promise<boolean> {
  if (!navigator.xr) return false;
  try {
    return await navigator.xr.isSessionSupported("immersive-vr");
  } catch {
    return false;
  }
}

export function isInXRSession(): boolean {
  return session !== null;
}

export async function enterVR(log: XRLogFn, onSessionEnd: () => void): Promise<void> {
  if (!navigator.xr) {
    throw new Error("navigator.xr is not available in this browser.");
  }
  if (session) {
    throw new Error("An XR session is already active.");
  }

  const xrCanvas = document.createElement("canvas");
  const gl = xrCanvas.getContext("webgl2", { xrCompatible: true });
  if (!gl) {
    throw new Error("Could not create a WebGL2 context for the XR session.");
  }

  const newSession = await navigator.xr.requestSession("immersive-vr", {
    requiredFeatures: ["local-floor"],
  });
  session = newSession;

  session.addEventListener("end", () => {
    session = null;
    refSpace = null;
    onSessionEnd();
  });

  await gl.makeXRCompatible();
  session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });

  try {
    refSpace = await session.requestReferenceSpace("local-floor");
    log("XR session started (local-floor reference space).");
  } catch {
    refSpace = await session.requestReferenceSpace("local");
    log("XR session started ('local-floor' unavailable, fell back to 'local').");
  }

  frameCount = 0;
  session.requestAnimationFrame(onXRFrame(log));
}

export function exitVR(): void {
  void session?.end();
}

function onXRFrame(log: XRLogFn): XRFrameRequestCallback {
  const frame: XRFrameRequestCallback = (_time, xrFrame) => {
    if (!session || !refSpace) return;
    session.requestAnimationFrame(frame);
    frameCount++;
    if (frameCount % LOG_EVERY_N_FRAMES !== 1) return;

    const pose = xrFrame.getViewerPose(refSpace);
    if (pose) {
      const { position: p, orientation: o } = pose.transform;
      log(
        `Head pose: pos(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}) ` +
          `orient(${o.x.toFixed(2)}, ${o.y.toFixed(2)}, ${o.z.toFixed(2)}, ${o.w.toFixed(2)})`,
      );
    } else {
      log("Head pose: not yet tracked.");
    }

    const sources = Array.from(xrFrame.session.inputSources);
    if (sources.length === 0) {
      log("Controllers: none detected.");
    } else {
      for (const source of sources) {
        log(
          `Controller: handedness=${source.handedness} targetRayMode=${source.targetRayMode} ` +
            `gamepadButtons=${source.gamepad?.buttons.length ?? "n/a"}`,
        );
      }
    }
  };
  return frame;
}
