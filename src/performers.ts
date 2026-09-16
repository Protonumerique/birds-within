import { AUDIO, HIGHLIGHT } from './config';
import { KIND } from './catalog-format';
import type { SkyFrame } from './sky-frame';

/**
 * The passes, as sound - and only the ones being kept.
 *
 * A thousand objects are above the horizon at any moment. Sonifying what is merely
 * *there* is the mush this piece exists to avoid, so the click is the instrument:
 * nothing sings until someone keeps it, and it stops when it sets. See AUDIO.performer
 * for why the textures are what they are and what each mapping is doing.
 *
 * **Everything is scheduled ahead.** Web Audio's clock is not the frame loop's, and a
 * chirp started from a `requestAnimationFrame` callback arrives whenever the frame did.
 * Each voice instead holds the context time of its next phrase, and `update` writes
 * every event that falls inside `lookaheadSeconds`. Frames may stutter; the song will
 * not.
 *
 * **A given object always sings the same song.** Pitch, sweep, phrase length and gap
 * come from a hash of its index - the same `sin`-and-fract trick the point shader uses
 * for the debris tumble - so keeping the same satellite twice sounds the same, and
 * several kept at once drift apart rather than locking into one pulse.
 */

const P = AUDIO.performer;
const FULL_BRIGHT = (HIGHLIGHT.fullBrightDeg * Math.PI) / 180;

type Timbre = 'bird' | 'machine' | 'shard';

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Deterministic 0..1 from an object index and a salt. As in the point shader. */
const hash = (index: number, salt: number) => {
  const x = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
};
const pick = (range: readonly number[], t: number) => lerp(range[0]!, range[1]!, t);

/**
 * How loud a voice is for how high its object sits - `HIGHLIGHT`'s own curve, so the
 * sound swells and fades in exact step with the ring dimming on screen. Same numbers,
 * two senses.
 */
const byElevation = (elevation: number) =>
  lerp(HIGHLIGHT.dimAtHorizon, 1, clamp(elevation / FULL_BRIGHT, 0, 1));

interface Voice {
  index: number;
  timbre: Timbre;
  /** Continuous, gated by `vca`. An oscillator, or looping noise for a shard. */
  osc: OscillatorNode | null;
  noise: AudioBufferSourceNode | null;
  /** The scheduled envelope: every chirp, pulse or burst is written onto this. */
  vca: GainNode;
  /** Lowpass, or a bandpass for a shard. Follows `shadow`. */
  filter: BiquadFilterNode;
  /** Elevation, and the arrival and departure ramps. */
  level: GainNode;
  pan: StereoPannerNode;
  baseHz: number;
  /** Context time the next phrase begins. */
  nextAt: number;
  /** Phrases written so far, so a bird's jitter differs from one to the next. */
  phrase: number;
  /** Context time this voice may be torn down, or Infinity while it is held. */
  endsAt: number;
}

export class Performers {
  private voices = new Map<number, Voice>();
  private dying: Voice[] = [];
  private noiseBuffer: AudioBuffer | null = null;

  constructor(private ctx: AudioContext, private out: AudioNode, private kind: Uint8Array) {}

  /** `kept` is every marked object that is not in the belt. */
  update(frame: SkyFrame, kept: readonly number[], heading: number): void {
    const now = this.ctx.currentTime;
    const rx = Math.cos(heading);
    const rz = Math.sin(heading);

    for (const i of kept) {
      if (this.voices.has(i) || this.voices.size >= P.maxVoices) continue;
      this.voices.set(i, this.make(i, now));
    }

    for (const [i, v] of this.voices) {
      if (kept.indexOf(i) < 0 || frame.range[i]! < 0) {
        this.release(v, now);
        this.voices.delete(i);
        continue;
      }
      this.steer(v, frame, i, rx, rz, now);
      // Write every event that falls inside the lookahead. A phrase is scheduled
      // whole, so this usually does nothing at all.
      let guard = 0;
      while (v.nextAt < now + P.lookaheadSeconds && guard++ < 8) {
        v.nextAt = this.schedule(v, Math.max(v.nextAt, now + 0.02));
        v.phrase++;
      }
    }

    for (let n = this.dying.length - 1; n >= 0; n--) {
      if (this.dying[n]!.endsAt > now) continue;
      this.stop(this.dying[n]!);
      this.dying.splice(n, 1);
    }
  }

