import { FAMILY, type Family } from './catalog-format';

/**
 * Where the observer stands. Everything in this app is relative to this point.
 *
 * **Berlin is the default, and the default must not move.** `scripts/reference.py`
 * pins `OBS_*` to these exact numbers and `npm run validate` compares against the
 * `reference.json` computed from them. A runtime override cannot reach that check -
 * nothing in the build imports this file, the scripts take `catalog-format.ts` alone -
 * but the default and `reference.py` still have to agree.
 */
export const DEFAULT_OBSERVER = {
  name: 'Berlin',
  latitudeDeg: 52.52,
  longitudeDeg: 13.405,
  /** Height above the WGS-84 ellipsoid, in kilometres. */
  heightKm: 0.034,
};

/**
 * Coordinates off the URL: `?lat=48.86&lon=2.35`. Anything missing, unparseable or
 * out of range is ignored outright rather than clamped - a half-read coordinate is a
 * different place, and silently standing somewhere else is worse than standing in
 * Berlin.
 */
function observerFromUrl(): { latitudeDeg: number; longitudeDeg: number; name: string } | null {
  const q = new URLSearchParams(location.search);
  const lat = Number(q.get('lat'));
  const lon = Number(q.get('lon'));
  if (!q.has('lat') || !q.has('lon')) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  // No name. A link someone else sent is not "your location", and there is no
  // geocoder here to give it a real one - see place.ts. The coordinates stand alone.
  return { latitudeDeg: lat, longitudeDeg: lon, name: '' };
}

/**
 * The observer actually in force. **Mutable, and deliberately so.**
 *
 * `setObserver` writes into this object rather than replacing it, and every reader
 * takes its fields at use time - `createHud`, `createGate` and `run` all read inside a
 * function, never at module scope. That is what lets the first screen change where you
 * stand without a reload: at that moment the piece does not exist yet, because the
 * whole of it is behind the LAUNCH press. **Nothing may capture these fields at module
 * load**, or it will hold Berlin for the life of the page.
 */
export const OBSERVER = { ...DEFAULT_OBSERVER, ...observerFromUrl() };

/**
 * Stand somewhere else, and put it in the URL so the sky is a link.
 *
 * **Rounded to two decimals, on purpose.** That is about a kilometre, which moves a
 * 500 km object by a tenth of a degree - invisible - and it means a shared URL never
 * carries anyone's precise coordinates. A location control that publishes a street
 * address in a link is not one worth having.
 */
export function setObserver(latitudeDeg: number, longitudeDeg: number, heightKm = 0): void {
  const round = (v: number) => Math.round(v * 100) / 100;
  OBSERVER.latitudeDeg = round(latitudeDeg);
  OBSERVER.longitudeDeg = round(longitudeDeg);
  OBSERVER.heightKm = Number.isFinite(heightKm) ? heightKm : 0;
  OBSERVER.name = 'your location';
  syncUrl(String(OBSERVER.latitudeDeg), String(OBSERVER.longitudeDeg));
}

/** Back to Berlin, and out of the URL with it. */
export function resetObserver(): void {
  Object.assign(OBSERVER, DEFAULT_OBSERVER);
  syncUrl(null, null);
}

/** True when the sky on screen is not the default one. */
export const observerIsCustom = () => OBSERVER.name !== DEFAULT_OBSERVER.name;

/**
 * How the observer reads on screen, in one place - the first screen and the panel both
 * use it, so they cannot format the same coordinates two ways. A location with no name
 * is its coordinates and nothing else.
 */
export function observerLabel(): string {
  const { latitudeDeg: la, longitudeDeg: lo, name } = OBSERVER;
  const lat = `${Math.abs(la).toFixed(2)}°${la >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(lo).toFixed(2)}°${lo >= 0 ? 'E' : 'W'}`;
  return name ? `${name} · ${lat} ${lon}` : `${lat} ${lon}`;
}

function syncUrl(lat: string | null, lon: string | null): void {
  const url = new URL(location.href);
  if (lat === null) {
    url.searchParams.delete('lat');
    url.searchParams.delete('lon');
  } else {
    url.searchParams.set('lat', lat);
    url.searchParams.set('lon', lon!);
  }
  // replaceState, not pushState: this is not a page someone should have to press Back
  // through, and the first screen is still up when it happens.
  history.replaceState(null, '', url);
}

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
 * The first screen.
 *
 * The piece is meant to sit in a hero section on another page, where a visitor who
 * scrolls past should cost nothing at all. So **nothing loads until LAUNCH is
 * pressed**: `main.ts` renders this screen and imports the piece dynamically, which
 * is what splits three.js, satellite.js, the worker and the 831 KB catalogue into a
 * chunk that is never fetched by accident. A page nobody presses pays for the words
 * and the drawing on this screen and for nothing else - the same bargain the sound
 * already makes.
 *
 * It is also, incidentally, the gesture the sound has always needed. Nothing is
 * started here: a hero section that makes a noise when someone scrolls past it is
 * exactly what `armFromSelection` was written to avoid. The press only means "show me
 * the sky".
 *
 * `?launch` skips it, for development and for a deep link that means to arrive
 * already inside the piece.
 *
 * **The words are a placeholder and are meant to be rewritten.** They live here, in
 * one place, rather than inside the markup that draws them.
 */
