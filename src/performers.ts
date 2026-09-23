import { AUDIO, HIGHLIGHT, INTERFERENCE } from './config';
import { FAMILY, KIND, type Family } from './catalog-format';
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
const I = INTERFERENCE;
const FULL_BRIGHT = (HIGHLIGHT.fullBrightDeg * Math.PI) / 180;
/**
 * Separation thresholds as cosines, so nearness is a dot product and never an `acos`.
 * Note the sense: a *larger* cosine is a *smaller* angle.
 */
const NEAR_COS = Math.cos((I.nearDeg * Math.PI) / 180);
const FAR_COS = Math.cos((I.farDeg * Math.PI) / 180);

type Timbre = 'bird' | 'machine' | 'shard' | 'station';
/** One family's whole parameter set - see AUDIO.performer.voices. */
type BirdVoice = (typeof P.voices)['none'];

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Deterministic 0..1 from an object index and a salt. As in the point shader. */
const hash = (index: number, salt: number) => {
  const x = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
};
const pick = (range: readonly number[], t: number) => lerp(range[0]!, range[1]!, t);
const smoothstep = (t: number) => t * t * (3 - 2 * t);

/**
 * How loud a voice is for how high its object sits - `HIGHLIGHT`'s own curve, so the
 * sound swells and fades in exact step with the ring dimming on screen. Same numbers,
 * two senses.
 */
const byElevation = (elevation: number) =>
  lerp(HIGHLIGHT.dimAtHorizon, 1, clamp(elevation / FULL_BRIGHT, 0, 1));

/**
 * How far away it is, on a log ramp from `nearKm` down to `floor` at `farKm`.
 *
 * Elevation alone said nothing about distance, so something high and very far arrived
 * at the same level as something low and close. See AUDIO.performer.byRange for why
 * this is slant range, why the band is wide enough that a LEO pass barely feels it,
 * and why the belt cannot reach this code at all.
 */
const byRange = (km: number) => {
  const { nearKm, farKm, floor } = P.byRange;
  const span = Math.log(farKm / nearKm);
  return lerp(1, floor, clamp(Math.log(Math.max(km, nearKm) / nearKm) / span, 0, 1));
};

interface Voice {
  index: number;
  timbre: Timbre;
  /** Continuous, gated by `vca`. An oscillator, or looping noise for a shard. */
  osc: OscillatorNode | null;
  noise: AudioBufferSourceNode | null;
  /** The shard's swish and pulse, and every other voice's interference wobble. */
  lfos: OscillatorNode[];
  /** Which family this bird sings with, or null for a machine or a shard. */
  look: BirdVoice | null;
  /** The high-Q band that rings behind each note, where a family asks for one. */
  ring: BiquadFilterNode | null;
  /** How far a passing shard bends this voice's pitch, amplitude and colour. */
  warpPitch: GainNode | null;
  warpAm: GainNode | null;
  warpCut: GainNode | null;
  /** The scheduled envelope: every chirp, pulse or burst is written onto this. */
  vca: GainNode;
  /** Lowpass, or a bandpass for a shard. Follows `shadow`. */
  filter: BiquadFilterNode;
  /** Elevation, and the arrival and departure ramps. */
  level: GainNode;
  pan: StereoPannerNode;
  baseHz: number;
  /**
   * The root this voice's pentatonic is measured from, and which degree of it
   * `baseHz` sits on - so a melodic phrase can step to a neighbouring degree and
   * stay in the scale. `scaleHz * ratios[degree] === baseHz` by construction.
   */
  scaleHz: number;
  degree: number;
  /** Context time the next phrase begins. */
  nextAt: number;
  /** Phrases written so far, so a bird's jitter differs from one to the next. */
  phrase: number;
  /** Context time this voice may be torn down, or Infinity while it is held. */
  endsAt: number;
  /** Taps this voice's own output, so the panel can draw what it is doing. See AUDIO.performer.meter. */
  analyser: AnalyserNode;
  /** The smoothed level the panel reads, 0-1. Fast up, slow down. */
  meterLevel: number;
  /** A per-voice correction where a texture measures quieter than it should sit. */
  boost: number;
}

