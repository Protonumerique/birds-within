/** Where the observer stands. Everything in this app is relative to this point. */
export const OBSERVER = {
  name: 'Berlin',
  latitudeDeg: 52.52,
  longitudeDeg: 13.405,
  /** Height above the WGS-84 ellipsoid, in kilometres. */
  heightKm: 0.034,
};

/**
 * Which packed catalogue to load - all src/catalog-format.ts binaries in public/data/.
 *
 * - `full`      the union of every CelesTrak GP dataset. 20,933 on 2026-09-13 - all
 *               the sky CelesTrak publishes: every payload, but only ~3k of the ~15k
 *               debris on orbit. The default. See scripts/catalog-sources.mjs.
 * - `active`    every payload CelesTrak lists as active. 16,563 on 2026-09-13 - the
 *               same sky with the wreckage removed.
 * - `synthetic` ~1450 INVENTED orbits, committed so development works offline. Not
 *               real objects, and the HUD says so whenever it is showing.
 *
 * `active` and `full` are built by `npm run fetch:catalog` locally and by deploy.yml
 * in CI. They are not in git.
 *
 * Which of the two real images the piece wants is an aesthetic question, so it is
 * answerable by looking rather than by rebuilding: `?catalog=full` overrides this.
 */
export type Dataset = 'active' | 'full' | 'synthetic';

/**
 * `full` since 2026-09-14. The piece is about density, and `active` is payloads only:
 * it leaves out the ~3k debris fragments and ~500 rocket bodies that are the whole
 * argument for the image. Once debris had a mark of its own - a turning shard - there
 * was no reason to keep publishing a sky with the wreckage edited out.
 *
 * It costs 831 KB gzipped against 661, and a worker tick of 14-17 ms against ~13.
 * Both measured, both fine.
 */
const DEFAULT_DATASET: Dataset = 'full';

function datasetFromUrl(): Dataset {
  const requested = new URLSearchParams(location.search).get('catalog');
  return requested === 'active' || requested === 'full' || requested === 'synthetic'
    ? requested
    : DEFAULT_DATASET;
}

export const DATASET: Dataset = datasetFromUrl();

export const catalogUrl = (dataset: Dataset) => `${import.meta.env.BASE_URL}data/${dataset}.bin`;

/**
 * The readout, redesigned 2026-09-15 as a single narrow column.
 *
 * The piece lives in a canvas that is often small, so the panel had to stop being a
 * table and become a list: names only, until you ask for more. A row you keep unfolds
 * its data, takes a box in its group's colour, and **stops moving** - the rest go on
 * sorting themselves by elevation underneath.
 *
 * Three groups, because the sky has three kinds of thing in it and they do not compare:
 * what is passing, what is wreckage, and the belt - which gets a grid rather than a
 * list, since five hundred objects that never move are not a list.
 */
export const READOUT = {
  /** Column width. Narrow on purpose; the sky is the piece, not the panel. */
  widthPx: 272,
  /** Default rows per group, before anything is kept. Names only. */
  passingRows: 10,
  debrisRows: 6,
  /**
   * Whether pointing at an object no row is showing gives it one, at the bottom of
   * the open zone so nothing above it moves.
   *
   * **On, but only while the pointer is out in the sky.** An opened row is two lines
   * tall instead of one, so opening one while the pointer is inside the list pushes
   * every row below it down - including the one under the cursor, which slides away
   * and marks the wrong object when clicked. Pointing at the sky cannot do that,
   * because the pointer is nowhere near the rows. So the sky names what you point at,
   * and the list only tints. The group tracks this itself; see ui-group.ts.
   */
  hoverOpensRow: true,
};

/**
 * The belt's grid: one square per geostationary object above the horizon.
 *
 * **Ordered by azimuth, filled column by column**, so horizontal position in the grid
 * is horizontal position in the sky. The grid is the belt, flattened - the leftmost
 * column is the eastern end of the arc and the rightmost is the western. Hovering
 * across it sweeps the southern sky in the same direction, which is the whole reason
 * to prefer it over an arbitrary index order that would have cost exactly the same.
 *
 * Nothing is written in it. Data appears above the grid only while the pointer is on
 * a square, so five hundred objects cost five hundred squares and no text at all.
 */
