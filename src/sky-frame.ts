/**
 * The contract between the sky worker and the render thread.
 *
 * Kept free of three.js and satellite.js so both sides can import it without
 * dragging the other's dependencies across the thread boundary.
 */

/** Observer location in radians and kilometres - satellite.js's geodetic convention. */
export interface GeodeticObserver {
  latitude: number;
  longitude: number;
  height: number;
}

export function geodeticObserver(o: { latitudeDeg: number; longitudeDeg: number; heightKm: number }): GeodeticObserver {
  const rad = Math.PI / 180;
  return { latitude: o.latitudeDeg * rad, longitude: o.longitudeDeg * rad, height: o.heightKm };
}

/**
 * Horizontal coordinates to a unit direction in scene space - the one place this
 * mapping is defined, used by the worker for every object and by the scene for the
 * graticule.
 *
 * Azimuth runs from North through East, matching satellite.js's look angles. The
 * scene is right-handed with +Y up, +X East and -Z North, so the camera's default
 * forward (-Z) looks North.
 */
export function directionFromAltAz(azimuth: number, elevation: number, out: { [i: number]: number }, at = 0): void {
  const cosEl = Math.cos(elevation);
  out[at] = Math.sin(azimuth) * cosEl;
  out[at + 1] = Math.sin(elevation);
  out[at + 2] = -Math.cos(azimuth) * cosEl;
}

/** `range` holds this where SGP4 produced no position at that instant. */
export const NO_POSITION = -1;

/** direction xyz, azimuth, elevation, range, range rate, shadow. */
const FLOATS_PER_OBJECT = 8;

export const frameByteLength = (count: number) => FLOATS_PER_OBJECT * count * Float32Array.BYTES_PER_ELEMENT;

/**
 * Every object's state at one instant of scene time, as seen from the observer.
 *
 * Columnar and backed by a single ArrayBuffer, so a whole frame crosses the thread
 * boundary as one transfer - and goes back for reuse - instead of being built from
 * twenty thousand objects every tick. This is also the shape the sonification will
 * read.
 */
export interface SkyFrame {
  /** Scene time this frame describes, ms since 1970. */
  time: number;
  count: number;
  buffer: ArrayBuffer;
  /** Unit vector from the observer, scene space, xyz per object. Zero where there is no position. */
  direction: Float32Array;
  /** Radians, from North through East. */
  azimuth: Float32Array;
  /** Radians above the horizon. Negative means below it. */
  elevation: Float32Array;
  /** Kilometres from the observer, or NO_POSITION. */
  range: Float32Array;
  /**
   * km/s. Negative = approaching (frequency shifted up). Drives Doppler. From
   * DopplerFactorCalculator - see CLAUDE.md for how that was verified.
   */
  rangeRate: Float32Array;
  /** 0 = in full sunlight, 1 = in Earth's umbra. Below ~0.5 it is naked-eye visible. */
  shadow: Float32Array;
}

export function viewFrame(buffer: ArrayBuffer, count: number, time: number): SkyFrame {
  const column = (index: number, width = 1) =>
    new Float32Array(buffer, index * count * Float32Array.BYTES_PER_ELEMENT, width * count);
  return {
    time,
    count,
    buffer,
    direction: column(0, 3),
    azimuth: column(3),
    elevation: column(4),
    range: column(5),
    rangeRate: column(6),
    shadow: column(7),
  };
}

export type ToWorker =
  | { type: 'init'; bytes: ArrayBuffer; observer: GeodeticObserver }
  /** `recycle` hands spent frame buffers back so the worker need not allocate. */
  | { type: 'frame'; id: number; generation: number; time: number; recycle: ArrayBuffer[] }
  | {
      type: 'track';
      id: number;
      index: number;
      centre: number;
      pastMinutes: number;
      futureMinutes: number;
      stepSeconds: number;
    };

export type FromWorker =
  | {
      type: 'ready';
      count: number;
      names: string[];
      kind: Uint8Array;
      /** 1 where the object is in the geosynchronous belt - see isGeosynchronous. */
      /** Voice family per object, decided by the build. See FAMILY. */
      family: Uint8Array;
      choir: Uint8Array;
      /** Element sets SGP4 rejected at init - decayed or corrupt. */
      dropped: number;
      generatedAt: number;
      initMs: number;
    }
  | { type: 'frame'; id: number; generation: number; time: number; count: number; buffer: ArrayBuffer; computeMs: number }
  /** Unit directions, xyz per sample. */
  | { type: 'track'; id: number; directions: Float32Array }
  | { type: 'error'; message: string };
