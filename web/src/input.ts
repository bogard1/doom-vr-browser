// Converts xr-standard controller samples into Doom input and retains analog
// thumbstick/controller-pose state for M8's native locomotion bridge.
const KEY_PAD_LTHUMB_RIGHT = 0x1ac;
const KEY_PAD_LTHUMB_LEFT = 0x1ad;
const KEY_PAD_LTHUMB_DOWN = 0x1ae;
const KEY_PAD_LTHUMB_UP = 0x1af;
const KEY_PAD_RTHUMB_RIGHT = 0x1b0;
const KEY_PAD_RTHUMB_LEFT = 0x1b1;
const KEY_PAD_RTHUMB_DOWN = 0x1b2;
const KEY_PAD_RTHUMB_UP = 0x1b3;
const KEY_PAD_LTHUMB = 0x1ba;
const KEY_PAD_RTHUMB = 0x1bb;
const KEY_PAD_LSHOULDER = 0x1bc;
const KEY_PAD_RSHOULDER = 0x1bd;
const KEY_PAD_LTRIGGER = 0x1be;
const KEY_PAD_RTRIGGER = 0x1bf;
const KEY_PAD_A = 0x1c0;
const KEY_PAD_B = 0x1c1;
const KEY_PAD_X = 0x1c2;
const KEY_PAD_Y = 0x1c3;

const AXIS_PRESS_THRESHOLD = 0.6;
const AXIS_RELEASE_THRESHOLD = 0.45;

type KeyPostFn = (key: number, down: boolean) => void;

export interface XRLocomotion {
  validMask: number;
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
  leftYawDeg: number;
  rightYawDeg: number;
}

interface SourceState {
  keys: Set<number>;
  layout: "base" | "meta-touch";
}

interface StickKeys {
  right: number;
  left: number;
  down: number;
  up: number;
}

interface ButtonMapping {
  index: number;
  left: number;
  right: number;
}

const BUTTON_MAPPINGS: Record<SourceState["layout"], readonly ButtonMapping[]> = {
  base: [
    { index: 0, left: KEY_PAD_LTRIGGER, right: KEY_PAD_RTRIGGER },
    { index: 1, left: KEY_PAD_LSHOULDER, right: KEY_PAD_RSHOULDER },
    { index: 3, left: KEY_PAD_LTHUMB, right: KEY_PAD_RTHUMB },
  ],
  "meta-touch": [
    { index: 0, left: KEY_PAD_LTRIGGER, right: KEY_PAD_RTRIGGER },
    { index: 1, left: KEY_PAD_LSHOULDER, right: KEY_PAD_RSHOULDER },
    { index: 3, left: KEY_PAD_LTHUMB, right: KEY_PAD_RTHUMB },
    { index: 4, left: KEY_PAD_X, right: KEY_PAD_A },
    { index: 5, left: KEY_PAD_Y, right: KEY_PAD_B },
  ],
};

const LAYOUT_PROFILES: ReadonlyArray<{ layout: SourceState["layout"]; match: (profile: string) => boolean }> = [
  { layout: "meta-touch", match: (profile) => profile.includes("oculus-touch") || profile.includes("meta-touch") },
];

function getLayout(source: XRInputSource): SourceState["layout"] {
  return LAYOUT_PROFILES.find(({ match }) => source.profiles.some(match))?.layout ?? "base";
}

function readButton(gamepad: Gamepad, index: number): boolean {
  return gamepad.buttons[index]?.pressed ?? false;
}

function addStickDirections(keys: Set<number>, x: number, y: number, stick: StickKeys, previous: Set<number>): void {
  const active = (value: number, wasDown: boolean) => value > (wasDown ? AXIS_RELEASE_THRESHOLD : AXIS_PRESS_THRESHOLD);
  if (active(x, previous.has(stick.right))) keys.add(stick.right);
  if (active(-x, previous.has(stick.left))) keys.add(stick.left);
  if (active(y, previous.has(stick.down))) keys.add(stick.down);
  if (active(-y, previous.has(stick.up))) keys.add(stick.up);
}

function pulse(gamepad: Gamepad): void {
  const actuator = gamepad.vibrationActuator;
  if (!actuator) return;
  void actuator.playEffect("dual-rumble", {
    duration: 20,
    strongMagnitude: 0.2,
    weakMagnitude: 0.2,
  }).catch(() => {
    // Haptics are optional in WebXR and must not affect input when unavailable.
  });
}

export class WebXRInput {
  private sources = new Map<XRInputSource, SourceState>();

