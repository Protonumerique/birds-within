/**
 * The sky worker: every orbit computation in the app happens here.
 *
 * It decodes the packed catalogue, builds a satrec per object, and answers two
 * questions from the render thread: "where is everything at scene time t?" (one
 * SkyFrame, from the WASM BulkPropagator) and "what is this one object's track?"
 * (a few hundred JS propagations). The render thread never propagates, so it never
 * stalls for it.
 *
 * Single-threaded WASM, deliberately. The pthreads runtime needs SharedArrayBuffer,
 * which needs COOP/COEP headers, which GitHub Pages cannot send - and this is fast
 * enough without it: 17 ms per tick for the 21k-object `full` catalogue, measured.
 */

import {
  json2satrec,
  propagate,
  gstime,
  eciToEcf,
  ecfToLookAngles,
  geodeticToEcf,
  createSingleThreadRuntime,
  BulkPropagator,
  EciBaseCalculator,
  GmstCalculator,
  EcfPositionCalculator,
  EcfVelocityCalculator,
  LookAnglesCalculator,
  DopplerFactorCalculator,
  SunPositionCalculator,
  ShadowFractionCalculator,
  type SatRec,
} from 'satellite.js';
import { decodeCatalog, isGeosynchronous } from './catalog-format';
import {
  NO_POSITION,
  directionFromAltAz,
  frameByteLength,
  viewFrame,
  type FromWorker,
  type GeodeticObserver,
  type ToWorker,
} from './sky-frame';

const SPEED_OF_LIGHT_KM_S = 299_792.458;
/** Spent frame buffers kept for reuse. Two in play plus a little slack. */
const POOL_LIMIT = 4;

type Runtime = Awaited<ReturnType<typeof createSingleThreadRuntime>>;
type Observer = Parameters<typeof ecfToLookAngles>[0];

function createPropagator(runtime: Runtime, count: number) {
  return new BulkPropagator({
    runtime,
    calculators: [
      new EciBaseCalculator(),
      new GmstCalculator(),
      new EcfPositionCalculator(),
      new EcfVelocityCalculator(),
      new LookAnglesCalculator(),
      // Range rate for Doppler. Verified against a central difference of range on
      // the whole catalogue: within 3 m/s above the horizon, the residual being
      // SDP4's own velocity on deep-space orbits. The forward difference this
      // replaced was 69 m/s off, and differencing costs a second propagation.
      new DopplerFactorCalculator(),
      new SunPositionCalculator(),
      new ShadowFractionCalculator(),
    ],
    satRecsCount: count,
    datesCount: 1,
  });
}

interface Sky {
  satrecs: SatRec[];
  runtime: Runtime;
  propagator: ReturnType<typeof createPropagator>;
  observer: Observer;
  observerEcf: ReturnType<typeof geodeticToEcf>;
}

let sky: Sky | null = null;
const pool: ArrayBuffer[] = [];

const post = (message: FromWorker, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer);

async function init(bytes: ArrayBuffer, geodetic: GeodeticObserver) {
  const started = performance.now();
  const packed = decodeCatalog(bytes);

  const satrecs: SatRec[] = [];
  const names: string[] = [];
  const kinds: number[] = [];
  const families: number[] = [];
  const choirs: number[] = [];
  let dropped = 0;
  for (let i = 0; i < packed.count; i++) {
    const elements = packed.elementsAt(i);
    const satrec = json2satrec({ ...elements, OBJECT_ID: '', ELEMENT_SET_NO: 0 });
    if (satrec.error) {
      dropped++;
      continue;
    }
    satrecs.push(satrec);
    names.push(packed.names[i]!);
    kinds.push(packed.kind[i]!);
    families.push(packed.family[i]!);
    // Read from the elements, here, because this is the only place they exist: the
    // render thread transfers the catalogue away and never sees a mean motion.
    choirs.push(isGeosynchronous(elements) ? 1 : 0);
  }

  // Replacing a live propagator: its WASM memory is not garbage collected.
  if (sky) {
    sky.propagator.dispose();
    sky.runtime.dispose();
    sky = null;
  }

  const runtime = await createSingleThreadRuntime();
  const propagator = createPropagator(runtime, satrecs.length);
  propagator.setSatRecs(satrecs);

  const observer = geodetic as unknown as Observer;
  sky = { satrecs, runtime, propagator, observer, observerEcf: geodeticToEcf(observer) };

  const kind = Uint8Array.from(kinds);
  const family = Uint8Array.from(families);
  const choir = Uint8Array.from(choirs);
  post(
    {
      type: 'ready',
      count: satrecs.length,
      names,
      kind,
      family,
      choir,
      dropped,
      generatedAt: packed.generatedAt.getTime(),
      initMs: performance.now() - started,
    },
    [kind.buffer, family.buffer, choir.buffer]
  );
}