export class Performers {
  private voices = new Map<number, Voice>();
  private dying: Voice[] = [];
  private noiseBuffer: AudioBuffer | null = null;
  /** Indices of the shards currently sounding. Rebuilt per update, never reallocated. */
  private shards: number[] = [];
  /** Soft-clip curves, one per distinct drive amount, built once. */
  private curves = new Map<number, Float32Array<ArrayBuffer>>();
  /** Every shaper made, so `dispose` can let them go with the rest. */
  private shapers: WaveShaperNode[] = [];
  /** The station's tail. Built on first use, because most sessions never need it. */
  private reverbNode: ConvolverNode | null = null;
  /** Scratch for the meter reads. One array, reused by every voice, every frame. */
  private readonly meterBuf = new Float32Array(P.meter.fftSize);

  constructor(
    private ctx: AudioContext,
    private out: AudioNode,
    private kind: Uint8Array,
    private family: Uint8Array,
    /** 1 on a featured object. The ISS sings the station, whatever its `kind` says. */
    private featured: Uint8Array
  ) {}

  /**
   * A soft-clip curve, cached per amount. `0` is never asked for - a voice with no
   * drive is wired straight through rather than through an identity shaper.
   */
  private driveCurve(amount: number): Float32Array<ArrayBuffer> {
    const cached = this.curves.get(amount);
    if (cached) return cached;
    const n = 1024;
    const curve = new Float32Array(n);
    const k = amount * 40;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / (n - 1) - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    this.curves.set(amount, curve);
    return curve;
  }

