import { AUDIO } from './config';
import type { SkyFrame } from './sky-frame';
import { Drone } from './drone';
import { Performers } from './performers';

/**
 * The sound engine: the audio context, the master chain, and whatever is currently
 * playing on it.
 *
 * Two things play: the belt's drone, always, and a voice for each pass being kept.
 * They are siblings on one bus - `Drone` and `Performers` each own their own voices
 * and neither owns the context, which is why the debris interference can join them
 * later without either of them changing.
 *
 * **Nothing exists until the button is pressed.** A browser will not let a page make
 * a sound without a gesture, and there is no arguing with it, so "the drone is
 * audible from the start" has to mean "from the first press". The context, the
 * oscillators and the WASM-free cost of all of it are created on that press and not
 * before - a page nobody turns the sound on for pays nothing at all.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private drone: Drone | null = null;
  private performers: Performers | null = null;
  private on = false;
  private ducked = false;
  /** Pending suspend, so a quick MUTE-then-SOUND cannot strand the context asleep. */
  private sleep: ReturnType<typeof setTimeout> | null = null;
  /** The selection, split per update into the two buses. Reused, never reallocated. */
  private beltMarked: number[] = [];
  private passMarked: number[] = [];

  /**
   * `choir` and `kind` are the worker's per-object bytes. Which bus an object belongs
   * to, and what it sounds like, are facts about the object rather than the caller's
   * business, so the engine keeps them and does the splitting itself.
   */
  constructor(private choir: Uint8Array, private kind: Uint8Array) {}

  /** Whether the user has asked for sound, whatever the time rate is doing to it. */
  get enabled(): boolean {
    return this.on;
  }

  /** On, but silenced because the clock is running fast. See AUDIO.maxTimeRate. */
  get silenced(): boolean {
    return this.on && this.ducked;
  }

  /**
   * Turn sound on or off. Must be called from a user gesture the first time, or the
   * context is created suspended and never starts.
   */
  async toggle(): Promise<boolean> {
    if (!this.ctx) this.build();
    const ctx = this.ctx!;
    this.on = !this.on;
    if (this.sleep !== null) {
      clearTimeout(this.sleep);
      this.sleep = null;
    }
    if (this.on) {
      // A context created inside a click can still come up suspended on some
      // browsers; resuming is harmless when it is already running.
      if (ctx.state !== 'running') await ctx.resume();
    }
    this.applyMaster(AUDIO.fadeSeconds);
    // `setTargetAtTime` is asymptotic: it never actually reaches zero, so a muted
    // page would otherwise keep forty oscillators running for the life of the tab.
    // Suspend once the fade is inaudible, and only if the button has not come back.
    if (!this.on) {
      this.sleep = setTimeout(() => {
        this.sleep = null;
        if (!this.on) void ctx.suspend();
      }, AUDIO.fadeSeconds * 2000);
    }
    return this.on;
  }

  /**
   * Called every rendered frame. Cheap when sound is off - which is the common case,
   * so it returns before touching anything.
   *
   * `belt` is every geostationary object above the sky's floor and `marked` is the
   * whole selection, which the engine splits between the two buses itself.
   */
  update(
    frame: SkyFrame | null,
    belt: readonly number[],
    marked: ReadonlySet<number>,
    heading: number,
    timeRate: number
  ): void {
    if (!this.on || !this.ctx || !this.drone || !this.performers) return;

    // The clock runs faster than sound can mean anything: duck, do not stop. The
    // button's state has to survive a look-ahead, or every scrub would cost a press.
    const shouldDuck = Math.abs(timeRate) > AUDIO.maxTimeRate;
    if (shouldDuck !== this.ducked) {
      this.ducked = shouldDuck;
      this.applyMaster(AUDIO.duckSeconds);
    }
    if (shouldDuck || !frame) return;

    this.beltMarked.length = 0;
    this.passMarked.length = 0;
    for (const i of marked) (this.choir[i] === 1 ? this.beltMarked : this.passMarked).push(i);
    this.drone.update(frame, belt, this.beltMarked, heading);
    this.performers.update(frame, this.passMarked, heading);
  }

  private build(): void {
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = 0;

    // Voices accumulate as objects are kept - that is the whole design of the drone -
    // so the sum has to be caught somewhere. A gentle compressor rather than a
    // ceiling on the voice count: the brief asks for it to be able to get invasive.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 24;
    comp.ratio.value = 4;
    comp.attack.value = 0.05;
    comp.release.value = 0.4;

    master.connect(comp);
    comp.connect(ctx.destination);

    this.ctx = ctx;
    this.master = master;
    this.drone = new Drone(ctx, master);
    this.performers = new Performers(ctx, master, this.kind);
  }

  /** `seconds` is how long the move takes: a deliberate fade, or a quick duck. */
  private applyMaster(seconds: number): void {
    if (!this.ctx || !this.master) return;
    const target = this.on && !this.ducked ? AUDIO.masterGain : 0;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(target, now, seconds / 4);
  }
}