export const CHOIR_GRID = {
  columns: 24,
  /** Square height in CSS pixels; width comes from the column, so they are near-square. */
  cellPx: 8,
  gapPx: 1,
};

/**
 * The visual grammar, decided 2026-09-14. Two axes, kept strictly apart:
 *
 * - **Hue says what a thing is.** Warm white is a passing satellite; blue is
 *   geostationary. A geostationary object is blue in every state, because belonging
 *   to the belt is a permanent fact about it, not a condition it is passing through.
 * - **Value says what state it is in.** Full brightness is sunlit - what you could
 *   actually see with the naked eye. Half is eclipsed. Dim is below the horizon.
 *
 * This is why eclipsed is now a neutral grey rather than the blue it used to be:
 * blue had to be freed to mean one thing. Amber is the third hue and it is the
 * pointer's alone - nothing in the sky is amber until a person touches it.
 */
export const PALETTE = {
  /** The sky's own colour: the clear colour, and what the haze fades objects into. */
  sky: '#05070a',
  /** A passing satellite in sunlight. */
  lit: '#fff2d6',
  /** A passing satellite inside Earth's shadow: tracked, and invisible to the eye. */
  eclipsed: '#808080',
  /** Anything below the horizon, on the far side of the world. Neutral, never blue. */
  below: '#4a4f54',
  /** Geostationary, in every state. See CHOIR and *The choir* in CLAUDE.md. */
  geostationary: '#8ad4ff',
};

/**
 * How the `kind` byte reads on screen - the heuristic in catalog-format.ts, which
 * knows debris and rocket bodies from CelesTrak's naming and nothing more.
 *
 * Not a fourth and fifth hue. Wreckage carries the same state colours as everything
 * else and differs in *texture*: smaller, and without the glow that makes a payload
 * read as something lit. Hue stays reserved for category.
 *
 * `active` is payloads only, so this is visible almost entirely on `?catalog=full`.
 */
export const KIND_LOOK = {
  /** A spent upper stage is still a payload's mark: smaller, and without the flare. */
  rocketBody: { size: 0.9, glow: 0.5 },
  /**
   * Debris is not a light. It emits nothing, reflects badly, tumbles, and is the
   * reason a spacecraft has to move - so it is drawn as a **shard**: a flat triangle,
   * no glow, turning slowly, each fragment at its own rate and phase.
   *
   * Shape rather than brightness, because brightness was already spoken for. Range
   * varies a point's size four-fold and shadow varies its brightness three-fold, so a
   * debris mark that differed only in amount could not be read against that noise -
   * measured at 0.67x peak and swamped. A different *kind* of mark survives it.
   *
   * It costs nothing: the triangle is a signed distance field inside the same point
   * sprite, so there is no extra geometry, no extra draw, and no vertex work. Only
   * fragments inside debris sprites pay for it. A real tetrahedron would need instanced
   * meshes, and at four to sixteen pixels would look exactly like this anyway.
   */
  debris: {
    /** Slightly larger than a payload: a triangle needs pixels before it reads as one. */
    size: 1.2,
    /** Peak brightness against a payload's core. */
    intensity: 0.5,
    /** Turns per minute, before each fragment's own hash scales it. */
    spinRpm: 2.5,
  },
};