  dispose(): void {
    for (const v of [...this.voices.values(), ...this.dying]) this.stop(v);
    this.voices.clear();
    this.dying.length = 0;
  }

  // --- per frame -------------------------------------------------------------

  /** Everything continuous: level from elevation, pan from direction, colour from shadow. */
  private steer(v: Voice, frame: SkyFrame, i: number, rx: number, rz: number, now: number): void {
    const gain = P.gain * P.timbreGain[v.timbre] * byElevation(frame.elevation[i]!);
    // The same ramp does two jobs: the voice's arrival, since `level` starts at zero,
    // and its swell as the object climbs. Elevation changes slowly enough that one
    // time constant covers both.
    v.level.gain.setTargetAtTime(gain, now, P.attackSeconds / 4);

    const pan = clamp(frame.direction[i * 3]! * rx + frame.direction[i * 3 + 2]! * rz, -1, 1);
    v.pan.pan.setTargetAtTime(pan * AUDIO.drone.panSpread, now, 0.09);

    // Sunlit is bright, eclipsed is muffled. `shadow` is 0 in full sunlight and 1 in
    // the umbra, and it is the one column nothing else in the audio path reads.
    const band = v.timbre === 'bird' ? P.bird.cutoffHz : v.timbre === 'machine' ? P.machine.cutoffHz : P.shard.bandHz;
    const open = v.timbre === 'shard' ? 1 : 1 - clamp(frame.shadow[i]!, 0, 1);
    v.filter.frequency.setTargetAtTime(pick(band, v.timbre === 'shard' ? hash(i, 7) : open), now, 0.4);

    // Doppler, exaggerated. Negative range rate is approaching, which shifts up.
    if (v.osc) {
      v.osc.detune.setTargetAtTime(-frame.rangeRate[i]! * P.dopplerCentsPerKmS, now, 0.12);
    }
  }

  // --- the songs -------------------------------------------------------------

  /** Writes one phrase from `at`, and answers when the next one should begin. */
  private schedule(v: Voice, at: number): number {
    if (v.timbre === 'bird') return this.birdPhrase(v, at);
    if (v.timbre === 'machine') return this.machinePulse(v, at);
    return this.shardBurst(v, at);
  }

  /**
   * Two to five swept chirps and then a gap. The gap is what carries most of the
   * character: it is long, so a bird is mostly silence, and several kept at once
   * interleave instead of chattering over each other.
   */
  private birdPhrase(v: Voice, at: number): number {
    const i = v.index;
    const n = Math.round(pick(P.bird.perPhrase, hash(i, 1)));
    const chirp = pick(P.bird.chirpMs, hash(i, 2)) / 1000;
    const spacing = pick(P.bird.spacingMs, hash(i, 3)) / 1000;
    const sweep = pick(P.bird.sweep, hash(i, 4));
    // Half the birds sweep up and half down, decided once per object.
    const rising = hash(i, 5) < 0.5;
    const from = rising ? v.baseHz / sweep : v.baseHz * sweep;
    const to = rising ? v.baseHz * sweep : v.baseHz / sweep;

    let t = at;
    for (let k = 0; k < n; k++) {
      // A little life per chirp, and per phrase, so a bird is never a metronome.
      const jitter = 0.75 + 0.5 * hash(i, 11 + k + v.phrase * 3);
      const dur = chirp * jitter;
      v.osc!.frequency.setValueAtTime(from, t);
      v.osc!.frequency.exponentialRampToValueAtTime(to, t + dur);
      this.strike(v, t, dur, 0.006, 0.7);
      t += dur + spacing * jitter;
    }
    return t + pick(P.bird.gapMs, hash(i, 6)) / 1000;
  }

  /** A spent stage is not a bird: lower, duller and regular, which is the point. */
  private machinePulse(v: Voice, at: number): number {
    const i = v.index;
    const dur = pick(P.machine.pulseMs, hash(i, 2)) / 1000;
    v.osc!.frequency.setValueAtTime(v.baseHz, at);
    this.strike(v, at, dur, 0.03, 0.55);
    return at + dur + pick(P.machine.gapMs, hash(i, 6)) / 1000;
  }

