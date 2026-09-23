import * as THREE from 'three';

import {
  DATASET,
  DEBUG,
  FAMILY_LOOK,
  FEATURED,
  HIGHLIGHT,
  OBSERVER,
  TRAIL,
  catalogUrl,
  type Dataset,
} from './config';
import { fetchCatalog, type FetchedCatalog } from './catalog';
import { KIND } from './catalog-format';
import { geodeticObserver } from './sky-frame';
import { SkyStream, type FramePair } from './sky-stream';
import { SkyScene, type Track } from './scene';
import { Clock } from './clock';
import { createHud } from './ui';
import { Selection } from './selection';
import { Trails } from './trails';
import { AudioEngine } from './audio';
import { createDebugPanel } from './debug';

/**
 * The piece itself, and everything heavy in the app: three.js, satellite.js, the
 * worker and the packed catalogue all hang off this module.
 *
 * It is a **dynamic import** from main.ts, which is the whole point - see `GATE` in
 * config.ts. A page that shows the first screen and is never pressed never fetches
 * this chunk, so the piece can sit in a hero section on another page without costing
 * a visitor who scrolls straight past it anything at all.
 */

/** Where the piece says what it is doing while it starts: the first screen, or the panel. */
export type StatusFn = (text: string) => void;

/**
 * Fetch the configured catalogue.
 *
 * In development only, fall back to the committed synthetic set when the real one
 * has not been fetched, so `npm run dev` works offline and on a fresh clone. The
 * published page never substitutes invented orbits for real ones: the piece is
 * about what is actually up there, so a missing catalogue is an error, not a swap.
 */
async function load(): Promise<{ catalog: FetchedCatalog; dataset: Dataset }> {
  try {
    return { catalog: await fetchCatalog(catalogUrl(DATASET)), dataset: DATASET };
  } catch (err) {
    if (!import.meta.env.DEV || DATASET === 'synthetic') throw err;
    console.warn(
      `[catalog] ${String(err)}\n` +
        'Falling back to SYNTHETIC data. Run `npm run fetch:catalog` for the real sky.'
    );
    return { catalog: await fetchCatalog(catalogUrl('synthetic')), dataset: 'synthetic' };
  }
}

/**
 * Start the piece. Resolves at the **first frame that has a sky in it** - not when the
 * loop starts - so whatever is covering the canvas can be taken away at the moment
 * there is something behind it rather than a moment before.
 */