  /**
   * `kept` is every marked object that is not in the belt.
   *
   * `held` is the clock being paused. It stops phrases being written and nothing
   * else: a voice already sounding keeps its level, its pan and its colour, because
   * those come from a frame that is no longer changing. See AUDIO.paused.
   */
  update(frame: SkyFrame, kept: readonly number[], heading: number, held: boolean): void {
    const now = this.ctx.currentTime;
    const rx = Math.cos(heading);
    const rz = Math.sin(heading);

    for (const i of kept) {
      if (this.voices.has(i) || this.voices.size >= P.maxVoices) continue;
      this.voices.set(i, this.make(i, now));
    }

    // Which shards are actually sounding. Only these deform anything - see
    // INTERFERENCE for why it is the kept ones and not every fragment up there.
    this.shards.length = 0;
    for (const [i, v] of this.voices) if (v.timbre === 'shard') this.shards.push(i);

    for (const [i, v] of this.voices) {
      if (kept.indexOf(i) < 0 || frame.range[i]! < 0) {
        this.release(v, now);
        this.voices.delete(i);
        continue;
      }
      this.steer(v, frame, i, rx, rz, now);
      // A shard has no phrase and nothing to schedule: it is a band of noise that is
      // simply there, swelling and sinking under its own LFOs.
      if (v.timbre === 'shard') continue;
      // Held: write nothing, and carry `nextAt` forward with the clock. Letting it
      // fall behind would make the guard below fire a backlog of phrases the moment
      // the clock started again - every held bird singing at once.
      if (held) {
        v.nextAt = Math.max(v.nextAt, now);
        continue;
      }
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

  /**
   * Fill `out` with one level per sounding object, 0-1: what the panel draws as a pulse.
   *
   * **The only thing that flows back from the sound to the image.** It is read from
   * each voice's own signal rather than worked out from the schedule, because phrases
   * are written ahead on the audio clock and anything derived from them would drift
   * against what is audible. See AUDIO.performer.meter.
   *
   * An object that is kept but has no voice - past `maxVoices` - simply is not in the
   * map. The panel draws no bar for it, which is the honest rendering of a mark that
   * is not sounding.
   */
  meter(out: Map<number, number>, dt: number): void {
    const M = P.meter;
    const buf = this.meterBuf;
    // Exponential, so the smoothing is frame-rate independent: the same rise whether
    // frames arrive at 60 Hz or 30.
    const up = 1 - Math.exp(-dt / M.attackSeconds);
    const down = 1 - Math.exp(-dt / M.releaseSeconds);
    out.clear();
    const span = M.topDb - M.floorDb;
    for (const [i, v] of this.voices) {
      v.analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let n = 0; n < buf.length; n++) sum += buf[n]! * buf[n]!;
      const rms = Math.sqrt(sum / buf.length);
      // In decibels, because the textures differ by three orders of magnitude - see
      // AUDIO.performer.meter. The guard keeps a silent voice off log(0).
      const db = 20 * Math.log10(Math.max(rms, 1e-7));
      const target = clamp((db - M.floorDb) / span, 0, 1);
      v.meterLevel += (target - v.meterLevel) * (target > v.meterLevel ? up : down);
      out.set(i, v.meterLevel);
    }
  }

  dispose(): void {
    for (const v of [...this.voices.values(), ...this.dying]) this.stop(v);
    this.voices.clear();
    this.dying.length = 0;
    for (const shaper of this.shapers) shaper.disconnect();
    this.shapers.length = 0;
    this.reverbNode?.disconnect();
    this.reverbNode = null;
  }

  // --- per frame -------------------------------------------------------------

  /** Everything continuous: level from elevation, pan from direction, colour from shadow. */
  private steer(v: Voice, frame: SkyFrame, i: number, rx: number, rz: number, now: number): void {
    // Range is always valid here: the loop above releases a voice whose object has
    // lost its position before steer is ever reached.
    const gain =
      P.gain *
      P.timbreGain[v.timbre] *
      (v.timbre === 'station' ? P.station.gain : 1) *
      (v.look?.gain ?? 1) *
      v.boost *
      byElevation(frame.elevation[i]!) *
      byRange(frame.range[i]!);
    // The same ramp does two jobs: the voice's arrival, since `level` starts at zero,
    // and its swell as the object climbs. Elevation changes slowly enough that one
    // time constant covers both.
    v.level.gain.setTargetAtTime(gain, now, P.attackSeconds / 4);

    const pan = clamp(frame.direction[i * 3]! * rx + frame.direction[i * 3 + 2]! * rz, -1, 1);
    v.pan.pan.setTargetAtTime(pan * AUDIO.drone.panSpread, now, 0.09);

    if (v.timbre === 'shard') {
      // A shard's band is swept by its own LFO around a fixed centre; there is nothing
      // to steer. Shadow says nothing about a fragment of metal that emits nothing.
      return;
    }

    // Sunlit is bright, eclipsed is muffled. `shadow` is 0 in full sunlight and 1 in
    // the umbra, and it is the one column nothing else in the audio path reads.
    const band = v.look
      ? v.look.cutoffHz
      : v.timbre === 'station'
        ? P.station.cutoffHz
        : P.machine.cutoffHz;
    const cutoff = pick(band, 1 - clamp(frame.shadow[i]!, 0, 1));
    v.filter.frequency.setTargetAtTime(cutoff, now, 0.4);

    // Doppler, exaggerated. Negative range rate is approaching, which shifts up.
    //
    // Not on the station: its oscillator's frequency is written per hit by the pitch
    // envelope, which is the percussion, and a detune riding under that would only
    // make the beat sag and rise. The pass is already legible in its level and its pan.
    if (v.timbre !== 'station') {
      v.osc!.detune.setTargetAtTime(-frame.rangeRate[i]! * P.dopplerCentsPerKmS, now, 0.12);
    }

    // And whatever wreckage is passing close to it in the sky. One wobble, three
    // destinations: pitch, amplitude and colour bending together is what reads as
    // damage - any one of them alone reads as vibrato, tremolo or a filter sweep.
    const near = this.nearestShard(frame, i);
    v.warpPitch?.gain.setTargetAtTime(near * I.sound.detuneCents, now, 0.3);
    v.warpAm?.gain.setTargetAtTime(near * I.sound.amDepth * gain, now, 0.3);
    v.warpCut?.gain.setTargetAtTime(near * I.sound.cutoffDepth * cutoff, now, 0.3);
  }

  /**
   * How hard the nearest sounding shard is deforming this voice: 1 when one sits
   * within `nearDeg` of it in the sky, 0 beyond `farDeg`.
   *
   * A dot product of two unit directions is the cosine of the angle between them, so
   * this is the same geometry the image shows and costs no trigonometry at all.
   */
  private nearestShard(frame: SkyFrame, i: number): number {
    if (this.shards.length === 0) return 0;
    const x = frame.direction[i * 3]!;
    const y = frame.direction[i * 3 + 1]!;
    const z = frame.direction[i * 3 + 2]!;
    let best = 0;
    for (const j of this.shards) {
      const cos =
        x * frame.direction[j * 3]! + y * frame.direction[j * 3 + 1]! + z * frame.direction[j * 3 + 2]!;
      if (cos <= FAR_COS) continue;
      const depth = smoothstep(clamp((cos - FAR_COS) / (NEAR_COS - FAR_COS), 0, 1));
      if (depth > best) best = depth;
    }
    return best;
  }

  // --- the songs -------------------------------------------------------------

  /** Writes one phrase from `at`, and answers when the next one should begin. */
  private schedule(v: Voice, at: number): number {
    if (v.timbre === 'bird') return this.birdPhrase(v, at);
    if (v.timbre === 'station') return this.stationPulse(v, at);
    return this.machinePulse(v, at);
  }

  /**
   * One low hit, and then a long wait. The percussion is the **pitch envelope** - a
   * fast drop from `attackHz` to `baseHz` is what a struck thing does, and it is the
   * whole difference between a beat and a bass note.
   *
   * Strictly regular, because this is a heartbeat rather than a rhythm, and slow
   * enough that nobody counts it.
   */
  private stationPulse(v: Voice, at: number): number {
    const S = P.station;
    const f = v.osc!.frequency;
    f.cancelScheduledValues(at);
    f.setValueAtTime(S.attackHz, at);
    f.exponentialRampToValueAtTime(S.baseHz, at + S.pitchDropSeconds);
    this.strike(v, at, S.bodySeconds, S.attack, S.hold);
    return at + S.periodSeconds;
  }

  /**
   * Two to five swept chirps and then a gap. The gap is what carries most of the
   * character: it is long, so a bird is mostly silence, and several kept at once
   * interleave instead of chattering over each other.
   */
  private birdPhrase(v: Voice, at: number): number {
    const i = v.index;
    const look = v.look!;
    const n = Math.round(pick(look.perPhrase, hash(i, 1)));
    const chirp = pick(look.noteMs, hash(i, 2)) / 1000;
    const spacing = pick(look.spacingMs, hash(i, 3)) / 1000;
    const sweep = pick(look.sweep, hash(i, 4));
    // Which way a note sweeps is the family's business: a songbird goes either way,
    // a goose falls a little, a hawk's scream only ever falls.
    const rising = hash(i, 5) < look.rise;

    let t = at;
    for (let k = 0; k < n; k++) {
      // A little life per chirp, and per phrase, so a bird is never a metronome.
      const jitter = 0.75 + 0.5 * hash(i, 11 + k + v.phrase * 3);
      const dur = chirp * jitter;
      // Where this note sits. At `steps: 0` that is always the voice's own pitch and
      // the phrase is one motif repeated, which is what a call is. Above 0 the note
      // takes its own degree of the object's pentatonic - and because the hash is
      // salted with the phrase counter, the next phrase is a different tune. That is
      // the whole of the difference between calling and singing.
      const note = look.steps > 0 ? this.stepHz(v, i, k) : v.baseHz;
      const from = rising ? note / sweep : note * sweep;
      const to = rising ? note * sweep : note / sweep;
      v.osc!.frequency.setValueAtTime(from, t);
      v.osc!.frequency.exponentialRampToValueAtTime(to, t + dur);
      this.strike(v, t, dur, look.attack, look.hold);
      t += dur + spacing * jitter;
    }
    return t + pick(look.gapMs, hash(i, 6)) / 1000;
  }

  /**
   * The pitch of note `k` of the current phrase, `look.steps` degrees either side of
   * the voice's own note and always inside its pentatonic.
   *
   * Stepping in **degrees rather than in ratios** is what keeps it musical: multiplying
   * the base by another ratio compounds the intervals and drifts out of the scale
   * within a couple of notes. Walking the table and carrying the octave cannot.
   */
  private stepHz(v: Voice, i: number, k: number): number {
    const n = P.ratios.length;
    const spread = v.look!.steps;
    // Salted with the phrase, so the motif is new each time round.
    const move = Math.round((hash(i, 41 + k * 2 + v.phrase * 5) * 2 - 1) * spread);
    const at = v.degree + move;
    const octave = Math.floor(at / n);
    const idx = ((at % n) + n) % n;
    return v.scaleHz * P.ratios[idx]! * 2 ** octave;
  }

  /**
   * A spent stage is not a bird: lower, harder and **regular**, which is the point.
   * The pulse and the gap come from the object's own hash and are never jittered, so
   * this is the one voice in the piece you can count along with.
   */
  private machinePulse(v: Voice, at: number): number {
    const i = v.index;
    const dur = pick(P.machine.pulseMs, hash(i, 2)) / 1000;
    v.osc!.frequency.setValueAtTime(v.baseHz, at);
    this.strike(v, at, dur, P.machine.attack, P.machine.hold);
    return at + dur + pick(P.machine.gapMs, hash(i, 6)) / 1000;
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
    const timbre: Timbre = this.featured[index] === 1
      ? 'station'
      : k === KIND.DEBRIS
        ? 'shard'
        : k === KIND.ROCKET_BODY
          ? 'machine'
          : 'bird';

    const pan = ctx.createStereoPanner();
    pan.connect(this.out);
    const level = ctx.createGain();
    level.gain.value = 0;
    level.connect(pan);
    // The meter taps the voice's own output: after its envelope and its colour, before
    // the pan and before the station's reverb send. What the bar shows is the voice
    // doing its thing, not where it happens to be in the stereo field.
    const analyser = ctx.createAnalyser();
    analyser.fftSize = P.meter.fftSize;
    level.connect(analyser);
    const filter = ctx.createBiquadFilter();
    filter.connect(level);
    const vca = ctx.createGain();
    vca.gain.value = 0.0004;
    vca.connect(filter);

    let osc: OscillatorNode | null = null;
    let noise: AudioBufferSourceNode | null = null;
    let warpPitch: GainNode | null = null;
    let warpAm: GainNode | null = null;
    let warpCut: GainNode | null = null;
    let ring: BiquadFilterNode | null = null;
    const lfos: OscillatorNode[] = [];
    let baseHz = 0;
    let scaleHz = 0;
    let degree = 0;
    let boost = 1;

    // A payload's family only refines a bird. A machine and a shard are what `kind`
    // says they are whatever constellation they were launched with.
    const look: BirdVoice | null =
      timbre === 'bird' ? P.voices[P.familyVoice[(this.family[index] ?? FAMILY.NONE) as Family]] : null;

    /**
     * An LFO driving an AudioParam, at `depth` either side of whatever that param is.
     *
     * The waveform matters for one caller: a sawtooth at *negative* depth snaps to
     * full and decays linearly, which is an impulse. A sine at the same rate and depth
     * is a wobble. See AUDIO.performer.shard.agitated.
     */
    const modulate = (
      rateHz: number,
      depth: number,
      target: AudioParam,
      wave: OscillatorType = 'sine'
    ): GainNode => {
      const lfo = ctx.createOscillator();
      lfo.type = wave;
      lfo.frequency.value = rateHz;
      // A quarter turn of phase per voice, so several shards never breathe in step.
      const amount = ctx.createGain();
      amount.gain.value = depth;
      lfo.connect(amount);
      amount.connect(target);
      lfo.start(this.ctx.currentTime + hash(index, 31) * 2);
      lfos.push(lfo);
      return amount;
    };

    if (timbre === 'station') {
      /*
       * A struck low tone through a soft lowpass, with a send to the shared reverb.
       *
       * The send is taken **post-level**, so the tail swells as the ISS climbs and
       * dies as it sets rather than hanging over a sky it has already left. It is also
       * pre-pan and therefore diffuse, which is what a room is: the hit moves across
       * the stereo field with the object, the space around it does not.
       */
      filter.type = 'lowpass';
      filter.Q.value = 0.7;
      baseHz = P.station.baseHz;
      osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = baseHz;
      osc.connect(vca);
      osc.start();

      const send = ctx.createGain();
      send.gain.value = P.station.reverbSend;
      level.connect(send);
      send.connect(this.reverb());

      // Wreckage passing close still chews it, but never bends its pitch: 320 cents on
      // a struck bass reads as a warped tape rather than as interference.
      const rate = pick(I.sound.wobbleHz, hash(index, 21));
      warpAm = modulate(rate, 0, level.gain);
      warpCut = modulate(rate, 0, filter.frequency);
    } else if (timbre === 'shard') {
      // Noise through a wide band that drifts, gated by nothing and breathing under
      // its own LFOs: the swish and the pulse are both continuous, so there is no
      // scheduled event anywhere in it.
      //
      // How fast it breathes, and how hard, is the fragment's own business. Most drift;
      // a share of them are agitated instead and pulse in the rhythm range off a
      // sawtooth, which gives each cycle an attack. See AUDIO.performer.shard.
      const agitated = hash(index, 23) < P.shard.agitatedShare;
      if (agitated) boost = P.shard.agitated.gain;
      // Not `look` - that name is the bird's family voice in the scope above.
      const temper = agitated ? P.shard.agitated : P.shard;
      filter.type = 'bandpass';
      filter.Q.value = agitated ? P.shard.agitated.q : P.shard.q;
      const mid = (P.shard.bandHz[0]! + P.shard.bandHz[1]!) / 2;
      const span = (P.shard.bandHz[1]! - P.shard.bandHz[0]!) / 2;
      filter.frequency.value = mid;
      modulate(pick(temper.swishHz, hash(index, 17)), span, filter.frequency);

      const depth = pick(temper.pulseDepth, hash(index, 19));
      vca.gain.value = 1 - depth;
      modulate(
        pick(temper.pulseHz, hash(index, 25)),
        agitated ? -depth : depth,
        vca.gain,
        agitated ? 'sawtooth' : 'sine'
      );

      noise = ctx.createBufferSource();
      noise.buffer = this.noise();
      noise.loop = true;
      noise.connect(vca);
      noise.start();
    } else {
      filter.type = 'lowpass';
      filter.Q.value = look ? look.q : 0.9;
      // Pitch from the object's own hash, quantised to a pentatonic so several kept
      // at once are a chord rather than a cluster.
      const degreeAt = Math.floor(hash(index, 0) * P.ratios.length) % P.ratios.length;
      const ratio = P.ratios[degreeAt]!;
      const octave = Math.floor(hash(index, 9) * P.octaves);
      baseHz = P.rootHz * ratio * 2 ** octave;
      degree = degreeAt;
      scaleHz = P.rootHz * 2 ** octave;
      if (timbre === 'machine') baseHz /= 2 ** P.machine.octaveDown;
      else if (look) {
        // The scale root moves with the note, or a melodic step would undo the
        // family's register - a nightingale an octave up must step an octave up too.
        baseHz *= 2 ** look.octaveShift;
        scaleHz *= 2 ** look.octaveShift;
      }
      osc = ctx.createOscillator();
      osc.type = look ? look.wave : 'sawtooth';
      osc.frequency.value = baseHz;
      osc.start();

      // Soft clipping, where a family should sound forced rather than blown. It sits
      // before the envelope so the drive is constant and only the level moves.
      const drive = look ? look.drive : timbre === 'machine' ? P.machine.drive : 0;
      if (drive > 0) {
        const shaper = ctx.createWaveShaper();
        shaper.curve = this.driveCurve(drive);
        osc.connect(shaper);
        shaper.connect(vca);
        this.shapers.push(shaper);
      } else {
        osc.connect(vca);
      }

      // A tremolo, where a family asks for one. It multiplies the envelope rather
      // than riding on it - an LFO on `vca.gain` adds to whatever the schedule says,
      // which is right for a shard (no gaps) and would sound straight through the
      // silences of anything with a phrase.
      if (look && look.tremDepth > 0) {
        const trem = ctx.createGain();
        trem.gain.value = 1 - look.tremDepth;
        vca.disconnect(filter);
        vca.connect(trem);
        trem.connect(filter);
        modulate(look.tremHz, look.tremDepth, trem.gain);
      }

      // And a high-Q band alongside the lowpass, struck by the same envelope: what
      // makes a voice ring like metal rather than simply sound like an oscillator.
      if (look && look.ring > 0) {
        ring = ctx.createBiquadFilter();
        ring.type = 'bandpass';
        ring.Q.value = P.ringQ;
        ring.frequency.value = baseHz * P.ringRatio;
        const ringLevel = ctx.createGain();
        ringLevel.gain.value = look.ring;
        vca.connect(ring);
        ring.connect(ringLevel);
        ringLevel.connect(level);
      }

      // One wobble, three destinations, all at zero until a shard comes near: it bends
      // the pitch, chews the amplitude and drags the filter at once, which is what
      // reads as deformation rather than as vibrato, tremolo or a sweep.
      const rate = pick(I.sound.wobbleHz, hash(index, 21));
      warpPitch = modulate(rate, 0, osc.detune);
      warpAm = modulate(rate, 0, level.gain);
      warpCut = modulate(rate, 0, filter.frequency);
    }

    return {
      index,
      timbre,
      osc,
      noise,
      lfos,
      look,
      ring,
      warpPitch,
      warpAm,
      warpCut,
      vca,
      filter,
      level,
      pan,
      baseHz,
      scaleHz,
      degree,
      // A beat before the first phrase, so keeping several at once does not fire
      // them all on the same instant.
      nextAt: now + 0.1 + hash(index, 13) * 0.5,
      phrase: 0,
      endsAt: Infinity,
      analyser,
      meterLevel: 0,
      boost,
    };
  }

  /**
   * The station's reverb: one convolver on a synthesised impulse, shared.
   *
   * Made rather than fetched - a decaying noise burst is what a plate sounds like
   * closely enough at this length, and an impulse response file would be the first
   * audio asset in a project whose entire catalogue is 831 KB.
   */
  private reverb(): ConvolverNode {
    if (this.reverbNode) return this.reverbNode;
    const S = P.station;
    const rate = this.ctx.sampleRate;
    const n = Math.max(1, Math.floor(rate * S.reverbSeconds));
    const buffer = this.ctx.createBuffer(2, n, rate);
    for (let c = 0; c < 2; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, S.reverbDecay);
    }
    const node = this.ctx.createConvolver();
    node.buffer = buffer;
    node.connect(this.out);
    this.reverbNode = node;
    return node;
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
    for (const lfo of v.lfos) {
      lfo.stop();
      lfo.disconnect();
    }
    v.ring?.disconnect();
    v.warpPitch?.disconnect();
    v.warpAm?.disconnect();
    v.warpCut?.disconnect();
    v.vca.disconnect();
    v.filter.disconnect();
    v.level.disconnect();
    v.analyser.disconnect();
    v.pan.disconnect();
  }
}