export const GATE = {
  title: 'Birds Within',
  tagline: 'A visualization of crowded skies. An immersive panorama showing our traces in orbit, our observers above.',
  /**
   * Very short, and it has one job: say what changed between 2010 and now. That
   * change *is* the piece - see the top of CLAUDE.md - and it is the one thing a
   * reader cannot get from looking at the sky, because they never saw the old one.
   */
  lede:
    'Referring to a satellite as "Bird" was common in sat-spotter networks years ago and approaching them as such, allows newcomers to discover the taxonomies of that environment. This piece is an immersive experience of the crowded skies above us, and tool to explore and understand them more, or simply, contemplate their dynamics.',
  /** The one offer on the screen. */
  launchLabel: 'LAUNCH',
  /** What the press costs, said before it is pressed rather than after. */
  loadingLabel: 'LAUNCHING…',
  hint: 'drag to look · click to trace · press LISTEN for sound',
  /** How long the screen takes to leave once the first frame is on the canvas. */
  fadeMs: 700,
  /**
   * The drawing: a poster of the sky in the sky's own grammar, built in poster.ts
   * from the same palette the piece draws with, so the two cannot drift apart.
   *
   * It is deliberately a *drawing* and not a screenshot. A screenshot would go stale
   * the first time anything about the image changed, and a loading screen that shows
   * a photograph of what is behind it reads as a substitute rather than as a cover.
   */
  poster: {
    /** Passing objects. Enough that it reads as a crowd, few enough to stay a drawing. */
    passing: 260,
    /** Fragments, drawn as the shards they are on the sky. */
    shards: 42,
    /** The belt, as the fixed arc across the south it actually is. */
    belt: 48,
    /** Fixed, so the poster is the same drawing every time the page is opened. */
    seed: 19,
  },
};

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
  /**
   * How to work it, top right. Thin on purpose - the panel is not here to explain
   * itself. Full screen adds `esc to leave` to this while it is on, and only then:
   * a way out is worth saying when there is something to get out of.
   */
  hint: 'drag to look · scroll to zoom · click to keep',
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
  /**
   * The **hit box**, in CSS pixels. The visible square is this less `gapPx`, drawn
   * inside it by padding, so the grid has no dead pixels between cells at all.
   *
   * It used to be the square itself, with a real CSS `gap` between them - and a click
   * landing in a gap hit the grid rather than a cell and did nothing. On an 8 px
   * target that is most of the time. See *The belt gets a grid* in CLAUDE.md.
   */
  cellPx: 10,
  /** The visual gap, taken out of the hit box rather than added between them. */
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
   * Where the camera is pointing when the piece opens: a compass bearing in degrees,
   * 0 north and 180 south, with `startPitchDeg` above the horizon.
   *
   * **South, since 2026-09-18.** North was the default only because `sky-frame.ts` maps
   * -Z to north and a camera with no yaw looks down -Z - which is a fact about the
   * coordinate system rather than a decision about the image. South is where the piece
   * actually is: from this latitude the geostationary belt is a fixed arc across the
   * southern sky, and it is the one thing in the frame that holds still while
   * everything else streams past. Opening facing away from it wasted the first look.
   */
  startFacingDeg: 180,
  startPitchDeg: 38,
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
  /**
   * The backdrop: airglow, and the grain over it. Added 2026-09-18.
   *
   * The sky was one flat value everywhere above the haze, and a flat value is what
   * makes a frame read as empty rather than as dark. Two nearly free things fix that,
   * and neither is a post pass:
   *
   * - **A lift toward the horizon.** Real night sky is not uniform; it brightens
   *   toward the rim. Here it is one gradient on a backdrop sphere drawn before
   *   everything else, which gives the dome a floor to sit on and the objects near
   *   the horizon something to be seen against.
   * - **Grain.** At `#05070a` a gradient this shallow bands *badly* in 8 bits - the
   *   steps are wider than the gradient. A pixel of noise dissolves the steps and,
   *   at a slightly higher amplitude, reads as the image's own noise floor rather
   *   than as dither.
   *
   * **Cool, not warm, and that is a rule rather than a taste.** A warm horizon glow
   * reads as light pollution, which reads as a city, which is a *place* - and the
   * piece is an abstract dome with no Earth geometry in it. It is also the one hue
   * warm white is already spoken for by. `color` is the dial if that judgement ever
   * changes.
   */
  backdrop: {
    /** What the sky lifts toward at the horizon. Cool - see above. */
    color: '#16283a',
    /** How much of that colour arrives at the horizon. 0 disables the lift entirely. */
    strength: 0.32,
    /**
     * How far up it reaches. Above the haze, so the two do not read as one band, but
     * well short of the zenith: the first try ran to 58 deg and, at a 95 deg field of
     * view, that is the whole sky - it read as fog rather than as a horizon.
     */
    topDeg: 36,
    /** Higher hugs the horizon more tightly. */
    falloff: 2.6,
    /**
     * Grain amplitude, peak to peak, in **display** units - so 0.012 is about 3/255.
     * Added after the colour-space conversion, which is the whole trick: a linear
     * 0.012 near black comes out around 39/255 once sRGB's steep toe is applied.
     */
    grain: 0.014,
  },
  /**
   * The ground. Rewritten 2026-09-18, and it replaced a reflection that did not work.
   *
   * **What was there before was a mirror of the objects** - the same points drawn again
   * with y negated. It was cheap and it was wrong: a satellite has a *shape*, and a
   * legible upside-down copy of a legible mark reads as a duplicate of the data rather
   * than as water. Sixteen-pixel discs and triangles do not stop being discs and
   * triangles when you flip them.
   *
   * So there is nothing identifiable down here at all now. The ground is a dark field
   * with slow, very elongated sheens drifting across it - no points, no edges, nothing
   * with a period a viewer could count. It suggests a surface catching light off the
   * horizon without claiming to be any particular surface.
   *
   * It is also **darker than the sky, which it has to be.** The old disc was 0.72 of
   * `#070b10` over the unlifted backdrop, which came out within a shade of the sky's own
   * colour - so once the horizon had an airglow above it, the ground below read as the
   * same material with the glow inexplicably switched off. A horizon is a change of
   * substance, and value is what says so.
   */
  ground: {
    /** The base. Clearly below the darkest sky, and cool rather than neutral. */
    color: '#02040a',
    /** What a sheen lifts toward: the horizon's own light, well under it. */
    sheen: '#0a1927',
    /**
     * How much of that colour a sheen ever reaches. 0 leaves a flat dark field.
     *
     * Low on purpose. These are meant to read as light that happens to be there, and
     * anything bright enough to look like a source - or like something reflecting one -
     * is too bright. It came down from 0.9 for exactly that.
     */
    amount: 0.28,
    /**
     * How the sheens are stretched across the plane. Deliberately lopsided - equal
     * numbers give round blobs, which is the one shape this must not have.
     */
    stretch: [1.15, 0.62] as [number, number],
    /**
     * How dark it gets where the observer is standing, 0-1. Deepest straight down and
     * gone by the horizon.
     *
     * It puts the viewer in the picture - a person on a dark plain always has one - but
     * it is here for a second reason: **the shortest way across the ground from south
     * to north runs straight through the observer**, so this cuts every sheen that
     * tries it in half. It was the fix for swells reading as one mass crossing the
     * whole frame, together with the frequency above.
     */
    shadow: 0.45,
    /**
     * The window the crests come through, against a field running roughly -1 to 1.
     * **This is the softness dial**, and both ends fail differently: widen it and the
     * whole field lifts at once, so the ground becomes one sheet of light sliding
     * across it; narrow it and the crests thin into hard ribbons, which are as defined
     * a shape as anything this exists to avoid. 0.18 to 0.72 gave ribbons.
     */
    crest: [-0.05, 1.4] as [number, number],
    /**
     * How hard the crests are shaped after that window - an exponent, so higher is
     * more concentrated and harder-edged, lower is blurrier. 2 was the first value and
     * read a little crisp.
     */
    contrast: 1.2,
    /**
     * How far the field folds back on itself. Above 1 the domain turns inside out and
     * patches pinch off and reconnect, which is what stops the swells reading as one
     * continuous mass; below 1 it is a gentle distortion and they join back up.
     */
    warp: 1.1,
    /**
     * How far down the ground the sheens reach, in degrees below the horizon. Past
     * this the surface has turned to face the eye and there is no grazing light left.
     */
    reachDeg: 33,
    /**
     * The pace it evolves at. Slow enough that nothing in it reads as an event: the
     * three waves in `swell` beat against each other over tens of seconds and never
     * repeat, so there is change to notice but never a moment when something happens.
     */
    speed: 0.07,
  },
};