function computeFrame(s: Sky, time: number, reuse: ArrayBuffer | undefined): ArrayBuffer {
  const n = s.satrecs.length;
  const buffer = reuse && reuse.byteLength === frameByteLength(n) ? reuse : new ArrayBuffer(frameByteLength(n));
  const frame = viewFrame(buffer, n, time);

  s.propagator.setDates([new Date(time)]);
  s.propagator.run({ lookAngles: { observer: s.observer }, dopplerFactor: { observer: s.observerEcf } });
  const out = s.propagator.getRawOutput();
  const look = out.lookAngles;
  const error = out.eci.error;
  const doppler = out.dopplerFactor;
  const shadow = out.shadowFraction;
  const { direction, azimuth, elevation, range, rangeRate, shadow: shade } = frame;

  for (let i = 0; i < n; i++) {
    if (error[i]) {
      range[i] = NO_POSITION;
      direction[i * 3] = direction[i * 3 + 1] = direction[i * 3 + 2] = 0;
      azimuth[i] = elevation[i] = rangeRate[i] = shade[i] = 0;
      continue;
    }
    const az = look[i * 3]!;
    const el = look[i * 3 + 1]!;
    azimuth[i] = az;
    elevation[i] = el;
    range[i] = look[i * 3 + 2]!;
    directionFromAltAz(az, el, direction, i * 3);
    rangeRate[i] = (1 - doppler[i]!) * SPEED_OF_LIGHT_KM_S;
    shade[i] = shadow[i]!;
  }

  return buffer;
}

/** One object's path across the sky. A few hundred samples, so plain JS is plenty. */
function computeTrack(s: Sky, index: number, centre: number, past: number, future: number, step: number): Float32Array {
  const satrec = s.satrecs[index];
  if (!satrec) return new Float32Array(0);
  const samples: number[] = [];
  for (let offset = -past * 60; offset <= future * 60; offset += step) {
    const t = new Date(centre + offset * 1000);
    const pv = propagate(satrec, t);
    if (!pv?.position) continue;
    const look = ecfToLookAngles(s.observer, eciToEcf(pv.position, gstime(t)));
    const at = samples.length;
    samples.push(0, 0, 0);
    directionFromAltAz(look.azimuth, look.elevation, samples, at);
  }
  return Float32Array.from(samples);
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case 'init':
        await init(msg.bytes, msg.observer);
        break;

      case 'frame': {
        for (const b of msg.recycle) if (pool.length < POOL_LIMIT) pool.push(b);
        if (!sky) return;
        const started = performance.now();
        const buffer = computeFrame(sky, msg.time, pool.pop());
        post(
          {
            type: 'frame',
            id: msg.id,
            generation: msg.generation,
            time: msg.time,
            count: sky.satrecs.length,
            buffer,
            computeMs: performance.now() - started,
          },
          [buffer]
        );
        break;
      }

      case 'track': {
        if (!sky) return;
        const directions = computeTrack(sky, msg.index, msg.centre, msg.pastMinutes, msg.futureMinutes, msg.stepSeconds);
        post({ type: 'track', id: msg.id, directions }, [directions.buffer]);
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