export async function run(status: StatusFn): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#sky')!;
  const hudRoot = document.querySelector<HTMLElement>('#hud')!;

  status('loading the catalogue…');
  const { catalog, dataset } = await load();

  // The satrec builds and WASM allocation take the better part of a second for
  // `full` - in the worker, so the page stays responsive while this shows.
  status(`building ${catalog.header.count.toLocaleString('en')} orbits…`);
  const stream = await SkyStream.start(catalog.bytes, geodeticObserver(OBSERVER));
  if (stream.count === 0) throw new Error('catalogue is empty');
  if (stream.dropped) console.info(`[catalog] ${stream.dropped} element sets rejected by SGP4 at init`);
  if (DEBUG) console.info(`[sky worker] ready in ${stream.initMs.toFixed(0)} ms`);

  const clock = new Clock();
  const scene = new SkyScene(canvas, stream.count);
  const selection = new Selection();
  const audio = new AudioEngine(stream.choir, stream.kind, stream.family, stream.featured);
  // Keeping anything - from the sky or from the belt's grid - starts the sound, unless
  // the person has already worked the button themselves. See `armFromSelection`.
  selection.onMark = () => audio.armFromSelection();
  scene.setClasses(stream.choir, stream.kind, stream.featured, stream.family);
  const hud = createHud(hudRoot, clock, {
    names: stream.names,
    dataset,
    generatedAt: stream.generatedAt,
    selection,
    choir: stream.choir,
    kind: stream.kind,
    featured: stream.featured,
    family: stream.family,
    audio,
    immersion: (amount) => scene.setImmersion(amount),
  });
  const debug = DEBUG ? createDebugPanel(document.body) : null;
  // ?debug: the running piece, for poking at from the console.
  if (DEBUG) Object.assign(window, { birds: { stream, scene, clock, selection, audio } });

  let lastHud = -Infinity;
  let lastWall = performance.now();

  // Resolved by the first frame that actually draws a pair of ticks. Until then the
  // stream is still filling and the canvas holds nothing worth uncovering.
  let firstFrame: (() => void) | null = null;
  const drawn = new Promise<void>((resolve) => {
    firstFrame = resolve;
  });

  // The pointer over the sky. Its position is remembered and resolved once per
  // rendered frame: a mousemove can fire several times between two frames, and
  // picking has to read the blend that is actually on screen anyway.
  let pair: FramePair | null = null;
  let pointerAt: { x: number; y: number } | null = null;
  let lastSelectionVersion = -1;

  const trails = new Trails(stream);
  const tracked: number[] = [];
  const warping: number[] = [];
  const tracks: Track[] = [];
  let lastTrailVersion = -1;
  let lastMarksVersion = -1;
  const markColor = new THREE.Color(HIGHLIGHT.markColor);
  // Wreckage keeps its own attention colour here too, so a track says what kind of
  // thing drew it before you read the name at the other end of it.
  const debrisColor = new THREE.Color(HIGHLIGHT.debrisMarkColor);
  /** A featured orbit is the mark's own cool white, so the line names it before the row does. */
  const featuredColor = new THREE.Color(FEATURED.color);
  /**
   * The family attention colours, one THREE.Color each, built once. A track is the
   * longest mark the piece draws, so it is where a family reads most clearly - a
   * violet arc across the sky says Starlink before any name is read.
   */
  const familyColor = new Map<number, THREE.Color>();
  for (const [value, hex] of Object.entries(FAMILY_LOOK)) {
    if (hex) familyColor.set(Number(value), new THREE.Color(hex));
  }
  /** The featured objects, found once - the catalogue cannot change under a running page. */
  const featuredIndices: number[] = [];
  for (let i = 0; i < stream.count; i++) if (stream.featured[i] === 1) featuredIndices.push(i);

  scene.setPointerHandlers({
    hover: (x, y) => {
      pointerAt = { x, y };
    },
    leave: () => {
      pointerAt = null;
      selection.setHovered(-1);
      scene.setPickCursor(false);
    },
    click: (x, y) => {
      if (pair) selection.toggle(scene.pickAt(pair, x, y));
    },
  });

  function frame() {
    clock.tick();
    const now = clock.ms;
    const wall = performance.now();

    // Ticks come from the worker, running ahead of scene time; the GPU blends the
    // two either side of now. Nothing here propagates.
    // Spent frames are transferred back to the worker for reuse, so a pair is only
    // safe to read during the frame it came from: `pair` is cleared, not kept.
    pair = stream.update(now, clock.generation, clock.timeRate);
    if (pair) scene.showFrames(pair);
    scene.setTimeRate(clock.timeRate);

    // What the pointer is on, against the blend that is drawn rather than the last
    // tick - at high time rates a tick spans minutes, and the ring would trail the
    // object by degrees.
    // Picking is off while the sky is immersed: the marks are drawn several times their
    // size and spread into soft discs, and `picking.ts` still projects the bare
    // direction - so a ring would land nowhere near what the pointer is on. The rings
    // and tracks have faded out by then too. See IMMERSION.markersGoneAt.
    if (scene.immersion > 0.02) {
      pointerAt = null;
      if (selection.hovered >= 0) selection.setHovered(-1);
    } else if (pointerAt && pair) {
      const hit = scene.pickAt(pair, pointerAt.x, pointerAt.y);
      selection.setHovered(hit);
      scene.setPickCursor(hit >= 0);
      pointerAt = null;
    }

    // Hovering and marking reach the rings immediately; the readout follows in the
    // same breath, so a row never lags the ring it belongs to.
    const picked = selection.version !== lastSelectionVersion;
    if (picked) {
      lastSelectionVersion = selection.version;
      scene.setMarks(selection.marked);
      scene.setHovered(selection.hovered);
    }

    // The readout only has to keep up with reading, not with the display.
    if (picked || wall - lastHud >= 250) {
      hud.update(clock.date, pair?.from ?? null);
      // Rings follow the GPU blend on their own, so only a change of membership has
      // to reach the scene - at most a handful of integers.
      scene.setHighlights(hud.ringed());
      scene.setReveal(hud.revealing());
      lastHud = wall;
    }

    // Tracks for everything being kept - or for the single highest object when
    // nothing is. The worker answers these on the same thread it computes frames on,
    // so Trails caps how many are asked for at once and how often.
    // The choir gets no track, kept or not. A geosynchronous object's 70 minutes of
    // orbit is a few degrees of wobble around a fixed point - it would draw a smudge
    // where the object already is, and say nothing the still point does not.
    tracked.length = 0;
    if (TRAIL.allMarked) {
      for (const i of selection.marked) if (stream.choir[i] !== 1) tracked.push(i);
    } else if (selection.newest >= 0 && stream.choir[selection.newest] !== 1) {
      tracked.push(selection.newest);
    }
    /*
     * A featured object draws its orbit whenever it is up, kept or not - which is the
     * whole point of featuring it. Only while it is above the horizon: a track is cut
     * at the horizon anyway, so one for an object on the far side of the world would be
     * an empty request every frame.
     *
     * **There is no ambient track any more**, removed 2026-09-21. Nothing kept used to
     * put one on whatever happened to be highest, in TRAIL's blue-grey - so the sky
     * opened with an orbit drawn through a Starlink nobody had chosen, which read as a
     * statement about that object and was not one. It also read as *the* featured
     * orbit once the ISS existed, which is worse than meaningless. An orbit now means
     * exactly one of two things: you kept this, or it is the one with people in it.
     */
    if (pair) {
      for (const i of featuredIndices) {
        if (pair.to.range[i]! > 0 && pair.to.elevation[i]! > 0 && !tracked.includes(i)) tracked.push(i);
      }
    }
    trails.update(tracked, now);

    // The kept wreckage, which breaks up every mark near it in the sky - the same
    // fragments that deform the voices, off the same angle. See WARP_GLSL.
    if (pair) {
      warping.length = 0;
      for (const i of selection.marked) if (stream.kind[i] === KIND.DEBRIS) warping.push(i);
      scene.setWarpSources(pair, warping);
    }

    // Rebuild the geometry only when a track lands or is dropped, or when a mark
    // changes one's colour - never on hover, which fires as fast as the pointer moves.
    if (trails.version !== lastTrailVersion || selection.marksVersion !== lastMarksVersion) {
      lastTrailVersion = trails.version;
      lastMarksVersion = selection.marksVersion;
      tracks.length = 0;
      for (const i of tracked) {
        const directions = trails.get(i);
        if (directions) {
          const featured = stream.featured[i] === 1;
          /*
           * **Featured wins over kept**, which reverses what shipped first. Attention
           * is amber everywhere else, but the ISS keeps its cool white in all three
           * places it appears - the mark, the orbit and the row - so that one colour
           * is the whole link between a thing overhead and a name in the column. With
           * no tags on the sky that link has only colour to carry it, and turning the
           * orbit amber on a click would have said "something is selected" while
           * throwing away the one thing that said *which*.
           */
          const color =
            featured
              ? featuredColor
              : // Family before kind, the same order the ring uses - see FAMILY_LOOK.
                (familyColor.get(stream.family[i]!) ??
                (stream.kind[i] === KIND.DEBRIS ? debrisColor : markColor));
          tracks.push({ directions, color, featured });
        }
      }
      scene.setTracks(tracks);
    }

    // What the voices are doing reaches the image here, both halves of it at once:
    // the rings on the sky and the bars in the column, from the one map, on the one
    // frame. `hud.update` above runs at 4 Hz, which is right for names and ordering
    // and hopeless for a level - a bird's whole phrase can pass between two of those
    // ticks, which is what made the bars read as laggy beside their own rings.
    //
    // `audio.update` runs after the draw, so these are last frame's levels. Sixteen
    // milliseconds behind a sound is not a lag anyone can see, and the drone keeps
    // reading the heading it was just drawn with, which is the ordering that matters.
    scene.setPulses(audio.pulses);
    hud.pulse();
    scene.render();

    // The canvas now holds a sky. Whatever is covering it can go.
    if (firstFrame && pair) {
      firstFrame();
      firstFrame = null;
    }

    // Sound, after the scene: the drone pans against where the camera is looking, so
    // it reads the heading the frame was just drawn with rather than the last one.
    // It returns immediately while sound is off, which is every page nobody presses
    // the button on.
    audio.update(pair?.from ?? null, hud.belt(), selection.marked, scene.heading, clock.timeRate, clock.isPaused);

    debug?.frame(wall - lastWall, stream.getStats());
    lastWall = wall;
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
  return drawn;
}