  /** Dry noise through a narrow band. Provisional - see AUDIO.performer. */
  private shardBurst(v: Voice, at: number): number {
    const i = v.index;
    const dur = pick(P.shard.burstMs, hash(i, 2 + v.phrase)) / 1000;
    this.strike(v, at, dur, 0.002, 0.3);
    return at + dur + pick(P.shard.gapMs, hash(i, 6 + v.phrase)) / 1000;
  }

  /**
   * One event on the envelope: up over `attack`, held for `hold` of the duration, then
   * down across what is left.
   *
   * **The hold is not decoration.** Without it - a single exponential from 1 to
   * silence across the whole chirp - the envelope spends almost all of its length near
   * zero and the voice measures 12 dB quieter than its peak suggests, which is how the
   * first pass came out 25 dB under the drone. It is also simply wrong: a bird's chirp
   * is a sustained whistle that sweeps, not a click. A machine holds longer still, and
   * a shard barely holds at all, which is most of what separates the three.
   */
  private strike(v: Voice, at: number, duration: number, attack: number, hold: number): void {
    const g = v.vca.gain;
    const rise = Math.min(attack, duration * 0.3);
    // Exponential ramps cannot reach zero, so the floor is inaudible rather than silent.
    g.setValueAtTime(0.0004, at);
    g.exponentialRampToValueAtTime(1, at + rise);
    g.setValueAtTime(1, at + Math.max(rise, duration * hold));
    g.exponentialRampToValueAtTime(0.0004, at + duration);
  }

  // --- voices ----------------------------------------------------------------

  private make(index: number, now: number): Voice {
    const { ctx } = this;
    const k = this.kind[index];
    const timbre: Timbre = k === KIND.DEBRIS ? 'shard' : k === KIND.ROCKET_BODY ? 'machine' : 'bird';

    const pan = ctx.createStereoPanner();
    pan.connect(this.out);
    const level = ctx.createGain();
    level.gain.value = 0;
    level.connect(pan);
    const filter = ctx.createBiquadFilter();
    filter.connect(level);
    const vca = ctx.createGain();
    vca.gain.value = 0.0004;
    vca.connect(filter);

    let osc: OscillatorNode | null = null;
    let noise: AudioBufferSourceNode | null = null;
    let baseHz = 0;

    if (timbre === 'shard') {
      filter.type = 'bandpass';
      filter.Q.value = P.shard.q;
      noise = ctx.createBufferSource();
      noise.buffer = this.noise();
      noise.loop = true;
      noise.connect(vca);
      noise.start();
    } else {
      filter.type = 'lowpass';
      filter.Q.value = 0.9;
      // Pitch from the object's own hash, quantised to a pentatonic so several kept
      // at once are a chord rather than a cluster.
      const ratio = P.ratios[Math.floor(hash(index, 0) * P.ratios.length) % P.ratios.length]!;
      const octave = Math.floor(hash(index, 9) * P.octaves);
      baseHz = P.rootHz * ratio * 2 ** octave;
      if (timbre === 'machine') baseHz /= 2 ** P.machine.octaveDown;
      osc = ctx.createOscillator();
      osc.type = timbre === 'machine' ? 'sawtooth' : 'sine';
      osc.frequency.value = baseHz;
      osc.connect(vca);
      osc.start();
    }

    return {
      index,
      timbre,
      osc,
      noise,
      vca,
      filter,
      level,
      pan,
      baseHz,
      // A beat before the first phrase, so keeping several at once does not fire
      // them all on the same instant.
      nextAt: now + 0.1 + hash(index, 13) * 0.5,
      phrase: 0,
      endsAt: Infinity,
    };
  }

  /** One second of white noise, made once and shared by every shard voice. */
  private noise(): AudioBuffer {
    if (this.noiseBuffer) return this.noiseBuffer;
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;
    return buf;
  }

  private release(v: Voice, now: number): void {
    v.level.gain.cancelScheduledValues(now);
    v.level.gain.setTargetAtTime(0, now, P.releaseSeconds / 4);
    v.endsAt = now + P.releaseSeconds;
    this.dying.push(v);
  }

  private stop(v: Voice): void {
    v.osc?.stop();
    v.osc?.disconnect();
    v.noise?.stop();
    v.noise?.disconnect();
    v.vca.disconnect();
    v.filter.disconnect();
    v.level.disconnect();
    v.pan.disconnect();
  }
}
