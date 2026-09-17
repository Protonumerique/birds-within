import { CLOCK } from './config';
import {
  viewFrame,
  type FromWorker,
  type GeodeticObserver,
  type SkyFrame,
  type ToWorker,
} from './sky-frame';

/** Two frames and how far scene time has moved from one to the other, 0..1. */
export interface FramePair {
  from: SkyFrame;
  to: SkyFrame;
  t: number;
}

export interface StreamStats {
  queued: number;
  inflight: number;
  hz: number;
  stepSeconds: number;
  computeMs: number;
}

/**
 * Requests allowed out at once. Three lets a resync fill the buffer in one burst;
 * stale ones still count, which is what stops a scrub drag from flooding the worker.
 */
const MAX_INFLIGHT = 3;
const POOL_LIMIT = 4;

/**
 * Ticks per second at a given time rate. At 1x the minimum is plenty. As the rate
 * climbs, ticks get more frequent so no two are more than `maxStepSeconds` of scene
 * time apart, up to a ceiling - past it, each blend spans a longer arc and cuts the
 * corner more, which at those speeds reads as motion blur anyway.
 */
function tickHz(rate: number): number {
  return Math.min(CLOCK.maxPropagationHz, Math.max(CLOCK.propagationHz, Math.ceil(rate / CLOCK.maxStepSeconds)));
}

const post = (worker: Worker, message: ToWorker, transfer: Transferable[] = []) => worker.postMessage(message, transfer);

/**
 * The render thread's view of the sky worker: a short buffer of frames running
 * ahead of scene time, and the pair bracketing "now" for the GPU to blend.
 *
 * Frames are requested ahead - two steps of lead - so by the time scene time
 * reaches a frame, the next one has already arrived. Any discontinuity in scene
 * time (scrub, NOW, a rate change) bumps the clock's generation; the buffer is
 * dropped and refilled from the new time, and until the first new frame lands the
 * last one stays on screen.
 */
export class SkyStream {
  readonly count: number;
  readonly names: string[];
  readonly kind: Uint8Array;
  /** Which family of birds each object sings with. See FAMILY in catalog-format.ts. */
  readonly family: Uint8Array;
  /** 1 where the object is in the geosynchronous belt: the choir, which never sets. */
  readonly choir: Uint8Array;
  readonly dropped: number;
  readonly generatedAt: Date;
  readonly initMs: number;

  private frames: SkyFrame[] = [];
  private generation = Number.NaN;
  private inflight = 0;
  private requestedUpTo = -Infinity;
  private nextId = 1;
  private pool: ArrayBuffer[] = [];
  private tracks = new Map<number, (directions: Float32Array) => void>();
  private stats: StreamStats = { queued: 0, inflight: 0, hz: 0, stepSeconds: 0, computeMs: 0 };

  /** Start the worker, hand it the catalogue (transferred, not copied), and wait until it can propagate. */
  static start(bytes: ArrayBuffer, observer: GeodeticObserver): Promise<SkyStream> {
    const worker = new Worker(new URL('./sky.worker.ts', import.meta.url), { type: 'module' });
    return new Promise((resolve, reject) => {
      worker.onerror = (event) => reject(new Error(`sky worker failed: ${event.message}`));
      worker.onmessage = (event: MessageEvent<FromWorker>) => {
        const msg = event.data;
        if (msg.type === 'ready') resolve(new SkyStream(worker, msg));
        else if (msg.type === 'error') reject(new Error(`sky worker: ${msg.message}`));
      };
      post(worker, { type: 'init', bytes, observer }, [bytes]);
    });
  }

  private constructor(
    private readonly worker: Worker,
    ready: Extract<FromWorker, { type: 'ready' }>
  ) {
    this.count = ready.count;
    this.names = ready.names;
    this.kind = ready.kind;
    this.family = ready.family;
    this.choir = ready.choir;
    this.dropped = ready.dropped;
    this.generatedAt = new Date(ready.generatedAt);
    this.initMs = ready.initMs;
    worker.onmessage = (event: MessageEvent<FromWorker>) => this.receive(event.data);
    worker.onerror = (event) => console.error('[sky worker]', event.message);
  }

  /**
   * Call once per rendered frame with the clock's state. Returns the frames to
   * blend for `now`, or null while there is nothing for the current generation yet
   * - in which case whatever is on screen should stay.
   */
  update(now: number, generation: number, rate: number): FramePair | null {
    if (generation !== this.generation) {
      this.generation = generation;
      this.recycle(this.frames.splice(0));
      this.requestedUpTo = -Infinity;
    }

    const hz = tickHz(rate);
    const step = (1000 / hz) * rate;

    // Frames wholly in the past are spent, except the one just before now.
    while (this.frames.length >= 2 && this.frames[1]!.time <= now) this.recycle([this.frames.shift()!]);

    while (this.inflight < MAX_INFLIGHT && this.requestedUpTo < now + 2 * step) {
      this.request(this.requestedUpTo < now ? now : this.requestedUpTo + step);
    }

    this.stats.queued = this.frames.length;
    this.stats.inflight = this.inflight;
    this.stats.hz = hz;
    this.stats.stepSeconds = step / 1000;

    return this.pairAt(now);
  }

  /** The newest frame at or before `now`, for readers that do not blend. */
  frameAt(now: number): SkyFrame | null {
    return this.pairAt(now)?.from ?? null;
  }

  requestTrack(
    index: number,
    centre: number,
    trail: { pastMinutes: number; futureMinutes: number; stepSeconds: number }
  ): Promise<Float32Array> {
    const id = this.nextId++;
    post(this.worker, { type: 'track', id, index, centre, ...trail });
    return new Promise((resolve) => this.tracks.set(id, resolve));
  }

  getStats(): Readonly<StreamStats> {
    return this.stats;
  }

  dispose(): void {
    this.worker.terminate();
  }

  private pairAt(now: number): FramePair | null {
    const f = this.frames;
    if (f.length === 0) return null;
    for (let i = f.length - 1; i >= 0; i--) {
      const from = f[i]!;
      if (from.time > now) continue;
      const to = f[i + 1];
      return to ? { from, to, t: (now - from.time) / (to.time - from.time) } : { from, to: from, t: 0 };
    }
    // Just resynced: now is already past the moment the first new frame was
    // requested for, but it has not been passed by a second one yet.
    return { from: f[0]!, to: f[0]!, t: 0 };
  }

  private request(time: number) {
    const id = this.nextId++;
    this.inflight++;
    this.requestedUpTo = time;
    const recycle = this.pool.splice(0);
    post(this.worker, { type: 'frame', id, generation: this.generation, time, recycle }, recycle);
  }

  private receive(msg: FromWorker) {
    switch (msg.type) {
      case 'frame':
        this.inflight--;
        this.stats.computeMs = msg.computeMs;
        if (msg.generation !== this.generation) {
          this.returnBuffer(msg.buffer);
          return;
        }
        this.frames.push(viewFrame(msg.buffer, msg.count, msg.time));
        break;
      case 'track':
        this.tracks.get(msg.id)?.(msg.directions);
        this.tracks.delete(msg.id);
        break;
      case 'error':
        console.error('[sky worker]', msg.message);
        break;
    }
  }

  private recycle(frames: SkyFrame[]) {
    for (const frame of frames) this.returnBuffer(frame.buffer);
  }

  private returnBuffer(buffer: ArrayBuffer) {
    if (this.pool.length < POOL_LIMIT) this.pool.push(buffer);
  }
}