export const SKY = {
  /** Radius of the dome in scene units. Arbitrary - the sky has no scale. */
  radius: 100,
  /**
   * The lowest elevation anything is drawn at. **The sky ends here** - below it an
   * object is not drawn, not listed, not in the belt's grid, and a mark on it is let
   * go. One floor, so the panel can never name something the sky is not showing.
   *
   * It used to be -90: the whole sphere was drawn and the far side stayed faintly
   * present through the ground. That produced a discontinuity nobody designed. The
   * haze runs from `haze.topDeg` down to the horizon and is *opaque* at 0°, so an
   * object at +1° is ~97% hazed away - but below 0° there is no haze at all, only the
   * ground disc at 0.72, which leaves an object at -1° composited at 28% of its
   * brightness. Things faded out as they sank and then **brightened again** the moment
   * they crossed, which reads as the floor leaking rather than as a choice.
   *
   * Two degrees rather than zero, because a point sprite is 16 px wide: cutting at
   * exactly 0° leaves half a sprite straddling the drawn horizon line.
   */
  lowestVisibleDeg: 2,
  /**
   * Haze rising from the horizon: sky-coloured at the horizon, clear by `topDeg`, so
   * objects come into view gradually as they climb instead of popping over the edge.
   * It dims objects, their rings and trails; the graticule and compass labels stay
   * above it, so the dome's structure reads all the way down.
   */
  haze: {
    topDeg: 20,
    /** 1 = objects at the horizon are fully hidden. */
    horizonOpacity: 1,
  },
};

/**
 * Rings around the objects the readout lists. For now these are also the default
 * voices of the sonification to come.
 *
 * The ring is also the whole of the pointer's response. Hovering an object rings it
 * in `markColor`; clicking makes that ring stick, and a stuck object holds its row in
 * the readout until it sets. Nothing textual is ever drawn on the sky - see CLAUDE.md.
 */
export const HIGHLIGHT = {
  /** Outer diameter, CSS pixels. Fixed on screen, whatever the object's range. */
  diameterPx: 30,
  strokePx: 1.5,
  /** The plain ring worn by whatever the readout happens to be listing. */
  color: '#ffffff',
  /**
   * Hovered and marked objects, in the sky and in the readout alike - one colour is
   * what ties a ring to its row. Amber reads as put there by a person: the sky's own
   * marks are warm white (sunlit) and steel blue (eclipsed), and nothing in it is
   * this saturated.
   */
  markColor: '#ffb454',
  /** The hovered ring grows slightly, so the pointer's reach is legible. */
  hoverScale: 1.2,
  /**
   * A marked object's ring and its row dim together as it descends, so a glance at
   * the sky reads the same ordering the readout is sorted by. This is the brightness
   * at the horizon; it reaches full by `fullBrightDeg`.
   */
  dimAtHorizon: 0.3,
  fullBrightDeg: 55,
  /** How near the pointer has to be, in CSS pixels, to take an object. */
  pickRadiusPx: 18,
  /**
   * A kept object is let go once it sinks below this, and its row goes back to
   * whatever has risen.
   *
   * Not zero. The haze is opaque at the horizon, so anything under a couple of
   * degrees is already gone from the image - holding its row while it creeps the
   * last degree reads as the readout being stuck. It also settles the geostationary
   * case: a satellite parked at +0.4° in the south never sets at all, and would
   * otherwise hold its row for the life of the page.
   */
  releaseBelowDeg: 5,
};

/**
 * The tracks drawn through kept objects - where each has been and where it is going.
 *
 * Drawn as real pixel-width lines (three's `LineSegments2`), not GL hairlines, which
 * ANGLE renders one pixel wide whatever you ask for.
 */
/**
 * The choir: the geosynchronous belt, which from Berlin is a fixed arc across the
 * southern sky, peaking at 30° due south. Those objects never rise and never set.
 *
 * They are drawn like everything else - small, because they are 36,000 km away - but
 * they are not passes, so they are kept out of the readout, given no track even when
 * kept, and ringed in blue rather than amber and smaller. A different kind of thing,
 * marked as one. Which objects qualify is decided in catalog-format.ts, from the
 * elements; this is only how they look.
 */
export const CHOIR = {
  /** Ring diameter, CSS pixels. Smaller than HIGHLIGHT.diameterPx on purpose. */
  diameterPx: 17,
  strokePx: 1.2,
  /** The ring matches the point: one blue means one thing. */
  color: PALETTE.geostationary,
};

