import { GATE, GROUP_LOOK, HIGHLIGHT, KIND_LOOK, PALETTE, SKY, TRAIL } from './config';

/**
 * The drawing on the first screen: a poster of the sky, in the sky's own grammar.
 *
 * Every colour here comes from `PALETTE`, `KIND_LOOK` and `HIGHLIGHT` rather than
 * from a stylesheet, so the cover and the piece behind it cannot drift apart. The
 * rules it obeys are the piece's own:
 *
 * - **No Earth geometry.** A horizon, a dome and what is above it. Nothing else.
 * - **Hue is category, value is state.** Warm white passing, neutral grey eclipsed,
 *   blue for the belt. Amber appears exactly once, on the one object something is
 *   paying attention to, which is what makes amber read as attention.
 * - **Debris is a shard, not a light**, and it turns.
 * - **No tags.** Not one character is drawn on the sky, here either.
 * - **The belt does not move.** Everything else drifts, very slowly; the belt holds
 *   still, which is the contrast the whole piece trades on.
 *
 * It is drawn rather than screenshotted on purpose. A screenshot goes stale the first
 * time the image changes, and a cover that shows a photograph of what is behind it
 * reads as a substitute for the thing rather than as a way in to it.
 */

/**
 * The poster's own space. 16:9, and **anchored at the horizon**: a frame shorter than
 * 16:9 - which a hero section is - crops the zenith rather than the ground, because the
 * horizon is what the image has to measure itself against. Hence the thin strip of
 * ground: the horizon has to sit near the bottom of the frame after that anchoring, not
 * near the bottom of this viewBox.
 *
 * What survives the crop, and therefore where anything that must be seen has to go: a
 * 16:9 frame shows all of it; a wide hero shows the bottom two thirds; a phone shows
 * full height and about a third of the width, centred.
 */
const W = 1600;
const H = 900;
const HORIZON = 856;
const ZENITH = 56;

/** Elevation in degrees to the poster's y. Linear: this is a drawing, not a projection. */
const y = (elevationDeg: number) => HORIZON - (elevationDeg / 90) * (HORIZON - ZENITH);

/**
 * The same sin-and-fract hash the point shader uses for the debris tumble, and for
 * the same reason: a given object is always drawn the same way, with nothing stored.
 */
function hash(i: number, salt: number): number {
  const x = Math.sin(i * 127.1 + salt * 311.7 + GATE.poster.seed * 74.7) * 43758.5453;
  return x - Math.floor(x);
}

/** A hex colour scaled toward black - what a mark drawn at reduced intensity reads as. */
function dim(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * k);
  return `#${[ch(16), ch(8), ch(0)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * How far the haze has eaten an object at this elevation. The piece's own rule: sky
 * coloured at the horizon, clear by `SKY.haze.topDeg`.
 */
const through = (elevationDeg: number) =>
  Math.min(1, Math.max(0, elevationDeg / SKY.haze.topDeg)) ** 0.8;

/** A round mark: a core, and the flare around it that makes it read as something lit. */
function light(x: number, cy: number, r: number, color: string, alpha: number, glow: number) {
  return (
    `<circle cx="${x.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(r * 3.4).toFixed(1)}" fill="${color}" ` +
    `opacity="${(alpha * 0.1 * glow).toFixed(3)}"/>` +
    `<circle cx="${x.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(r * 1.7).toFixed(1)}" fill="${color}" ` +
    `opacity="${(alpha * 0.22 * glow).toFixed(3)}"/>` +
    `<circle cx="${x.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${color}" ` +
    `opacity="${alpha.toFixed(3)}"/>`
  );
}

/**
 * A shard: a flat triangle, no glow, turning at its own rate. As on the sky.
 *
 * It spins about its own centre through `transform-box: fill-box` in the stylesheet
 * rather than a `transform-origin` written in here - user-space coordinates would have
 * to be kept in step with the points, and the box already knows where its centre is.
 */
function shard(x: number, cy: number, r: number, alpha: number, spinSeconds: number, phase: number) {
  const pts = [0, 1, 2]
    .map((k) => {
      const a = (k * 2 * Math.PI) / 3 - Math.PI / 2;
      return `${(x + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
    })
    .join(' ');
  return (
    `<polygon class="tumble" points="${pts}" fill="${GROUP_LOOK.debris.tone}" ` +
    `opacity="${alpha.toFixed(3)}" ` +
    `style="animation-duration:${spinSeconds.toFixed(1)}s;animation-delay:-${phase.toFixed(1)}s"/>`
  );
}

