import { AUDIO } from './config';
import type { SkyFrame } from './sky-frame';

/**
 * The choir, as sound: a permanent bass bed under the geosynchronous belt, and one
 * defined voice for every belt object the user keeps.
 *
 * The belt is not a set of passes and is not sonified as one. From Berlin it is a
 * fixed arc across the southern sky whose membership barely changes, so it has no
 * events - no rise, no set, no Doppler worth hearing. What it has is *extent*: a
 * hundred and fifty degrees of sky with five hundred objects strung along it. That
 * is what this plays.
 *
 * **Slices, not objects.** The belt is sorted by azimuth - the same order the grid
 * in the panel is built in - and cut into as many slices as there are pitches in
 * `AUDIO.drone.ratios`, each holding roughly the same number of objects. One bass
 * voice per slice, panned to the mean direction of its members. Five hundred
 * oscillators would not be a drone, it would be noise; nine tuned ones panned across
 * the arc are the belt heard as a shape.
 *
 * **Keeping an object pulls a voice out of the bed.** A kept belt object gets its own
 * oscillator an octave above its slice, through a resonant filter that opens as it
 * arrives, detuned by where it sits *inside* that slice - so two neighbours kept
 * together beat against each other. It is in tune with the bed because it is the
 * bed's own pitch: the voice steps forward rather than arriving from somewhere else.
 *
 * Nothing here reads the clock. The belt does not move, so this is driven by
 * membership and by where the camera is pointing, and by nothing else.
 */

const D = AUDIO.drone;
/** One voice per pitch. The two cannot disagree, because there is only one number. */
const SLICES = D.ratios.length;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * What fraction of `soloGain` each kept voice gets, given how many are kept.
 *
 * One voice alone was overpowering - it arrived at full strength over a bed tuned to
 * sit back, so a single click jumped out of the image. The belt is a choir, and one
 * singer at full voice is the wrong shape for it. Every voice, the first included,
 * rises toward full as more are kept.
 *
 * It only ever attenuates: at `fullAt` the sum is exactly what that many voices cost
 * before, and below it, less.
 */
function soloShare(count: number): number {
  const { first, fullAt, curve } = D.soloRamp;
  if (count <= 1) return first;
  const t = clamp((count - 1) / (fullAt - 1), 0, 1);
  return first + (1 - first) * t ** curve;
}

interface Bed {
  /** Voice level. The breath LFO is summed into this param, so it is never read back. */
  level: GainNode;
  /** Depth of that breath, scaled with the level so the LFO cannot invert the gain. */
  breath: GainNode;
  pan: StereoPannerNode;
  /** Mean direction of the slice's members, scene space. Recut, not per frame. */
  dir: Float32Array;
  members: number;
}

interface Solo {
  index: number;
  gain: GainNode;
  filter: BiquadFilterNode;
  pan: StereoPannerNode;
  oscs: OscillatorNode[];
  /** Context time this voice may be torn down, or Infinity while it is held. */
  endsAt: number;
}

export class Drone {
  private bed: Bed[] = [];
  private solo = new Map<number, Solo>();
  /** Voices in their release, still sounding, no longer addressable. */
  private dying: Solo[] = [];
  /** Which slice each belt object belongs to, rebuilt whenever the slices are recut. */
  private sliceOf = new Map<number, number>();
  /** Position within the slice, -0.5..0.5, for a kept voice's detune. */
  private placeOf = new Map<number, number>();
  private members = 0;
  private lastRegroup = -Infinity;

  constructor(private ctx: AudioContext, private out: AudioNode) {
    for (let k = 0; k < SLICES; k++) this.bed.push(this.makeBed(k));
  }

