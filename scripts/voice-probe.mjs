/**
 * Render each family's voice on its own into an OfflineAudioContext and measure it.
 *
 *     node scripts/voice-probe.mjs
 *
 * **Every gain in `AUDIO.performer.voices` is a measured number, not a chosen one**,
 * and this is what measures them. The trap it exists for is register: the ear is about
 * 6 dB less sensitive at 220 Hz than at 1 kHz and 8 dB less at 175, so a low family has
 * to *measure* hotter than a songbird to sit level with it. Tuning by ear-free RMS
 * alone once buried the geese 5.5 dB under the rest, and the navigation boom's first
 * gain peaked at 1.004 - clipping - while every individual number looked plausible.
 *
 * Three things it reports, and the third is the only one that can see a melody:
 *
 *   RMS and peak   balance, and whether anything clips before the master chain
 *   centroid       a direct DFT at log-spaced probes over one contiguous window.
 *                  A strided FFT aliases and once reported 11 kHz for a sub-bass
 *                  drone: a centroid that disagrees with what a thing obviously is
 *                  means the probe, not the sound.
 *   distinct pitches  dominant pitch per 40 ms window. Confounded by the sweep inside
 *                  a note, so the A/B below turns `steps` off and on over the same
 *                  object and seed - which is the measurement that actually separates
 *                  singing from calling.
 *
 * It drives the scheduler through `OfflineAudioContext.suspend`, because the lookahead
 * is 0.35 s: one `update` at time zero writes a third of a second and then silence.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5199 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
page.on('console', m => { if (m.type() === 'error') console.log('  [page]', m.text()); });
page.on('pageerror', e => console.log('  [pageerror]', e.message));
await page.goto('http://localhost:5199/?launch&catalog=synthetic', { waitUntil: 'domcontentloaded' });

const out = await page.evaluate(async () => {
  const { Performers } = await import('/src/performers.ts');
  const { FAMILY, KIND } = await import('/src/catalog-format.ts');
  const SR = 48000, SECONDS = 12, STEP = 0.2;

  const render = async (familyValue) => {
    const ctx = new OfflineAudioContext(2, SR * SECONDS, SR);
    const perf = new Performers(
      ctx, ctx.destination,
      new Uint8Array([KIND.OTHER]), new Uint8Array([familyValue]), new Uint8Array([0])
    );
    const el = 45 * Math.PI / 180;
    const frame = {
      time: 0, count: 1, buffer: new ArrayBuffer(0),
      direction: new Float32Array([0, Math.sin(el), -Math.cos(el)]),
      azimuth: new Float32Array([0]),
      elevation: new Float32Array([el]),
      range: new Float32Array([700]),
      rangeRate: new Float32Array([0]),
      shadow: new Float32Array([0]),
    };
    // Drive the scheduler as rendering proceeds: lookahead is 0.35 s, so one call
    // at time zero would write a third of a second and then silence.
    for (let t = STEP; t < SECONDS; t += STEP) {
      ctx.suspend(t).then(() => { perf.update(frame, [0], 0, false); ctx.resume(); });
    }
    perf.update(frame, [0], 0, false);
    return ctx.startRendering();
  };

  const measure = (buf) => {
    const a = buf.getChannelData(0), b = buf.getChannelData(1);
    const from = Math.floor(buf.length * 0.2);
    let sum = 0, peak = 0;
    for (let i = from; i < buf.length; i++) {
      const v = (a[i] + b[i]) / 2;
      sum += v * v; if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    const rms = Math.sqrt(sum / (buf.length - from));
    // Direct DFT at log-spaced probes over one contiguous window. A strided FFT
    // aliases everything above its Nyquist into the answer - it once reported 11 kHz
    // for a sub-bass drone.
    const W = 1 << 14, start = Math.floor(buf.length * 0.35);
    let num = 0, den = 0;
    for (let f = 50; f < 9000; f *= 1.1) {
      let re = 0, im = 0;
      for (let i = 0; i < W; i++) {
        const t = i / buf.sampleRate, v = (a[start + i] + b[start + i]) / 2;
        re += v * Math.cos(2 * Math.PI * f * t); im += v * Math.sin(2 * Math.PI * f * t);
      }
      const m = Math.hypot(re, im) / W;
      num += f * m; den += m;
    }
    // How much of the time anything is sounding at all - a hawk is mostly silence.
    let on = 0;
    for (let i = from; i < buf.length; i += 64) if (Math.abs((a[i] + b[i]) / 2) > peak * 0.05) on++;
    return { rms: rms > 0 ? 20 * Math.log10(rms) : -99, peak, centroid: den ? num / den : 0,
             duty: on / ((buf.length - from) / 64) };
  };

  // Does a phrase actually change note? Dominant pitch per 40 ms window, over the
  // windows loud enough to be a note, counted as distinct semitones. This is the one
  // measurement that separates singing from calling - RMS cannot see it at all.
  const pitches = (buf) => {
    const a = buf.getChannelData(0), b = buf.getChannelData(1);
    const W = Math.floor(buf.sampleRate * 0.04);
    const seen = new Set(); let notes = 0;
    for (let start = 0; start + W < buf.length; start += W) {
      let energy = 0;
      for (let i = 0; i < W; i++) { const v = (a[start+i]+b[start+i])/2; energy += v*v; }
      if (Math.sqrt(energy / W) < 0.02) continue;
      let bestF = 0, bestM = 0;
      for (let f = 80; f < 4000; f *= 1.012) {
        let re = 0, im = 0;
        for (let i = 0; i < W; i++) {
          const t = i / buf.sampleRate, v = (a[start+i]+b[start+i])/2;
          re += v * Math.cos(2*Math.PI*f*t); im += v * Math.sin(2*Math.PI*f*t);
        }
        const m = Math.hypot(re, im);
        if (m > bestM) { bestM = m; bestF = f; }
      }
      if (bestF) { seen.add(Math.round(12 * Math.log2(bestF / 55))); notes++; }
    }
    return { distinct: seen.size, windows: notes };
  };

  // A/B on the parameter itself, which is the only way to see it: the count above is
  // confounded by the sweep inside each note. Same object, same seed, steps on and off.
  const { AUDIO } = await import('/src/config.ts');
  const ab = {};
  for (const [name, fam] of [['weather', FAMILY.WEATHER], ['science', FAMILY.SCIENCE]]) {
    const spec = AUDIO.performer.voices[name];
    const was = spec.steps;
    spec.steps = 0;
    ab[name + ' steps:0'] = pitches(await render(fam));
    spec.steps = was;
    ab[name + ' steps:' + was] = pitches(await render(fam));
  }

  const res = { __ab: ab };
  for (const [name, value] of Object.entries({
    none: FAMILY.NONE, starlink: FAMILY.STARLINK, iridium: FAMILY.IRIDIUM,
    military: FAMILY.MILITARY, gnss: FAMILY.GNSS, weather: FAMILY.WEATHER,
    science: FAMILY.SCIENCE,
  })) {
    const buf = await render(value);
    res[name] = { ...measure(buf), ...pitches(buf) };
  }
  return res;
});

console.log('\n  voice      RMS dBFS    peak   centroid   distinct pitches');
console.log('\n  --- steps A/B, same object and seed ---');
for (const [k, v] of Object.entries(out.__ab))
  console.log(`  ${k.padEnd(18)} ${String(v.distinct).padStart(3)} distinct pitches over ${v.windows} windows`);
delete out.__ab;
for (const [k, v] of Object.entries(out))
  console.log(`  ${k.padEnd(9)} ${v.rms.toFixed(1).padStart(7)}  ${v.peak.toFixed(3).padStart(6)}  ${Math.round(v.centroid).toString().padStart(7)} Hz  ${String(v.distinct).padStart(6)} over ${v.windows} windows`);
await browser.close();
await server.close();