  update(inputSources: readonly XRInputSource[], enabled: boolean, postKey: KeyPostFn): void {
    const seen = new Set(inputSources);
    for (const [source, state] of this.sources) {
      if (!seen.has(source)) this.release(source, state, enabled, postKey);
    }
    for (const source of inputSources) {
      const gamepad = source.gamepad;
      if (!gamepad || gamepad.mapping !== "xr-standard" || (source.handedness !== "left" && source.handedness !== "right")) {
        const state = this.sources.get(source);
        if (state) this.release(source, state, enabled, postKey);
        continue;
      }

      const layout = getLayout(source);
      const state = this.sources.get(source);
      const desired = this.readKeys(source.handedness, gamepad, layout, state?.keys ?? new Set());
      if (!state || state.layout !== layout) {
        if (state) this.release(source, state, enabled, postKey);
        // Controllers often appear while a trigger is held. Baseline their
        // current state so connecting one never causes an accidental action.
        this.sources.set(source, { keys: desired, layout });
        continue;
      }

      for (const key of new Set([...state.keys, ...desired])) {
        const wasDown = state.keys.has(key);
        const isDown = desired.has(key);
        if (wasDown === isDown) continue;
        if (enabled) postKey(key, isDown);
        if (enabled && isDown && key === KEY_PAD_RTRIGGER) pulse(gamepad);
      }
      state.keys = desired;
    }
  }

  reset(enabled: boolean, postKey: KeyPostFn): void {
    for (const [source, state] of this.sources) this.release(source, state, enabled, postKey);
  }

  locomotion(
    inputSources: readonly XRInputSource[],
    frame: XRFrame,
    refSpace: XRReferenceSpace,
  ): XRLocomotion {
    const state: XRLocomotion = {
      validMask: 0,
      leftX: 0,
      leftY: 0,
      rightX: 0,
      rightY: 0,
      leftYawDeg: 0,
      rightYawDeg: 0,
    };
    for (const source of inputSources) {
      const gamepad = source.gamepad;
      if (!gamepad || gamepad.mapping !== "xr-standard" || (source.handedness !== "left" && source.handedness !== "right")) continue;

      const axisStart = gamepad.axes.length >= 4 ? 2 : 0;
      const x = gamepad.axes[axisStart];
      const y = gamepad.axes[axisStart + 1];
      const isLeft = source.handedness === "left";
      if (Number.isFinite(x) && Number.isFinite(y)) {
        state.validMask |= isLeft ? 1 : 2;
        if (isLeft) {
          state.leftX = x;
          state.leftY = y;
        } else {
          state.rightX = x;
          state.rightY = y;
        }
      }

      const pose = frame.getPose(source.gripSpace ?? source.targetRaySpace, refSpace);
      if (!pose) continue;
      const { x: qx, y: qy, z: qz, w: qw } = pose.transform.orientation;
      const yawDeg = -Math.atan2(2 * (qx * qz - qw * qy), 1 - 2 * (qx * qx + qy * qy)) * 180 / Math.PI;
      if (!Number.isFinite(yawDeg)) continue;
      state.validMask |= isLeft ? 4 : 8;
      if (isLeft) state.leftYawDeg = yawDeg;
      else state.rightYawDeg = yawDeg;
    }
    return state;
  }

  private release(source: XRInputSource, state: SourceState, enabled: boolean, postKey: KeyPostFn): void {
    if (enabled) {
      for (const key of state.keys) postKey(key, false);
    }
    this.sources.delete(source);
  }

  private readKeys(
    hand: XRHandedness,
    gamepad: Gamepad,
    layout: SourceState["layout"],
    previous: Set<number>,
  ): Set<number> {
    const keys = new Set<number>();
    for (const mapping of BUTTON_MAPPINGS[layout]) {
      if (readButton(gamepad, mapping.index)) keys.add(hand === "right" ? mapping.right : mapping.left);
    }

    const axisStart = gamepad.axes.length >= 4 ? 2 : 0;
    const stick: StickKeys = hand === "right"
      ? { right: KEY_PAD_RTHUMB_RIGHT, left: KEY_PAD_RTHUMB_LEFT, down: KEY_PAD_RTHUMB_DOWN, up: KEY_PAD_RTHUMB_UP }
      : { right: KEY_PAD_LTHUMB_RIGHT, left: KEY_PAD_LTHUMB_LEFT, down: KEY_PAD_LTHUMB_DOWN, up: KEY_PAD_LTHUMB_UP };
    addStickDirections(keys, gamepad.axes[axisStart] ?? 0, gamepad.axes[axisStart + 1] ?? 0, stick, previous);
    return keys;
  }
}