/**
 * The halo around a light. Added 2026-09-18.
 *
 * "Can we add some glow" has two answers, and this is the cheap one: a broad, soft
 * falloff *inside the sprite the object already draws*. No render target, no
 * fullscreen pass, no extra draw - the sprite grows and the fragment shader spends a
 * few more pixels. The expensive answer is bloom, which means an EffectComposer,
 * half-float targets for the whole scene, and moving the glitch's canvas readback
 * with it; see the render-target trap under **Rendering**.
 *
 * It does something the piece wants beyond looking better: **haloes sum.** Blending is
 * additive, so a crowded patch of sky is brighter than a sparse one by more than the
 * count of its marks - density becomes a quantity the eye reads directly, which is
 * what this whole piece is about.
 *
 * Only lights have one. A shard is not a light and does not glow; `KIND_LOOK.debris`
 * already says so, and the halo obeys it.
 */
/**
 * The glow pass: light bleeding out of everything on the canvas. Added 2026-09-18.
 *
 * `GLOW`'s halo is inside each object's own sprite, so it reaches objects and nothing
 * else. This is the other kind, the one that was asked for: a real screen-space bloom
 * that takes the **finished frame** - objects, orbits, rings, the graticule, the
 * compass - and spreads the bright parts of it across everything. Anything drawn on
 * the canvas glows; the panel does not, because it is DOM and sits above the canvas.
 *
 * **It works entirely in display space, which is what makes it safe here.** The
 * documented trap under *Wreckage tearing the picture* is that a render target
 * receives linear values and `#05070a` cannot survive 8 bits of linear. This pass never
 * meets that problem: it starts from a copy of the **canvas**, which already holds
 * display-ready sRGB bytes, and no shader in the chain includes `colorspace_fragment`
 * or tags a texture as sRGB - so every value passes through untouched from the copy to
 * the composite. Blurring in display space is not physically correct, and on a sky this
 * dark it is the better-looking wrong: a linear blur blows the bright cores out.
 *
 * The shape of the work is four passes: threshold-and-downsample, blur across, blur
 * down, composite. Three of them run at 1/`downscale` in each axis, so they cost a
 * sixteenth of a fullscreen pass each; only the composite is full-size.
 */
export const BLOOM = {
  /** 0 turns it off and skips every pass and both render targets. */
  strength: 0.85,
  /**
   * How bright a pixel has to be before it bleeds, 0-1 against the display value. Low,
   * because this sky's brightest marks are not close to white - but not 0, or the
   * graticule and the haze bloom and the whole frame turns to soup.
   */
  threshold: 0.16,
  /** How soft the threshold's edge is. A hard cut makes marks pop as they brighten. */
  knee: 0.22,
  /**
   * Resolution divisor for the blur. Reach in screen pixels scales with it and cost
   * falls as its square, so a bigger divisor is the cheap way to a wider glow; past
   * about 8 the upsample starts to show as soft blocking.
   */
  downscale: 6,
  /**
   * Blur radius in low-resolution texels, and **it must stay near 1**. The kernel is a
   * nine-tap Gaussian folded into five bilinear samples, and those offsets only weight
   * correctly at their own spacing: stretching them pulls the taps into separate lobes
   * and draws a **box** around every bright mark instead of a halo. That is what 2.2
   * did. Reach comes from `passes` and `downscale`.
   */
  spread: 1,
  /**
   * How many across-and-down pairs to run. Blurs compose, so n passes of sigma give
   * sigma*sqrt(n) - four is about twice the reach of one, for four sixteenths of a
   * fullscreen pass at `downscale` 4, or four thirty-sixths at 6.
   */
  passes: 4,
};

/**
 * Immersion: bringing the near things close. Added 2026-09-18, **and it is an
 * experiment** - the slider is at the bottom of the screen, it starts at 0, and 0 is
 * exactly the piece as it was.
 *
 * **The thing to understand before touching this: distance is invisible here.** Every
 * object is drawn at `dir * SKY.radius` - one sphere, all 21k of them - and the camera
 * sits at the origin and only ever rotates. A perspective projection from the origin
 * sends `dir * r` to the same pixel for *every* r, which `picking.ts` has said out loud
 * for months. So moving objects to their true ranges would change nothing at all on
 * screen: no parallax, no perspective, no growth. Parallax would need the camera to
 * translate, and that would give the dome a scale the piece does not have.
 *
 * So nothing moves. The range column the shader already carries drives **size** and
 * **defocus** directly, which is the only way a fixed eyepoint can show depth.
 *
 * **Defocus is nearly free here, for a reason that would not hold anywhere else.** Real
 * depth of field needs a depth buffer and a screen-space gather. But a defocused point
 * light *is* a soft disc, and every object here is a point sprite that already draws
 * one - so widening its own falloff is per-object bokeh with no render target, no pass
 * and no extra draw. The sprite is the bokeh.
 *
 * **What comes close is decided by range, not by kind**, and that one rule does both
 * jobs asked of it: the belt sits at 36,000 km so it never moves - it stays small,
 * sharp and in the background - and anything else high enough is left alone too. It
 * also means an object arrives as it passes overhead, since that is when it is nearest,
 * which is the truthful version of the effect rather than a staged one.
 */