  /**
   * `up` is every belt object above the sky's floor, in any order - the same list the
   * grid is built from. `marked` is whichever of those the user is keeping. `heading`
   * is the camera's yaw, from which the stereo axis falls out.
   */
  update(frame: SkyFrame, up: readonly number[], marked: readonly number[], heading: number): void {
    const now = this.ctx.currentTime;

    // The stereo axis is the camera's right vector. With up = +Y and the view
    // direction built from yaw and pitch, the cross product loses the pitch term
    // entirely: right is (cos yaw, 0, sin yaw) whatever the camera is looking at.
    // Panning by its dot with an object's direction therefore also does the right
    // thing overhead, where there is no left or right and the dot goes to zero.
    const rx = Math.cos(heading);
    const rz = Math.sin(heading);

    if (now - this.lastRegroup > D.regroupMs / 1000 || up.length !== this.members) {
      this.regroup(frame, up);
      this.lastRegroup = now;
    }

    for (const voice of this.bed) {
      const occupancy = clamp(voice.members / D.fullAt, 0, 1);
      const level = voice.members === 0
        ? 0
        : D.bedGain * (D.floorLevel + (1 - D.floorLevel) * occupancy);
      voice.level.gain.setTargetAtTime(level, now, 0.6);
      voice.breath.gain.setTargetAtTime(level * D.breathDepth, now, 0.6);
      voice.pan.pan.setTargetAtTime(this.panOf(voice.dir[0]!, voice.dir[2]!, rx, rz), now, 0.09);
    }

    this.tendSolos(frame, marked, rx, rz, now);
  }

  /** Silence and tear the whole thing down. The context outlives it. */
  dispose(): void {
    for (const voice of [...this.solo.values(), ...this.dying]) this.stop(voice);
    this.solo.clear();
    this.dying.length = 0;
    for (const voice of this.bed) voice.pan.disconnect();
  }

  // --- the bed ---------------------------------------------------------------

  private makeBed(k: number): Bed {
    const { ctx } = this;
    const freq = D.rootHz * D.ratios[k]!;

    const level = ctx.createGain();
    level.gain.value = 0;
    const pan = ctx.createStereoPanner();
    level.connect(pan);
    pan.connect(this.out);

    // Two sines a few cents apart, plus a triangle an octave up for body. Sines
    // because nine voices of anything richer, this low, is porridge.
    this.osc('sine', freq, -D.detuneCents / 2).connect(level);
    this.osc('sine', freq, +D.detuneCents / 2).connect(level);
    const body = ctx.createGain();
    body.gain.value = D.bodyGain;
    this.osc('triangle', freq * 2, 0).connect(body);
    body.connect(level);

    // Each voice breathes at its own rate, the lowest slowest, so the bed drifts in
    // and out of phase with itself instead of pulsing as one block. The LFO is summed
    // into the level's own param; its depth is a fraction of that level, so the gain
    // can dip toward zero but never through it.
    const breath = ctx.createGain();
    breath.gain.value = 0;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = D.breathHz[0]! + (D.breathHz[1]! - D.breathHz[0]!) * (k / Math.max(1, SLICES - 1));
    lfo.connect(breath);
    breath.connect(level.gain);
    lfo.start();

    return { level, breath, pan, dir: new Float32Array(3), members: 0 };
  }

  private osc(type: OscillatorType, freq: number, detuneCents: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = detuneCents;
    o.start();
    return o;
  }

  /**
   * Recut the slices from the belt as it currently stands.
   *
   * Equal population rather than equal angle: the belt is not evenly filled, and a
   * slice of empty sky would be a voice that is silent for no audible reason. Equal
   * counts mean every voice is always present and the *spacing* of the pans carries
   * where the objects actually are.
   */
  private regroup(frame: SkyFrame, up: readonly number[]): void {
    this.members = up.length;
    this.sliceOf.clear();
    this.placeOf.clear();

    const order = [...up].sort((a, b) => frame.azimuth[a]! - frame.azimuth[b]!);
    for (let k = 0; k < SLICES; k++) {
      const from = Math.floor((k * order.length) / SLICES);
      const to = Math.floor(((k + 1) * order.length) / SLICES);
      const voice = this.bed[k]!;
      voice.members = to - from;
      let x = 0;
      let y = 0;
      let z = 0;
      for (let n = from; n < to; n++) {
        const i = order[n]!;
        this.sliceOf.set(i, k);
        // -0.5..0.5 across the slice, so a kept voice's detune says where inside it
        // the object sits. Two neighbours kept at once land a few cents apart.
        this.placeOf.set(i, voice.members > 1 ? (n - from) / (voice.members - 1) - 0.5 : 0);
        x += frame.direction[i * 3]!;
        y += frame.direction[i * 3 + 1]!;
        z += frame.direction[i * 3 + 2]!;
      }
      const len = Math.hypot(x, y, z) || 1;
      voice.dir[0] = x / len;
      voice.dir[1] = y / len;
      voice.dir[2] = z / len;
    }
  }

