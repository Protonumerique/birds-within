import './style.css';

import * as THREE from 'three';

import { DATASET, DEBUG, HIGHLIGHT, OBSERVER, TRAIL, catalogUrl, type Dataset } from './config';
import { fetchCatalog, type FetchedCatalog } from './catalog';
import { KIND } from './catalog-format';
import { geodeticObserver } from './sky-frame';
import { SkyStream, type FramePair } from './sky-stream';
import { SkyScene } from './scene';
import { Clock } from './clock';
import { createHud } from './ui';
import { Selection } from './selection';
import { Trails } from './trails';
import { AudioEngine } from './audio';
import { createDebugPanel } from './debug';

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

async function main() {
  const canvas = document.querySelector<HTMLCanvasElement>('#sky')!;
  const hudRoot = document.querySelector<HTMLElement>('#hud')!;
  const status = (text: string) => {
    hudRoot.innerHTML = `<div class="panel"><h1>Birds Within</h1><div class="sub">${text}</div></div>`;
  };

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
  const audio = new AudioEngine(stream.choir, stream.kind);
  scene.setClasses(stream.choir, stream.kind);
  const hud = createHud(hudRoot, clock, {
    names: stream.names,
    dataset,
    generatedAt: stream.generatedAt,
    selection,
    choir: stream.choir,
    kind: stream.kind,
    audio,
  });
  const debug = DEBUG ? createDebugPanel(document.body) : null;
  // ?debug: the running piece, for poking at from the console.
  if (DEBUG) Object.assign(window, { birds: { stream, scene, clock, selection, audio } });

  let lastHud = -Infinity;
  let lastWall = performance.now();

  // The pointer over the sky. Its position is remembered and resolved once per
  // rendered frame: a mousemove can fire several times between two frames, and
  // picking has to read the blend that is actually on screen anyway.
  let pair: FramePair | null = null;
  let pointerAt: { x: number; y: number } | null = null;
  let lastSelectionVersion = -1;

  const trails = new Trails(stream);
  const tracked: number[] = [];
  const warping: number[] = [];
  const drawn: { directions: Float32Array; color: THREE.Color }[] = [];
  let lastTrailVersion = -1;
  let lastMarksVersion = -1;
  const markColor = new THREE.Color(HIGHLIGHT.markColor);
  // Wreckage keeps its own attention colour here too, so a track says what kind of
  // thing drew it before you read the name at the other end of it.
  const debrisColor = new THREE.Color(HIGHLIGHT.debrisMarkColor);
  const trackColor = new THREE.Color(TRAIL.color);

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

    // What the pointer is on, against the blend that is drawn rather than the last
    // tick - at high time rates a tick spans minutes, and the ring would trail the
    // object by degrees.
    if (pointerAt && pair) {
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
    if (tracked.length === 0) {
      // Never the choir: hud.selectedIndex already skips it, and this says so here too.
      const fallback = hud.selectedIndex();
      if (fallback >= 0 && stream.choir[fallback] !== 1) tracked.push(fallback);
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
      drawn.length = 0;
      for (const i of tracked) {
        const directions = trails.get(i);
        if (directions) {
          const kept = selection.isMarked(i);
          const color = kept ? (stream.kind[i] === KIND.DEBRIS ? debrisColor : markColor) : trackColor;
          drawn.push({ directions, color });
        }
      }
      scene.setTracks(drawn);
    }

    scene.render();

    // Sound, after the scene: the drone pans against where the camera is looking, so
    // it reads the heading the frame was just drawn with rather than the last one.
    // It returns immediately while sound is off, which is every page nobody presses
    // the button on.
    audio.update(pair?.from ?? null, hud.belt(), selection.marked, scene.heading, clock.timeRate);

    debug?.frame(wall - lastWall, stream.getStats());
    lastWall = wall;
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error(err);
  const hudRoot = document.querySelector<HTMLElement>('#hud');
  if (hudRoot) {
    hudRoot.innerHTML = `<div class="panel"><h1>Birds Within</h1><p class="err">${String(err)}</p></div>`;
  }
});