export const IMMERSION = {
  /**
   * Whether the slider is offered at all. **Off, and behind `?immerse`** since
   * 2026-09-18: the mechanism works and is cheap, but the *density* does not - at
   * catalogue scale about 800 objects are above the horizon, so bringing the near ones
   * forward brings hundreds forward and the frame becomes a wall of discs at any
   * tuning. Narrowing the band swings to the other failure, where at some instants
   * nothing is inside it and there is no subject at all.
   *
   * Nothing is deleted, because the finding underneath is worth keeping and the fix is
   * known: immerse only the **kept** objects, which is the rule the sound already
   * reached for the same reason. That needs picking to survive the effect first. Until
   * then the slider is not drawn and `scene.immersion` stays at 0, which is exactly the
   * piece as it was.
   */
  enabled: new URLSearchParams(location.search).has('immerse'),
  /** At or inside this slant range, an object takes the effect in full. */
  nearKm: 400,
  /**
   * Where a mark is fully background. **Wide on purpose**, and this is the number that
   * decides what the picture is about: the passing sky is 300-2,500 km, so a generous
   * far point leaves nearly all of it on the near side of the ramp - the subject, sharp
   * and enlarged - while the belt at 36,000 km is flatly background. At 2,500 almost
   * everything counted as far and the whole frame turned to bokeh with no subject in
   * it, which is the opposite failure to the one before it.
   */
  farKm: 6000,
  /**
   * How much larger a **near** mark is drawn. These are the subject: they come forward
   * and they stay **sharp**, because that is what a lens focused on something near
   * does.
   *
   * Watch this one: a 16 px dot at 6x is 96 px, and **`gl_PointSize` has a hardware
   * ceiling** that is 1024+ on desktop but as low as 63 or 255 on some mobile GPUs.
   * Past that the driver silently clamps and the effect stops growing.
   */
  maxGain: 6,
  /**
   * How much wider a **far** mark's disc gets as it goes out of focus.
   *
   * This is the background bokeh, and it is the half that was backwards at first: the
   * first version defocused the near objects and left the background crisp, which is a
   * lens focused at infinity - the opposite of the effect. The subject is near and
   * sharp; the belt and everything else far goes soft behind it.
   */
  bokeh: 4,
  /**
   * Energy conservation on the **near** growth. A real defocused point conserves
   * energy, so brightness falls as the square of the size.
   *
   * It has to be the full 2 here, and that was found the hard way: at 1 the near marks
   * summed additively into a single white cloud on a 20,582-object sky. There are
   * hundreds of them, so anything less than conservation blows the frame out.
   */
  nearDim: 0.7,
  /**
   * How much a near mark's bright core tightens as it is magnified, as an exponent on
   * the gain: 0 keeps the whole profile scaling together, 1 holds the core at a fixed
   * size in pixels while the halo grows around it.
   *
   * **Without this the effect fails outright.** Scaling a soft profile up only gives a
   * bigger soft profile, so a magnified mark reads as a 96 px *blur* - indistinguishable
   * from the background bokeh it is meant to be the opposite of. Keeping a hot core
   * inside a spreading halo is what makes a near mark read as a light that has come
   * close rather than as one that has gone out of focus.
   */
  coreTighten: 0.7,
  /**
   * A near mark stops being a glow and becomes a **body**: a hard-edged disc, as a
   * fraction of the dot's radius, at `bodyGain` brightness.
   *
   * **Additive blending cannot occlude** - it adds to whatever is behind it, so nothing
   * drawn this way is ever truly opaque. What it can do is *saturate*: against a
   * `#05070a` sky a disc at over 1.0 clamps to white, and once it has clamped, more
   * light behind it adds nothing. It reads as solid because it is the brightest the
   * screen goes. That is the honest cheap version of opacity here; real occlusion would
   * need alpha blending and a depth buffer, which is a much larger change - see the
   * note on depth at the end of this section.
   */
  bodyEdge: 0.52,
  bodyGain: 2.4,
  /**
   * Energy conservation on the **far** bokeh, and deliberately gentler than `nearDim`.
   *
   * Full conservation would be correct and useless: a belt point is faint and two
   * pixels wide, so spreading it over twenty-five times the area at 1/25 the brightness
   * does not blur it, it **deletes** it. Out-of-focus background highlights are meant
   * to be visible - that is what bokeh is - so this keeps them in the image. There are
   * also far fewer of them than there are near marks, so they can afford it.
   */
  farDim: 2,
  /**
   * Immersion at which rings and tracks have faded out completely.
   *
   * They go because this is a first test and picking has not been dealt with: a mark
   * that has grown eight times and gone soft is nowhere near where `picking.ts` thinks
   * it is, so pointing at things would ring the wrong ones. Rather than leave a pointer
   * that lies, the markers leave and picking stops. Both come back when the slider does.
   */
  markersGoneAt: 0.3,
};

export const GLOW = {
  /**
   * How far the halo reaches, as a multiple of the dot's own radius. The sprite grows
   * by this, so the fill cost grows by its square - but only the ~6-9% of the
   * catalogue that is above the horizon is drawn at all.
   */
  haloScale: 2.4,
  /** How bright the halo is at the centre, against the core's own 1.9. */
  haloGain: 0.42,
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
  /**
   * The attention colour for **wreckage**, replacing amber on anything the `kind` byte
   * calls debris - its ring when touched or kept, its track, and its row in the panel.
   *
   * Added 2026-09-17, and it overturns the earlier "a second highlight hue for debris
   * would have to disagree with its own ring" - it does not, because the ring changes
   * with it. What the piece gained in exchange is that a collision of *kinds* is now
   * visible: keep a fragment beside a satellite and the two marks are plainly not the
   * same sort of thing, before anything moves or sounds.
   *
   * A desaturated pink rather than the green that was also on the table, and the
   * deciding argument is that it must not shout. The eye's sensitivity peaks in the
   * green, so a green of the same magnitude reads markedly brighter against a sky this
   * dark - the exact "contamination" this hue is meant to avoid. Pink is also the
   * furthest thing here from the belt's blue, and unlike a second warm-white it cannot
   * be confused with a sunlit payload at sixteen pixels.
   */
  debrisMarkColor: '#e2aac4',
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
    // Not amber. Wreckage has its own attention colour now - see HIGHLIGHT.
    accent: HIGHLIGHT.debrisMarkColor,
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
   * It also settles the sound, and is why the sound no longer stops above 1x: at
   * 1800x a pass's whole Doppler bend landed in two seconds and was a siren. At 100x
   * it takes forty and is a swoop. See AUDIO.rateDuck.
   */
  rates: [1, 10, 60, 100],
};