  private panOf(dx: number, dz: number, rx: number, rz: number): number {
    return clamp(dx * rx + dz * rz, -1, 1) * D.panSpread;
  }

  // --- the kept voices -------------------------------------------------------

  private tendSolos(
    frame: SkyFrame,
    marked: readonly number[],
    rx: number,
    rz: number,
    now: number
  ): void {
    for (const i of marked) {
      if (this.solo.has(i)) continue;
      if (this.solo.size >= D.maxSolo) continue;
      const voice = this.makeSolo(i, now);
      if (voice) this.solo.set(i, voice);
    }

    for (const [i, voice] of this.solo) {
      if (marked.indexOf(i) >= 0) continue;
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setTargetAtTime(0, now, D.releaseSeconds / 4);
      voice.filter.frequency.setTargetAtTime(D.soloCutoffHz / 6, now, D.releaseSeconds / 4);
      voice.endsAt = now + D.releaseSeconds;
      this.dying.push(voice);
      this.solo.delete(i);
    }

    // Every voice's level depends on how many are singing, so it is set here rather
    // than once at birth: taking one away brings the rest down with it, exactly as
    // adding one brought them up.
    const share = D.soloGain * soloShare(this.solo.size);
    for (const [i, voice] of this.solo) {
      voice.gain.gain.setTargetAtTime(share, now, D.attackSeconds / 4);
      voice.pan.pan.setTargetAtTime(
        this.panOf(frame.direction[i * 3]!, frame.direction[i * 3 + 2]!, rx, rz),
        now,
        0.09
      );
    }

    for (let n = this.dying.length - 1; n >= 0; n--) {
      if (this.dying[n]!.endsAt > now) continue;
      this.stop(this.dying[n]!);
      this.dying.splice(n, 1);
    }
  }

  private makeSolo(index: number, now: number): Solo | null {
    const slice = this.sliceOf.get(index);
    if (slice === undefined) return null;
    const { ctx } = this;

    const freq = D.rootHz * D.ratios[slice]! * 2 ** D.soloOctaves;
    const detune = (this.placeOf.get(index) ?? 0) * D.soloDetuneCents * 2;

    const pan = ctx.createStereoPanner();
    pan.connect(this.out);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(pan);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = D.soloQ;
    filter.frequency.value = D.soloCutoffHz / 6;
    filter.connect(gain);

    // A sawtooth through a resonant lowpass that opens as the voice arrives. Present
    // rather than loud: the bed is already carrying the level, and what a kept object
    // needs is an edge the bed does not have.
    const oscs = [this.osc('sawtooth', freq, detune), this.osc('sine', freq / 2, detune)];
    for (const o of oscs) o.connect(filter);

    // Level is not set here - `tendSolos` sets every voice's from how many there are.
    filter.frequency.setTargetAtTime(D.soloCutoffHz, now, D.attackSeconds / 3);

    return { index, gain, filter, pan, oscs, endsAt: Infinity };
  }

  private stop(voice: Solo): void {
    for (const o of voice.oscs) {
      o.stop();
      o.disconnect();
    }
    voice.filter.disconnect();
    voice.gain.disconnect();
    voice.pan.disconnect();
  }
}
