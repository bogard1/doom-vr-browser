// WebXR session lifecycle, head pose, and controller enumeration, on a
// dedicated canvas/GL context entirely separate from the Emscripten canvas
// main.ts/engine.ts drive -- there is zero risk of a WebXR bug corrupting
// M3's desktop rendering.
//
// M5: onPose is called every XR frame (not just the throttled debug-log
// samples) with the raw head transform; main.ts forwards it into the engine
// via engine.ts's setWebXRHeadPose. This module deliberately stays ignorant
// of DoomModule/ccall -- main.ts is the only place that knows both sides
// exist, so this file works identically whether or not a WAD/engine has
// been loaded yet.
//
// Interim mirror renderer (until M6): entering VR used to show a solid
// black headset view, because nothing was ever drawn into the XR session's
// own framebuffer -- the Emscripten canvas keeps rendering mono Doom just
// fine, but that's a different canvas the XR compositor never sees. This
// file now blits that canvas into both eyes' viewports as a textured quad
// every XR frame, purely so M5's head-tracking math is visually checkable
// on real hardware. This is NOT M6: both eyes get the identical flat image
// (no per-eye pose/projection, no real depth) -- M6's own acceptance
// criteria explicitly rules that out as a *final* deliverable. M6 should
// replace createMirrorRenderer() with real per-eye rendering straight into
// the XR layer's framebuffer, at which point this whole mirror path (and
// the -sGL_TESTING=1 build flag it needs, see scripts/build-wasm.sh) goes
// away.

export type XRLogFn = (message: string) => void;
export type XRPoseFn = (
  orientation: { x: number; y: number; z: number; w: number },
  position: { x: number; y: number; z: number },
) => void;

let session: XRSession | null = null;
let refSpace: XRReferenceSpace | null = null;
let frameCount = 0;

// Roughly once a second regardless of the headset's refresh rate, so the
// debug log stays readable instead of scrolling at 90-144 lines/sec.
const LOG_EVERY_N_FRAMES = 90;

interface MirrorRenderer {
  updateTexture(): void;
  draw(view: XRView, layer: XRWebGLLayer): void;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Could not create a WebGL shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`XR mirror shader failed to compile: ${info}`);
  }
  return shader;
}

// A single full-viewport textured triangle (covers NDC (-1,-1)-(1,1) and
// beyond -- cheaper than a quad, and the excess is clipped) sampling
// sourceCanvas every frame. See the module-level comment for why this
// exists and why it is temporary.
function createMirrorRenderer(gl: WebGL2RenderingContext, sourceCanvas: HTMLCanvasElement): MirrorRenderer {
  const vertexSource = `#version 300 es
    layout(location = 0) in vec2 aPos;
    out vec2 vUv;
    void main() {
      vUv = aPos * 0.5 + 0.5;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `;
  const fragmentSource = `#version 300 es
    precision mediump float;
    in vec2 vUv;
    uniform sampler2D uTex;
    out vec4 outColor;
    void main() {
      outColor = texture(uTex, vec2(vUv.x, 1.0 - vUv.y));
    }
  `;

  const program = gl.createProgram();
  if (!program) throw new Error("Could not create the XR mirror program.");
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`XR mirror program failed to link: ${gl.getProgramInfoLog(program)}`);
  }

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const uTexLoc = gl.getUniformLocation(program, "uTex");

  return {
    updateTexture() {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      // Requires the source canvas's WebGL context to have been created
      // with preserveDrawingBuffer:true (-sGL_TESTING=1 in
      // scripts/build-wasm.sh) -- otherwise its backbuffer is undefined by
      // the time this runs from the XR session's separate frame loop, and
      // this silently uploads a blank/garbage image instead of erroring.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
    },
    draw(view, layer) {
      const viewport = layer.getViewport(view);
      if (!viewport) return;
      gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(uTexLoc, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}

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

export async function enterVR(
  log: XRLogFn,
  onSessionEnd: () => void,
  onPose: XRPoseFn,
  sourceCanvas: HTMLCanvasElement,
): Promise<void> {
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
  const layer = new XRWebGLLayer(session, gl);
  session.updateRenderState({ baseLayer: layer });

  try {
    refSpace = await session.requestReferenceSpace("local-floor");
    log("XR session started (local-floor reference space).");
  } catch {
    refSpace = await session.requestReferenceSpace("local");
    log("XR session started ('local-floor' unavailable, fell back to 'local').");
  }

  const mirror = createMirrorRenderer(gl, sourceCanvas);

  frameCount = 0;
  session.requestAnimationFrame(onXRFrame(log, onPose, gl, layer, mirror));
}

export function exitVR(): void {
  void session?.end();
}

function onXRFrame(
  log: XRLogFn,
  onPose: XRPoseFn,
  gl: WebGL2RenderingContext,
  layer: XRWebGLLayer,
  mirror: MirrorRenderer,
): XRFrameRequestCallback {
  const frame: XRFrameRequestCallback = (_time, xrFrame) => {
    if (!session || !refSpace) return;
    session.requestAnimationFrame(frame);
    frameCount++;

    const pose = xrFrame.getViewerPose(refSpace);
    const shouldLog = frameCount % LOG_EVERY_N_FRAMES === 1;

    if (pose) {
      const { position: p, orientation: o } = pose.transform;
      // Every frame, not throttled -- the engine needs continuous tracking;
      // only the debug log below is rate-limited.
      onPose(
        { x: o.x, y: o.y, z: o.z, w: o.w },
        { x: p.x, y: p.y, z: p.z },
      );
      if (shouldLog) {
        log(
          `Head pose: pos(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}) ` +
            `orient(${o.x.toFixed(2)}, ${o.y.toFixed(2)}, ${o.z.toFixed(2)}, ${o.w.toFixed(2)})`,
        );
      }

      // Interim mirror (see module comment) -- draw the same flat image
      // into both eyes' viewports so there's *something* to look at until
      // M6's real per-eye renderer exists.
      gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
      mirror.updateTexture();
      for (const view of pose.views) {
        mirror.draw(view, layer);
      }
    } else if (shouldLog) {
      log("Head pose: not yet tracked.");
    }

    if (!shouldLog) return;

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