/** A hex colour scaled toward black: how a mark drawn at reduced intensity reads. */
function dimmed(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * k);
  return `#${[ch(16), ch(8), ch(0)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * How each group reads in the panel. Two colours, and they mean different things:
 *
 * - **`tone` is the colour the object already is on the sky.** It is what a row rests
 *   at, so a name in the list and a mark in the sky are the same colour before anything
 *   is touched. The row carries the grammar, not the panel's own idea of "info text".
 * - **`accent` is attention**, and it is amber for both lists because that is what the
 *   *ring* turns when you touch an object — anything not in the belt gets `uMarkColor`.
 *   A second highlight hue for debris would have to disagree with its own ring. A
 *   distinct blue for it was considered and deferred - not rejected, but any blue has
 *   to survive sitting next to the belt's, and nothing needs it yet.
 *
 * `shape` is the mark's own form, in the mark's own colour: the legend, folded into the
 * heading, where it sits next to the thing it explains instead of underneath everything.
 *
 * A **shape, not a character.** `●` and `▲` are drawn wherever their font decides to
 * put them inside the em box, so no amount of flex alignment centres them against the
 * capitals beside them - half the disc ends up under the text line. These are CSS
 * boxes instead: the element *is* the ink, so centring it centres the mark. It also
 * matches what the sky does, which draws a round sprite and a triangle by hand rather
 * than asking a font for either.
 */
export const GROUP_LOOK = {
  passing: { shape: 'dot', tone: PALETTE.lit, accent: HIGHLIGHT.markColor },
  debris: {
    shape: 'triangle',
    tone: dimmed(PALETTE.lit, KIND_LOOK.debris.intensity),
    accent: HIGHLIGHT.markColor,
  },
  belt: { shape: 'dot', tone: PALETTE.geostationary, accent: PALETTE.geostationary },
} as const;

export const TRAIL = {
  /** Minutes of past track to draw. */
  pastMinutes: 35,
  /** Minutes of future track to draw. */
  futureMinutes: 35,
  /** Seconds between sampled points along a trail. */
  stepSeconds: 20,
  /** Line width in CSS pixels. */
  widthPx: 2,
  /** Opacity of a track at full brightness. */
  opacity: 0.5,
  /**
   * A track dissolves from this elevation down and is cut exactly at the horizon,
   * so an orbit leaves the image rather than diving through the ground. Keep it near
   * the haze's own scale - below a couple of degrees nothing is visible anyway.
   */
  fadeTopDeg: 7,
  /** Track colour for an object that is drawn but not kept. Kept ones use HIGHLIGHT.markColor. */
  color: '#7fa6bf',
  /**
   * A track through every kept object, not only the most recent one. Several at once
   * is the point of keeping several - and also the thing most likely to turn the sky
   * into wool, so it is one line to turn off.
   */
  allMarked: true,
  /**
   * Scene seconds a track may drift before it is recomputed. A track spans 70 minutes,
   * so a minute of drift is invisible; at high time rates this is what stops the
   * worker being asked for tracks faster than it can answer frames.
   */
  refreshSeconds: 60,
  /** Track requests allowed out at once, across all kept objects. */
  maxInflight: 2,
};

export const CLOCK = {
  /**
   * Minimum propagation ticks per second. Rendering runs at display rate and the GPU
   * blends between ticks, so at 1x this can be low without anything visibly stepping.
   */
  propagationHz: 5,
  /** Most scene seconds allowed between ticks before the tick rate is raised. */
  maxStepSeconds: 10,
  /** Ceiling on ticks per second. A tick of `full` is ~17 ms in the worker. */
  maxPropagationHz: 20,
  /**
   * Time multipliers offered by the scrub control.
   *
   * **Capped at 100x since 2026-09-16.** It used to run to 1800x, where a pass
   * crossed the sky in two seconds. That is a curiosity rather than an image - the
   * blends cut the corners of the arcs, the tracks lag by design, and there is
   * nothing to look at that a slower rate does not show better. 100x is a pass in
   * under a minute, which is the fastest rate that still reads as motion.
   *
   * It also settles the sound: see AUDIO.maxTimeRate.
   */
  rates: [1, 10, 60, 100],
};

/**
 * Sound - Step 4, beginning with the drone.
 *
 * The belt sings and nothing else does, yet. `src/drone.ts` builds the bed; the
 * performers (passes) and the debris interference are the next two pieces, and the
 * engine in `src/audio.ts` is split so they can arrive without touching this.
 *
 * Three decisions are worth stating before the numbers:
 *
 * - **The bed is a bus, not a voice per object.** Five hundred oscillators is not a
 *   performance problem so much as an acoustic one: five hundred detuned sines are
 *   white noise, not a drone. The belt is instead cut into slices of equal
 *   population in azimuth order, and each slice is one bass voice, panned to where
 *   its members actually are. So the drone *is* the arc, flattened into the stereo
 *   field, and the same object that lights a square in the grid is inside the voice
 *   that square sits over.
 * - **Pan is head-relative**, taken against the camera's right vector, so turning to
 *   look sweeps the belt across the stereo field. It is also what makes the later
 *   upgrade free: `PannerNode` wants the same direction vectors `SkyFrame` already
 *   carries. Absolute pan would have been static - these objects never move.
 * - **Selection is what gets loud.** The bed is deliberately mild and permanent;
 *   keeping an object pulls one voice out of it and gives it its own pitch, filter
 *   and envelope. Keep a dozen and the drone becomes invasive, which is the point.
 */
export const AUDIO = {
  /** Master level once sound is on. Everything else is relative to this. */
  masterGain: 0.45,
  /** Seconds the master takes to arrive or leave when the button is pressed. */
  fadeSeconds: 2.5,
  /**
   * Sound runs at real time and nowhere else.
   *
   * Above this the piece is an optical curiosity - a pass in a second, tracks
   * lagging - and a drone whose pans sweep at that speed is a siren, not a sky. The
   * master simply ducks while the rate is up and comes back when it returns to 1x,
   * so the button's state survives a look-ahead.
   */
  maxTimeRate: 1,
  /** Seconds to duck and unduck for the rate. Shorter than a deliberate fade. */
  duckSeconds: 0.7,
  drone: {
    /**
     * The bed's pitches, low to high, **one voice per ratio** - the slice count is
     * this array's length, so the two can never disagree.
     *
     * A just pentatonic over an octave and a half. Adjacent slices are adjacent in
     * the sky as well as in pitch, so sweeping the arc from east to west rises.
     * Nine bass voices a whole tone apart would be mud; a pentatonic is not.
     */
    ratios: [1, 9 / 8, 4 / 3, 3 / 2, 5 / 3, 2, 9 / 4, 8 / 3, 3],
    /** The root, Hz. C1 - under the bottom of a bass guitar. */
    rootHz: 32.7,
    /** One bed slice at full occupancy. Nine of these sum to the whole drone. */
    bedGain: 0.085,
    /** Members in a slice for it to reach full level. Below it the bed thins out. */
    fullAt: 20,
    /** The bed never falls below this fraction of its level while the belt is up. */
    floorLevel: 0.25,
    /** Detune between a slice's two sines. What makes the bed beat instead of sit. */
    detuneCents: 7,
    /** A triangle an octave up, under the pair, for body. */
    bodyGain: 0.16,
    /** Each voice breathes at its own rate, lowest slice slowest. Hz. */
    breathHz: [0.043, 0.071],
    /** How deep that breath cuts, as a fraction of the voice's level. */
    breathDepth: 0.35,
    /** A kept object's voice sits this many octaves above its slice. */
    soloOctaves: 1,
    soloGain: 0.17,
    /** Spread across a slice, cents: neighbours kept together beat against each other. */
    soloDetuneCents: 14,
    /** The resonant lowpass that opens as a voice arrives. */
    soloCutoffHz: 900,
    soloQ: 7,
    attackSeconds: 3,
    releaseSeconds: 4,
    /** Kept belt objects that can sound at once. Past this, a click still marks. */
    maxSolo: 12,
    /** How often the slices are recut, ms. The belt barely moves; this is not a tick. */
    regroupMs: 2000,
    /** Hard left and right are unpleasant on headphones; the field stops here. */
    panSpread: 0.85,
  },
};

/** `?debug` shows frame timing and worker stats. Hidden otherwise - the piece has no chrome for it. */
export const DEBUG = new URLSearchParams(location.search).has('debug');
