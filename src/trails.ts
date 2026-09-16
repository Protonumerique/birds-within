import { TRAIL } from './config';

/** Just the part of SkyStream this needs - one object's track, on demand. */
export interface TrackSource {
  requestTrack(
    index: number,
    centre: number,
    trail: { pastMinutes: number; futureMinutes: number; stepSeconds: number }
  ): Promise<Float32Array>;
}

interface Track {
  /** Scene time the track is centred on. */
  centre: number;
  /** Unit directions, xyz per sample. */
  directions: Float32Array;
}

/**
 * The tracks of the objects being kept, one worker request at a time.
 *
 * A track is a few hundred JS propagations in the worker, which shares its thread
 * with the frame ticks every object on screen depends on. So the number of requests
 * out at once is capped, and a track is only recomputed once scene time has drifted
 * far enough for it to be visibly wrong. At 100x that means the tracks lag a little -
 * which is right: at that rate a 70-minute track crosses the sky in forty seconds, and
 * frames matter more.
 *
 * Nothing here knows about the clock's generation. A rate change bumps it without
 * moving scene time, and blinking every track off for that would be worse than the
 * drift; a real jump shows up as drift on the next update and is corrected then.
 */
export class Trails {
  private tracks = new Map<number, Track>();
  private inflight = new Set<number>();

  /** Bumped whenever a track lands or is dropped, so the scene rebuilds only then. */
  version = 0;

  constructor(private source: TrackSource) {}

  get(index: number): Float32Array | undefined {
    return this.tracks.get(index)?.directions;
  }

  /** Keep tracks for exactly these objects, centred near this scene time. */
  update(wanted: readonly number[], now: number): void {
    for (const index of this.tracks.keys()) {
      if (!wanted.includes(index)) {
        this.tracks.delete(index);
        this.version++;
      }
    }

    let budget = TRAIL.maxInflight - this.inflight.size;
    if (budget <= 0) return;

    // Stalest first, so one object cannot starve the others of the request budget.
    const due = wanted
      .filter((i) => !this.inflight.has(i))
      .map((i) => ({ i, drift: Math.abs(now - (this.tracks.get(i)?.centre ?? -Infinity)) }))
      .filter((d) => d.drift > TRAIL.refreshSeconds * 1000)
      .sort((a, b) => b.drift - a.drift);

    for (const { i } of due) {
      if (budget-- <= 0) break;
      this.request(i, now);
    }
  }

  private request(index: number, centre: number): void {
    this.inflight.add(index);
    this.source.requestTrack(index, centre, TRAIL).then((directions) => {
      this.inflight.delete(index);
      this.tracks.set(index, { centre, directions });
      this.version++;
    });
  }
}