/**
 * The dome: a horizon, two lines of constant elevation and a few meridians converging
 * somewhere above the frame. Faint, and drawn **over** the haze - which is the piece's
 * own render order, so the dome stays legible all the way down while the objects in it
 * do not.
 */
function graticule(): string {
  const ink = '#7fa6bf';
  const parts: string[] = [];
  for (const el of [30, 60]) {
    const mid = y(el);
    const edge = mid + (HORIZON - mid) * 0.34;
    parts.push(
      `<path d="M0 ${edge.toFixed(1)} Q ${W / 2} ${(mid - (edge - mid) * 0.9).toFixed(1)} ${W} ${edge.toFixed(1)}" ` +
        `fill="none" stroke="${ink}" stroke-width="1" opacity="0.09"/>`
    );
  }
  // Meridians, converging on a zenith that sits above the frame - the dome seen from
  // inside it, rather than a grid drawn on a rectangle.
  for (let i = -3; i <= 3; i++) {
    const x = W / 2 + i * 300;
    parts.push(
      `<line x1="${x}" y1="${HORIZON}" x2="${W / 2 + i * 34}" y2="${ZENITH - 150}" ` +
        `stroke="${ink}" stroke-width="1" opacity="0.06"/>`
    );
  }
  parts.push(
    `<line x1="0" y1="${HORIZON}" x2="${W}" y2="${HORIZON}" stroke="${ink}" stroke-width="1.2" opacity="0.26"/>`
  );
  return parts.join('');
}

/**
 * The belt: a fixed arc across the south, peaking at 30° in the middle of the frame
 * and sinking to the horizon at either edge. Blue in every state, because belonging to
 * it is a permanent fact about an object and not a condition it is passing through.
 *
 * A few sit off the line. Those are the inclined and drifting ones - the graveyard,
 * and the ones left wandering when station-keeping stopped.
 */
function belt(): string {
  const n = GATE.poster.belt;
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n; // 0..1 across the frame: east to west
    const x = 40 + t * (W - 80);
    const el = 30 * Math.cos((t - 0.5) * Math.PI) - 1.5 + hash(i, 3) * 3;
    // The stragglers, drawn off the arc rather than on it.
    const stray = hash(i, 4) < 0.14 ? (hash(i, 5) - 0.5) * 58 : 0;
    const cy = y(el) + stray;
    if (el < SKY.lowestVisibleDeg) continue;
    const a = 0.45 + 0.45 * through(el);
    parts.push(light(x, cy, 2.3, PALETTE.geostationary, a, 0.7));
  }
  return parts.join('');
}

/**
 * The passes, and the one that is being watched.
 *
 * Elevation is biased low, because most of a hemisphere is near its rim; size grows
 * with elevation, because in the piece size is range and high means close. About a
 * third are eclipsed - there, tracked, and invisible to the eye.
 */