/**
 * Which voice each family sings with.
 *
 * Typed as a **total** map over `Family` rather than an array or a lookup with a
 * fallback, so adding a family to `FAMILY` and forgetting to give it a voice is a
 * compile error rather than a satellite that quietly sings the default.
 */
const FAMILY_VOICE: Record<Family, 'none' | 'starlink' | 'iridium' | 'military'> = {
  [FAMILY.NONE]: 'none',
  [FAMILY.STARLINK]: 'starlink',
  [FAMILY.IRIDIUM]: 'iridium',
  [FAMILY.MILITARY]: 'military',
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
/**
 * Ghosting: where a thing has just been, drawn only while the clock runs fast.
 *
 * At 1x an object crosses a couple of pixels in a tick and a trail would be a
 * smudge on the sprite. At 100x it crosses the sky in forty seconds, and the
 * question the ramp raises - how fast is this actually going? - has no answer in the
 * image at all. A trail answers it, and adds a density in *time* beside the density
 * in space the piece is already about.
 *
 * **It is extra draws of the same points, not a screen effect**, and that is the
 * whole design. A feedback buffer smears in screen space, so turning the camera would
 * drag the entire sky into streaks - and the fix for that (clear the buffer on any
 * camera motion) reads as a flicker exactly when a person is looking around. A ghost
 * here is a *position*, re-projected every frame like everything else, so it holds
 * still under the drag and no special case is needed.
 *
 * It costs no buffers and no uploads either: `mix` extrapolates outside [0, 1], so a
 * ghost is the same two ticks the GPU already holds, blended at a negative `uT`, which
 * runs the chord between them backwards. The error against the real past path is a
 * fraction of a degree over the span used here, and the thing being drawn is a
 * smudge behind a moving dot.
 */
export const GHOST = {
  /** Trails appear above this time rate, and fade in over the step above it. */
  fromRate: 1,
  /**
   * Copies behind each object. Each one is another draw of the points.
   *
   * **Each is a stroke, not a dot**, and that is what decides the number. Three dots
   * over a span this long read as beads on a string; a ghost instead sweeps its
   * sprite along the step back to the ghost behind it, so four of them join into one
   * tapering streak. Filling the same span with dots close enough to touch would have
   * taken fifteen draws.
   */
  count: 4,
  /** How far back the furthest reaches, in tick intervals. */
  spanTicks: 1.6,
  /** Brightness of the first ghost, and what each one behind it keeps of the last. */
  level: 0.5,
  falloff: 0.66,
  /**
   * A ghost's width against its object. Smaller reads as a trail rather than a queue
   * of satellites, and it is where most of the cost is: a point sprite is all
   * fragment, and a swept one is a square of side `width + streak` for a capsule that
   * only occupies a band across it. The streak is capped at 96 CSS px in the shader
   * for the same reason - past that it is a smear, not a trail.
   */
  size: 0.6,
};

export const AUDIO = {
  /** Master level once sound is on. Everything else is relative to this. */
  masterGain: 0.45,
  /** Seconds the master takes to arrive or leave when the button is pressed. */
  fadeSeconds: 2.5,
  /**
   * **Sound runs at every time rate**, since 2026-09-18. It used to stop dead above
   * 1x, on the reasoning that a drone whose pans sweep at that speed is a siren.
   *
   * That was true of the 1800x ladder and stopped being true when the ladder was
   * capped at 100x, but the mute stayed behind. Nothing in the audio path actually
   * accelerates: every continuous parameter moves through `setTargetAtTime` with a
   * time constant in *real* seconds, and phrases are scheduled on the audio context's
   * own clock, so the song keeps its tempo however fast the sky runs. What does
   * change is welcome - the Doppler bend is the same +-650 cents but sweeps across a
   * pass in forty seconds instead of thirty-five minutes, which is the swoop the
   * exaggeration was for.
   *
   * So the rate attenuates rather than silences: the sky gets faster and the sound
   * steps back, which also answers the thing a mute could not - that a listener has
   * no way to tell a silenced piece from a broken one.
   */
  rateDuck: {
    /**
     * Level at `fullAt` and above, as a share of `masterGain`. 1x is always full.
     *
     * Cut from 0.55 to 0.30 when `rateDrive` arrived, and the reason is the ear, not
     * the meter: the bed's centroid climbs from 58 Hz to 181 Hz, and equal-loudness
     * puts the ear some 15 dB more sensitive there. Holding the same level would have
     * made the hum arrive far louder than the drone it grew out of. -10.5 dB gives
     * back about two thirds of that, which leaves the rise plainly audible without it
     * taking the room.
     */
    to: 0.3,
    /** The rate the attenuation has fully arrived at. The top of the ladder. */
    fullAt: 100,
  },
  /**
   * What the sound does while the clock is held.
   *
   * **Pause freezes the instrument; it does not silence it.** The sound here is state
   * plus events - where a thing is, how high, lit or eclipsed, and the phrases a bird
   * sings. Pause stops the events: no chirp, honk or squawk is scheduled while the
   * clock is held, and the state simply stops changing because the frame does. What
   * is left is what does not move anyway - the belt's bed and the shards' hiss - a
   * step quieter, so the press is audible. Turning the camera still sweeps the belt
   * across the field, because looking is not time passing.
   */
  paused: { level: 0.45 },
  /**
   * **The drone rises with the time rate**, added 2026-09-18.
   *
   * Attenuating was not enough: it told a listener the sound had not broken, and
   * nothing else. This makes the clock itself audible - the bed runs up from its C1
   * towards a hum as the sky speeds up, so a ramp is something you hear before you
   * read the number. Cents at `rateDuck.fullAt`, on the same logarithmic reading of
   * the ladder, and it is **the drone's alone**: the birds keep their register,
   * because a satellite's own song is not what the clock is doing.
   *
   * There is a reasonable objection - the belt does not move, so why would it change
   * with the rate? Because the bed is not the sound of five hundred objects, it is
   * the sound of the sky they are the floor of, and that is what is running.
   */
  rateDrive: { cents: 1900 },
  /** Seconds to duck and unduck for the rate or a pause. Shorter than a deliberate fade. */
  duckSeconds: 0.7,
  drone: {
    /** Seconds the transpose takes to arrive. Long: a rate change is a ramp, not a jump. */
    rateGlideSeconds: 1.4,
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
    /**
     * One bed slice at full occupancy. Nine of these sum to the whole drone.
     *
     * Lowered from 0.085 on 2026-09-16, after listening to it on the real sky rather
     * than the synthetic one. It matters which: `synthetic` has 240 belt objects, so
     * its slices sit at half occupancy and the bed is 4 dB quieter than `full`, where
     * every slice saturates. The first tuning was done against the quiet one.
     */
    bedGain: 0.04,
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
    /**
     * A kept voice at full strength, over and above the bed. Lowered from 0.17 with
     * the bed, but by less: it sits an octave up with a resonant edge, so it arrives
     * clearly at a level well under the bed's, and cutting both by the same amount
     * would have made keeping an object louder in relative terms than it was before.
     *
     * **A voice only reaches this when the belt is being played as a chord.** See
     * `soloRamp`.
     */
    soloGain: 0.105,
    /**
     * How much of `soloGain` each kept voice gets, as a function of how many are kept.
     *
     * One voice on its own was overpowering: it arrived at full strength over a bed
     * deliberately tuned to sit back, so a single click jumped out of the image. The
     * belt is a choir, and one singer stepping forward at full voice is the wrong
     * shape for it. So the **first** voice enters at `first` of its level and every
     * voice - the first one included - rises toward full as more are kept, reaching it
     * at `fullAt`.
     *
     * **This only ever attenuates.** At `fullAt` voices the sum is exactly what that
     * many voices cost before; below it, less. Keeping ten is unchanged, keeping one
     * is 14 dB quieter, and the grid stops being a set of switches and becomes
     * something that rewards playing it.
     *
     * `curve` under 1 makes the first few additions count for more than the last few,
     * so going from one voice to three is a clear swell rather than a slow crawl.
     */
    soloRamp: { first: 0.2, fullAt: 10, curve: 0.7 },
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
  /**
   * The performers: passes, and only the ones being kept.
   *
   * The name of the piece comes from what radio amateurs call satellites - birds -
   * and the 2010 original assigned looped birdsong to passes over a stereo field.
   * This is that, synthesised. Synthesised **first**, deliberately: a recorded bird
   * sounds good on its own, so it would sound fine badly panned and badly gated, and
   * a wrong mapping would survive for months behind it. A swept sine is unforgiving,
   * which is the useful property right now. Samples are a later decision, and the
   * byte budget is an argument against them - the whole catalogue is 831 KB.
   *
   * **Nothing sounds until it is kept.** A thousand objects are above the horizon;
   * sonifying what is merely *there* is the mush this piece exists to avoid. The
   * click is the instrument.
   *
   * Three textures, from the one byte the catalogue actually has:
   *
   * - **bird** (payload): phrases of two to five swept chirps, then a gap. Each
   *   object's pitch, sweep, phrase length and gap come from a hash of its index, so
   *   a given satellite always sings the same song, and several kept at once drift
   *   apart instead of locking into a pulse.
   * - **machine** (rocket body): a spent upper stage is not a bird. Lower, a
   *   sawtooth, and **regular** where the bird is not - the industrial chant under
   *   the birdsong that the brief asks for.
   * - **shard** (debris): dry noise bursts through a narrow band. Provisional. Debris
   *   is meant to become interference *on* other voices rather than a voice of its
   *   own, but a click that makes no sound reads as a broken click, and this previews
   *   the grain that idea will use.
   *
   * Four mappings, and three of them are already the visual grammar:
   *
   * - **pitch <- range rate**, exaggerated. Literal Doppler is 0.04 cents - see the
   *   note in CLAUDE.md - so it is scaled into the audio band the way a receiver
   *   does it. A pass glides down through closest approach, which is the sound the
   *   whole metaphor was built on.
   * - **level <- elevation**, on `HIGHLIGHT`'s own curve. The voice swells and fades
   *   in exact step with how the object's ring dims, because it is the same numbers.
   * - **pan <- direction**, head-relative, exactly as the drone pans.
   * - **timbre <- shadow.** A sunlit object is bright; one inside Earth's umbra is
   *   muffled. The one axis here that the eye already reads as brightness, and the
   *   ear reads better as colour.
   */
  performer: {
    /** Kept passes that can sound at once. Past this a click still marks. */
    maxVoices: 8,
    /** Voice level before the elevation curve. */
    gain: 0.33,
    /**
     * Relative levels. **Measured, not nominal** - these are whatever makes the three
     * sit together, and they are not proportional to anything. Bandpassed noise throws
     * most of its energy away, so a shard needs several times a sine's gain to reach
     * the same loudness; a sawtooth through an open lowpass needs less.
     */
    timbreGain: { bird: 1, machine: 1, shard: 0.8 },
    /** A kept object arrives and leaves over these, seconds. */
    attackSeconds: 0.7,
    releaseSeconds: 1.6,
    /**
     * Cents of pitch per km/s of range rate, against a literal 0.0017. A pass swings
     * +/- 7 km/s either side of closest approach, so this is a glide of a fifth down
     * through the middle of the pass.
     */
    dopplerCentsPerKmS: 100,
    /** Base pitches: a just pentatonic from middle C, over three octaves. */
    rootHz: 262,
    ratios: [1, 9 / 8, 4 / 3, 3 / 2, 5 / 3],
    octaves: 3,
    /** How far ahead phrases are scheduled, seconds. Web Audio wants a lookahead. */
    lookaheadSeconds: 0.35,
    /**
     * **Which bird a bird is.** The `family` byte the build packs picks one of these;
     * anything untagged gets `none`, which is the whistle the piece started with.
     * `kind` still decides the class - a Starlink rocket body is a machine and a
     * Starlink fragment is a shard - so this only ever refines a payload.
     *
     * The point is the megaconstellations. Starlink is thousands of objects, and a
     * name in the list ought to have a sound you already recognise before you read it;
     * hearing a *skein* rather than a solo is the constellation becoming audible as a
     * constellation. Everything else follows from wanting that to be legible: the
     * families have to differ in register, timbre and **rhythm**, not just in pitch.
     *
     * Each voice is a full parameter set rather than a patch on a default, because a
     * family that differs in one number is not a family.
     */
    voices: {
      /** The default whistle: a songbird, sine, phrases of quick swept chirps. */
      none: {
        wave: 'sine' as OscillatorType,
        octaveShift: 0,
        q: 0.9,
        perPhrase: [2, 5],
        noteMs: [60, 170],
        spacingMs: [35, 120],
        gapMs: [900, 2600],
        /** How far a note sweeps, as a frequency ratio, and how often it sweeps up. */
        sweep: [1.15, 1.9],
        rise: 0.5,
        cutoffHz: [700, 5400],
        /** Fraction of a note held before it releases - see `strike`. */
        hold: 0.7,
        attack: 0.006,
        /** A parallel high-Q band that rings when the note is struck. 0 is off. */
        ring: 0,
        /** Soft clipping, for a voice that should sound forced rather than blown. */
        drive: 0,
        /**
         * **Measured, and corrected for register.** These are not proportional to
         * anything: the ear is roughly 6 dB less sensitive at 220 Hz than at 1 kHz and
         * 8 dB less at 175, so the low families have to measure *hotter* than the
         * songbird to sit level with it. Tuning them by RMS alone buried the geese.
         */
        gain: 1,
      },
      /**
       * **Starlink: geese.** Long nasal honks that fall slightly, one or two at a time,
       * with real silence between - so a dozen kept at once interleave into a skein
       * instead of a chord. Low, because the whole point is that it is not a songbird.
       */
      starlink: {
        wave: 'sawtooth' as OscillatorType,
        octaveShift: -1,
        q: 3.2,
        perPhrase: [1, 2],
        noteMs: [180, 380],
        spacingMs: [120, 260],
        gapMs: [1400, 3600],
        sweep: [1.02, 1.16],
        rise: 0.15,
        cutoffHz: [500, 2200],
        hold: 0.55,
        attack: 0.05,
        ring: 0,
        drive: 0.35,
        gain: 1.35,
      },
      /**
       * **Iridium: starlings.** Metallic chatter - many very short notes, wide sweeps,
       * and a high-Q band ringing behind each one. Iridium is the constellation whose
       * flares people used to plan evenings around, and a ringing, rattling voice is
       * the one that says *metal* rather than *bird*. Not peepy: the ring carries it.
       */
      iridium: {
        wave: 'square' as OscillatorType,
        octaveShift: 1,
        q: 1.2,
        perPhrase: [4, 9],
        noteMs: [25, 70],
        spacingMs: [18, 55],
        gapMs: [700, 1900],
        sweep: [1.3, 2.6],
        rise: 0.5,
        cutoffHz: [1200, 7000],
        hold: 0.35,
        attack: 0.002,
        ring: 0.6,
        drive: 0.15,
        gain: 0.55,
      },
      /**
       * **Military and radar: big squawking birds.** Low, harsh and slow, and every
       * note *falls* - a squawk drops, it does not lift. Long gaps, so one of these
       * under a field of songbirds is a presence rather than a texture.
       */
      military: {
        wave: 'sawtooth' as OscillatorType,
        octaveShift: -2,
        q: 5,
        perPhrase: [1, 3],
        noteMs: [220, 520],
        spacingMs: [180, 420],
        gapMs: [1800, 4200],
        sweep: [1.35, 2.2],
        rise: 0.04,
        cutoffHz: [320, 1500],
        hold: 0.7,
        attack: 0.02,
        ring: 0.2,
        drive: 0.6,
        gain: 0.8,
      },
    },
    /** Which voice each `FAMILY` value sings with. See FAMILY_VOICE. */
    familyVoice: FAMILY_VOICE,
    /** The inharmonic multiple the ring sits at, and how sharp it is. Bell, not tone. */
    ringRatio: 2.76,
    ringQ: 20,
    machine: {
      /** Lower than the birds, and it does not sweep. */
      octaveDown: 2,
      /**
       * **A spent stage knocks; it does not sing.** Sharpened 2026-09-21, on the note
       * that the wreckage all read as calm sea-waves and the rocket bodies wanted a
       * more disruptive presence - faster, and more regular.
       *
       * A pulse and its gap are picked once per object and never jittered, so a
       * machine is a metronome where a bird deliberately is not. The period lands at
       * 170-460 ms, which is 2-6 Hz: fast enough to read as a mechanism running rather
       * than as a slow tolling, and the one texture in the piece you can count.
       */
      pulseMs: [60, 160],
      gapMs: [110, 300],
      cutoffHz: [400, 2600],
      /**
       * Short attack, flat hold, and the rest is release: a knock rather than a note.
       * The hold still matters - see `strike` - but a machine wants much less of it
       * than a bird, which is most of what separates the two.
       */
      attack: 0.004,
      hold: 0.32,
      /** Soft clipping, so it reads as machinery being driven rather than as a tone. */
      drive: 0.45,
    },
    /**
     * **Continuous, and eventless.** The first version fired short noise bursts, which
     * was exactly wrong: a repeating transient is the most attention-getting thing a
     * mix can contain, and debris is not asking for attention - it is contamination.
     * There is no phrase, no gap and nothing to schedule. A shard is a band of noise
     * that is simply *there*, swelling and sinking, brighter than the drone and quieter
     * than a bird, and several of them are a wash rather than a rhythm.
     */
    shard: {
      /** The band centre sweeps between these - the swish. */
      bandHz: [900, 4200],
      /** Wide. A hiss, not a rattle; the burst version used 4 and rang like a snare. */
      q: 1.2,
      /**
       * How fast the band sweeps and how fast it breathes, per object, and how deep
       * the breathing goes. **Widened 2026-09-21**: these were [0.05, 0.13] and
       * [0.09, 0.27] at a fixed depth of 0.38, which is one cycle every four to
       * twenty seconds at one intensity - so every fragment in the sky was the same
       * calm sea-wave and the per-object hash had nothing audible to vary.
       *
       * `pulseDepth` is half the swing: the gain rides `1 - depth` plus or minus
       * `depth`, so 0.5 is total modulation and anything above it would drive the
       * trough negative.
       */
      swishHz: [0.04, 0.22],
      pulseHz: [0.06, 0.4],
      pulseDepth: [0.22, 0.46],
      /**
       * **Some wreckage is agitated, and that is the other half of the answer.**
       * Widening the calm range alone still gives one kind of thing moving at
       * different speeds. A share of fragments instead get a different character:
       * a pulse in the *audible rhythm* range rather than the drift range, nearly
       * total depth, and a tighter band so it bites rather than washes.
       *
       * **The LFO is a sawtooth at negative depth**, which is what makes these read
       * as impulses rather than as fast tremolo: the ramp snaps to full and decays
       * linearly, so each cycle has an attack. A sine at the same rate and depth is
       * a wobble, and a wobble is not a presence.
       *
       * This is a deliberate reversal of the note under `shard` above, which argued
       * that a repeating transient is the most attention-getting thing a mix can
       * hold. It still is. The difference is that this is a *minority* of fragments
       * and it is still one continuous band of noise with an LFO on it - there is no
       * scheduled event anywhere in it, so it stays eventless in the way that
       * mattered, while having something to hear.
       */
      agitatedShare: 0.3,
      agitated: {
        q: 3.6,
        swishHz: [0.3, 1.1],
        pulseHz: [1.7, 5.2],
        pulseDepth: [0.4, 0.5],
        /**
         * **Measured, not nominal**, and it is the same trap `timbreGain` carries a
         * note about: a tighter band throws more energy away, and a sawtooth at this
         * depth spends most of each cycle decaying. Rendered offline the agitated
         * shards came out **5 dB under the calm ones** - so the fragment meant to be
         * the more present of the two was the quietest thing in the mix.
         *
         * This puts them a shade above the calm ones instead, which is where a
         * disruption belongs. Peaks stay at 0.15-0.17, level with a calm shard.
         */
        gain: 2,
      },
    },
  },
};


/** `?debug` shows frame timing and worker stats. Hidden otherwise - the piece has no chrome for it. */
export const DEBUG = new URLSearchParams(location.search).has('debug');

/**
 * Debris deforming what it passes - in the ear and in the eye, off one geometry.
 *
 * **"Close" is an angle, not a pixel count.** Depth comes from the dot product of two
 * unit direction vectors, which is the cosine of the true separation between them in
 * the observer's sky. That *is* the simple version: at a fixed field of view, angular
 * separation and pixel distance are the same ordering. The difference is zoom - a
 * pixel threshold would make zooming out set everything interfering and zooming in
 * cure it, which reads as a bug rather than as a sky. The *displacement* is in screen
 * pixels, which is where a glitch belongs; only the trigger is angular.
 *
 * **One threshold, two senses.** `nearDeg` and `farDeg` are shared, so the fragment
 * that bends a bird's pitch is the fragment visibly shaking it. That correspondence is
 * the whole point: the sound explains the image and the image explains the sound.
 *
 * Only **kept** shards do this. Reading every fragment against every voice is cheap
 * enough, but things would bend for reasons a listener cannot see; counting the kept
 * ones makes the wreckage something you can aim.
 */
export const INTERFERENCE = {
  /** Full depth at or inside this separation, degrees. */
  nearDeg: 12,
  /** Nothing at all beyond this. Wide, because a near miss is rare and this has to
   *  happen often enough to be part of the piece rather than a curiosity. */
  farDeg: 45,
  /** Kept shards that can deform at once. Also the shader's array size. */
  maxSources: 4,
  /** What it does to a voice. */
  sound: {
    /** How far the wobble bends the pitch at full depth. Over a tone and a half. */
    detuneCents: 320,
    /** How deeply it chews the amplitude. */
    amDepth: 0.7,
    /** And how far it drags the lowpass, as a fraction of wherever that already is. */
    cutoffDepth: 0.55,
    /** Wobble rate per voice, Hz. Fast enough to be damage, not vibrato. */
    wobbleHz: [4, 9],
  },
  /**
   * What it does to the picture.
   *
   * **A post-effect in a small disc, not a displacement of the objects.** The first
   * version moved the marks themselves in the vertex shader, on the same angular
   * falloff the sound uses, and it was wrong twice over. 45° is a third of the sky, so
   * it read as everything in view being shaken rather than as something local. And
   * moving the objects reads as *physics* - as if the wreckage were shoving satellites
   * about - when what is meant is that the image of them is corrupted. A screen
   * artefact belongs in screen space, after the scene is drawn.
   *
   * So the two senses now deliberately disagree about reach: the sound's is angular,
   * because it is about the sky, and the picture's is a radius in pixels, because it is
   * about the display. They still share a cause - the same kept shards - which is the
   * part that mattered.
   *
   * The pass costs a render target and a fullscreen draw, and **only runs while
   * wreckage is kept**: with nothing kept the scene goes straight to the canvas as it
   * always did, so a page nobody clicks a fragment on pays nothing.
   */
  sight: {
    /** Radius of the disturbance around a shard, CSS pixels. Small, deliberately. */
    radiusPx: 58,
    /**
     * Band thickness, **chosen per fragment** from a hash of its catalogue index, so a
     * given piece of wreckage always tears the same way and several at once do not comb
     * the image at one pitch.
     */
    bandPx: [2, 6],
    /**
     * How often a fragment tears in **columns** rather than rows.
     *
     * With everything horizontal, several active shards added far too much sideways
     * motion to the frame - the tears agreed with each other and read as one gesture.
     * Turning some of them ninety degrees breaks that up at no cost: it is the same
     * shader with the two axes swapped.
     */
    verticalChance: 0.4,
    /** How far a torn band slides sideways. */
    shiftPx: 7,
    /** How far the brightest pixel in a row is dragged along it - the sorting look. */
    smearPx: 11,
    /** What fraction of bands tear on a given step. Under half: it must stay sparse. */
    tearChance: 0.42,
    /** Steps per second. Discrete, so it reads as breaking up rather than as wobbling. */
    stepsPerSecond: 12,
  },
};
