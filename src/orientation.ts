/**
 * Point the phone at the sky: the device's own orientation drives the camera.
 *
 * This file owns the browser side only - permission, which event to listen to, and
 * turning what the event says into angles against true directions. The scene turns
 * those angles into a camera. Nothing here imports three.js.
 *
 * Three things differ between engines, and all three are handled here so nothing
 * else has to know:
 *
 * - **iOS asks.** `DeviceOrientationEvent.requestPermission()` exists there and must
 *   be called from inside a press, the same bargain the sound and the location make.
 *   Everywhere else it is absent and the events simply arrive.
 * - **"Which way is north" is a different field per engine.** Chrome on Android fires
 *   `deviceorientationabsolute`, whose alpha is measured from north. iOS fires only
 *   `deviceorientation`, whose alpha starts wherever the phone happened to be, and
 *   says where north is separately as `webkitCompassHeading`. The offset between the
 *   two is learned continuously and smoothed, because the compass is noisy.
 * - **The screen turns inside the device.** Held sideways, the picture is rotated
 *   against the hardware axes the angles are measured on; `screenDeg` carries that.
 *
 * A desktop browser often has `DeviceOrientationEvent` and never fires one. So
 * `start` waits for a real reading before it says yes.
 */

export interface Attitude {
  /** Radians, W3C convention, measured from north: rotation about the vertical. */
  alpha: number;
  /** Radians: front-to-back tilt. */
  beta: number;
  /** Radians: left-to-right tilt. */
  gamma: number;
  /** Radians: how far the screen is rotated inside the device (0, ±90°, 180°). */
  screen: number;
}

type OrientationEvent = DeviceOrientationEvent & { webkitCompassHeading?: number };
type PermissionCall = () => Promise<'granted' | 'denied' | 'default'>;

const DEG = Math.PI / 180;
/** How long to wait for a first reading before deciding there is no sensor. */
const WAIT_MS = 2500;
/** How much of the iOS compass offset each reading may move. Small: it is noisy. */
const COMPASS_BLEND = 0.05;

/** Whether to offer the mode at all: a sensor API, a finger, and a secure page. */
export function canPoint(): boolean {
  return (
    typeof window !== 'undefined' &&
    'DeviceOrientationEvent' in window &&
    window.isSecureContext &&
    matchMedia('(pointer: coarse)').matches
  );
}

export interface Pointing {
  /** The latest attitude against north, or null before the first usable reading. */
  readonly attitude: Attitude | null;
  readonly active: boolean;
  /** Ask, listen, and wait for a real reading. Call from inside a press. */
  start(): Promise<boolean>;
  stop(): void;
}

export function createPointing(): Pointing {
  let attitude: Attitude | null = null;
  let active = false;
  /** iOS only: what to add to alpha to measure it from north, in radians. */
  let compassOffset: number | null = null;
  let listening: { type: string; fn: (e: Event) => void } | null = null;

  const screenAngle = () =>
    ((screen.orientation?.angle ?? (window as { orientation?: number }).orientation ?? 0) as number) * DEG;

  const onEvent = (e: Event) => {
    const ev = e as OrientationEvent;
    if (ev.alpha == null || ev.beta == null || ev.gamma == null) return;
    let alpha = ev.alpha * DEG;

    if (!ev.absolute && typeof ev.webkitCompassHeading === 'number') {
      // Compass heading runs clockwise from north; alpha runs anticlockwise. The
      // offset that makes this alpha absolute is learned slowly, wrapped the short way.
      const target = (360 - ev.webkitCompassHeading) * DEG - alpha;
      if (compassOffset === null) compassOffset = target;
      else {
        const diff = Math.atan2(Math.sin(target - compassOffset), Math.cos(target - compassOffset));
        compassOffset += diff * COMPASS_BLEND;
      }
      alpha += compassOffset;
    } else if (!ev.absolute && e.type === 'deviceorientation') {
      // A relative reading with no compass beside it: the sky would be at an
      // arbitrary azimuth, which is worse than not pointing at all.
      return;
    }

    attitude = { alpha, beta: ev.beta * DEG, gamma: ev.gamma * DEG, screen: screenAngle() };
  };

  const listen = () => {
    // Absolute where the engine offers it; iOS offers only the relative event, and
    // carries its compass on that.
    const type = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    addEventListener(type, onEvent);
    listening = { type, fn: onEvent };
  };

  const unlisten = () => {
    if (listening) removeEventListener(listening.type, listening.fn);
    listening = null;
  };

  return {
    get attitude() {
      return active ? attitude : null;
    },
    get active() {
      return active;
    },

    async start() {
      const ask = (DeviceOrientationEvent as unknown as { requestPermission?: PermissionCall })
        .requestPermission;
      if (ask) {
        try {
          if ((await ask()) !== 'granted') return false;
        } catch {
          return false;
        }
      }
      attitude = null;
      compassOffset = null;
      listen();
      const deadline = performance.now() + WAIT_MS;
      while (!attitude && performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!attitude) {
        unlisten();
        return false;
      }
      active = true;
      return true;
    },

    stop() {
      active = false;
      attitude = null;
      unlisten();
    },
  };
}