function passes(): { marks: string; tracks: string; ring: string } {
  const n = GATE.poster.passing;
  const marks: string[] = [];
  const tracks: string[] = [];
  // Whichever object the pointer has taken. One, high enough to be clearly in the
  // image, and the only amber on the screen.
  let ring = '';
  let bestEl = -1;

  for (let i = 0; i < n; i++) {
    const el = 90 * hash(i, 1) ** 1.35;
    if (el < SKY.lowestVisibleDeg) continue;
    const x = 30 + hash(i, 2) * (W - 60);
    const cy = y(el);
    const lit = hash(i, 6) > 0.34;
    const r = 1.5 + 2.1 * (el / 90) * (0.7 + hash(i, 7) * 0.6);
    const a = (lit ? 0.95 : 0.55) * through(el);
    marks.push(light(x, cy, r, lit ? PALETTE.lit : PALETTE.eclipsed, a, lit ? 1 : 0.35));

    // A few ambient tracks, because an orbit is a line through a point and not a dot.
    if (hash(i, 8) < 0.1 && el > 14) {
      const dx = 150 + hash(i, 9) * 210;
      const slope = (hash(i, 10) - 0.5) * 1.1;
      tracks.push(
        `<path d="M${(x - dx).toFixed(1)} ${(cy + dx * slope * 0.5).toFixed(1)} ` +
          `Q ${x.toFixed(1)} ${(cy - 26).toFixed(1)} ${(x + dx).toFixed(1)} ${(cy - dx * slope * 0.5).toFixed(1)}" ` +
          `fill="none" stroke="${TRAIL.color}" stroke-width="1.1" opacity="0.2"/>`
      );
    }

    // The watched one, and the only amber on the screen. It has to survive every crop
    // - see the note on the viewBox - so it is taken from a band across the middle of
    // the frame rather than from whatever happens to be highest.
    if (x > W * 0.54 && x < W * 0.7 && el > bestEl && el < 52) {
      bestEl = el;
      const d = HIGHLIGHT.diameterPx * 1.55;
      const dx = 300;
      ring =
        `<path d="M${(x - dx).toFixed(1)} ${(cy + 96).toFixed(1)} Q ${x.toFixed(1)} ${(cy - 40).toFixed(1)} ` +
        `${(x + dx).toFixed(1)} ${(cy + 74).toFixed(1)}" fill="none" stroke="${HIGHLIGHT.markColor}" ` +
        `stroke-width="1.4" opacity="0.5"/>` +
        `<circle cx="${x.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(d / 2).toFixed(1)}" fill="none" ` +
        `stroke="${HIGHLIGHT.markColor}" stroke-width="${HIGHLIGHT.strokePx * 1.4}" opacity="0.92"/>`;
    }
  }
  return { marks: marks.join(''), tracks: tracks.join(''), ring };
}

/** The wreckage, spread wider and lower than the payloads, and turning. */
function shards(): string {
  const n = GATE.poster.shards;
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const el = 90 * hash(i, 11) ** 1.6;
    if (el < SKY.lowestVisibleDeg) continue;
    const x = 30 + hash(i, 12) * (W - 60);
    const r = 3.4 + 3.2 * (el / 90) * KIND_LOOK.debris.size;
    const a = 0.85 * through(el);
    // Each fragment at its own rate and phase, as on the sky. `spinRpm` is turns a
    // minute; the poster runs them far slower, because nothing here is being tracked.
    const seconds = (60 / KIND_LOOK.debris.spinRpm) * (6 + hash(i, 13) * 10);
    parts.push(shard(x, y(el), r, a, seconds, hash(i, 14) * seconds));
  }
  return parts.join('');
}

/**
 * The whole poster, as one SVG string.
 *
 * Drawn in the piece's own render order: tracks and marks first, then the rings, then
 * the haze over all of it, and the dome last so its structure survives to the horizon.
 */
export function posterSvg(): string {
  const { marks, tracks, ring } = passes();
  return (
    `<svg class="poster" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice" ` +
    `aria-hidden="true" focusable="false">` +
    `<defs>` +
    // Haze: the sky's own colour rising off the horizon, so objects come into view as
    // they climb rather than popping over an edge.
    `<linearGradient id="haze" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${PALETTE.sky}" stop-opacity="0"/>` +
    `<stop offset="0.55" stop-color="${PALETTE.sky}" stop-opacity="0.55"/>` +
    `<stop offset="1" stop-color="${PALETTE.sky}" stop-opacity="${SKY.haze.horizonOpacity}"/>` +
    `</linearGradient>` +
    // The faintest lift toward the zenith, so the frame is not a flat field of one value.
    `<radialGradient id="dome" cx="0.5" cy="1" r="1.1">` +
    `<stop offset="0" stop-color="${dim(PALETTE.geostationary, 0.14)}" stop-opacity="0.5"/>` +
    `<stop offset="1" stop-color="${PALETTE.sky}" stop-opacity="0"/>` +
    `</radialGradient>` +
    `</defs>` +
    `<rect width="${W}" height="${H}" fill="${PALETTE.sky}"/>` +
    `<rect width="${W}" height="${H}" fill="url(#dome)"/>` +
    // Everything that moves drifts, very slowly. The belt is not in this group: those
    // objects never rise and never set, and the poster says so by holding them still.
    `<g class="drift">${tracks}${marks}${shards()}</g>` +
    belt() +
    ring +
    `<rect x="0" y="${y(SKY.haze.topDeg)}" width="${W}" height="${H - y(SKY.haze.topDeg)}" fill="url(#haze)"/>` +
    `<rect x="0" y="${HORIZON}" width="${W}" height="${H - HORIZON}" fill="${PALETTE.sky}"/>` +
    graticule() +
    `</svg>`
  );
}
