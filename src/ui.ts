import { OBSERVER, CLOCK, GROUP_LOOK, HIGHLIGHT, READOUT, SKY, type Dataset } from './config';
import type { Clock } from './clock';
import type { SkyFrame } from './sky-frame';
import type { Selection } from './selection';
import { Group } from './ui-group';
import { ChoirGrid } from './ui-choir';
import type { AudioEngine } from './audio';

const pad = (n: number) => String(n).padStart(2, '0');

export interface Hud {
  update(date: Date, frame: SkyFrame | null): void;
  selectedIndex(): number;
  /** What wears a ring on the sky: every row on show, plus anything kept or pointed at. */
  ringed(): readonly number[];
  /** Every belt object above the sky's floor - what the grid shows, and what sings. */
  belt(): readonly number[];
}

export interface HudSource {
  /** Object names, indexed like every SkyFrame column. */
  names: string[];
  dataset: Dataset;
  /** When the element sets were fetched. */
  generatedAt: Date;
  /** 1 where the object is in the geosynchronous belt, indexed like `names`. */
  choir: Uint8Array;
  /** KIND per object: 0 payload, 1 rocket body, 2 debris. */
  kind: Uint8Array;
  /** What the pointer is touching and what it has stuck to. Shared with the scene. */
  selection: Selection;
  /** The sound. The panel owns its one control; nothing else here knows about it. */
  audio: AudioEngine;
}

const releaseBelow = (HIGHLIGHT.releaseBelowDeg * Math.PI) / 180;
/** The floor the sky is drawn to. The panel uses the same one - see SKY.lowestVisibleDeg. */
const lowestVisible = (SKY.lowestVisibleDeg * Math.PI) / 180;

/**
 * The panel: one narrow column, pinned left, full height.
 *
 * Title and time at the top, the two lists under them, and the belt's grid **aligned
 * to the bottom** - a spacer between them takes whatever height is left, so the grid
 * sits on the floor of the frame however tall the window is.
 *
 * Everything in it is a component the layout does not own. Moving this to a strip
 * along the bottom is a CSS change, not a rewrite.
 */
export function createHud(root: HTMLElement, clock: Clock, source: HudSource): Hud {
  const { names, selection, choir, kind } = source;
  const isChoir = (i: number) => choir[i] === 1;
  const isDebris = (i: number) => kind[i] === 2;
  /** What wears the track when nothing is kept: whatever is highest, held until it sets. */
  let fallback = -1;

  const lat = `${Math.abs(OBSERVER.latitudeDeg).toFixed(2)}°${OBSERVER.latitudeDeg >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(OBSERVER.longitudeDeg).toFixed(2)}°${OBSERVER.longitudeDeg >= 0 ? 'E' : 'W'}`;
  const asOf = source.generatedAt.toISOString().slice(0, 10);

  root.innerHTML = `
    <div class="scrim"></div>
    <div class="col">
      <header>
        <h1>Birds Within</h1>
        <div class="sub">${OBSERVER.name} · ${lat} ${lon}</div>
        <div class="sub">${names.length.toLocaleString('en')} objects · ${source.dataset} · ${asOf}</div>
        ${source.dataset === 'synthetic' ? '<div class="warn">invented orbits, not real objects</div>' : ''}
        <div class="clock" id="t">--:--:--<small id="tl">&nbsp;</small></div>
        <div class="controls">
          <button id="pause">PAUSE</button>
          <button id="now">NOW</button>
          <select id="rate">${CLOCK.rates.map((r) => `<option value="${r}">${r}×</option>`).join('')}</select>
        </div>
        <div class="controls">
          <input id="scrub" type="range" min="-720" max="720" step="1" value="0" title="offset from now, minutes" />
        </div>
        <div class="controls">
          <button id="listen">LISTEN</button>
        </div>
        <div class="sub" id="soundnote"></div>
      </header>
      <div class="lists"></div>
      <div class="spacer"></div>
      <div class="foot"></div>
    </div>
    <div class="hints">drag to look · scroll to zoom · click to keep</div>
  `;

  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const tEl = $('t');
  const tlEl = $('tl');
  const pauseBtn = $<HTMLButtonElement>('pause');
  const scrub = $<HTMLInputElement>('scrub');

  pauseBtn.onclick = () => clock.togglePause();
  $('now').onclick = () => {
    clock.resetToNow();
    scrub.value = '0';
    lastScrub = 0;
  };
  $<HTMLSelectElement>('rate').onchange = (e) => {
    clock.timeRate = Number((e.target as HTMLSelectElement).value);
  };

  // The sound's one control. It is also a gesture that can create the audio context -
  // a browser will not let a page make a sound without one - but no longer the only
  // one: keeping an object arms it too, from inside that click. See `armFromSelection`.
  //
  // Nothing here sets its own label. Both this and PAUSE are rendered from state in
  // `update`, because the sound can now start without this button being touched and a
  // label written at the click would be a lie the moment that happened.
  const listenBtn = $<HTMLButtonElement>('listen');
  const soundNote = $('soundnote');
  listenBtn.onclick = async () => {
    listenBtn.disabled = true;
    try {
      await source.audio.toggle();
    } finally {
      listenBtn.disabled = false;
    }
  };

  let lastScrub = 0;
  scrub.oninput = () => {
    const minutes = Number(scrub.value);
    clock.nudge((minutes - lastScrub) * 60);
    lastScrub = minutes;
  };

  // Three groups, because the sky holds three kinds of thing that do not compare.
  // Each rests at the colour its objects already wear and shows the mark's own shape
  // beside its name, so the legend lives where the thing it explains does.
  const passingGroup = new Group('Passing', GROUP_LOOK.passing, READOUT.passingRows, names, selection);
  const debrisGroup = new Group('Debris', GROUP_LOOK.debris, READOUT.debrisRows, names, selection);
  const choirGrid = new ChoirGrid(names, selection);
  root.querySelector('.lists')!.append(passingGroup.element, debrisGroup.element);
  root.querySelector('.foot')!.append(choirGrid.element);

  const passing: number[] = [];
  const debris: number[] = [];
  const choirUp: number[] = [];
  const ringed: number[] = [];
  /**
   * The horizon cull, memoised on the frame it was taken from. The pointer makes the
   * readout rebuild far more often than a tick arrives, and rescanning twenty thousand
   * objects for a mouse move would be the one piece of per-frame CPU work this app has
   * managed to avoid.
   */
  let scanned: SkyFrame | null = null;

  /**
   * What wears the track. The newest mark that can have one - the belt cannot - and
   * otherwise whatever is highest.
   */
  const trackTarget = () => {
    const newest = selection.newestWhere((i) => !isChoir(i));
    return newest >= 0 ? newest : fallback;
  };

  return {
    selectedIndex: trackTarget,
    ringed: () => ringed,
    belt: () => choirUp,

    update(date, frame) {
      const iso = date.toISOString();
      tEl.firstChild!.textContent = `${iso.slice(11, 19)} UTC`;
      const offset = lastScrub ? `  ${lastScrub >= 0 ? '+' : ''}${lastScrub}m` : '';
      tlEl.textContent = `${iso.slice(0, 10)} · ${pad(date.getHours())}:${pad(date.getMinutes())} local${offset}`;

      // Every control's face comes from state, not from whatever set that state.
      pauseBtn.textContent = clock.isPaused ? 'PLAY' : 'PAUSE';
      const listening = source.audio.enabled;
      listenBtn.textContent = listening ? 'SILENCE' : 'LISTEN';
      listenBtn.classList.toggle('on', listening);
      // Said only while it is true, and never otherwise: the drone is ducked while
      // the clock runs fast, and a button that looks on while nothing is audible is
      // worse than no button. See AUDIO.maxTimeRate.
      soundNote.textContent = source.audio.silenced ? 'silent above 1×' : '';
      if (!frame) return;

      if (frame !== scanned) {
        scanned = frame;
        passing.length = 0;
        debris.length = 0;
        choirUp.length = 0;
        for (let i = 0; i < frame.count; i++) {
          if (frame.range[i]! < 0 || frame.elevation[i]! <= lowestVisible) continue;
          if (isChoir(i)) choirUp.push(i);
          else if (isDebris(i)) debris.push(i);
          else passing.push(i);
        }
        const byElevation = (a: number, b: number) => frame.elevation[b]! - frame.elevation[a]!;
        passing.sort(byElevation);
        debris.sort(byElevation);
      }

      // A mark is let go when its object sinks into the haze. The belt is exempt: those
      // objects hold a fixed elevation forever and many sit under two degrees, so that
      // rule would make the low half of the arc impossible to keep at all.
      for (const i of selection.marked) {
        // The belt is exempt from the 5° rule - many of its objects sit under it
        // forever - but not from the floor: nothing keeps a mark the sky is not drawing.
        const floor = isChoir(i) ? lowestVisible : releaseBelow;
        if (frame.range[i]! < 0 || frame.elevation[i]! <= floor) selection.release(i);
      }

      passingGroup.update(frame, passing, passing.length);
      debrisGroup.update(frame, debris, debris.length);
      choirGrid.update(frame, choirUp);

      // Rings: every row on show, plus anything kept or pointed at that has no row -
      // the sky holds more rings than the column holds rows, and the whole belt is
      // reachable from the grid.
      ringed.length = 0;
      for (const i of passingGroup.listed) ringed.push(i);
      for (const i of debrisGroup.listed) ringed.push(i);
      for (const i of choirUp) {
        if (selection.isMarked(i) || i === selection.hovered) ringed.push(i);
      }
      // **The pointer always rings what it is on**, row or no row, group or no group.
      // This has to be its own line rather than a clause inside one of the loops
      // above: the lists show ten objects out of a thousand, so the overwhelmingly
      // common case is pointing at something that has no row at all, and hanging the
      // ring off the row was what silently took hover away from the whole sky.
      const hovered = selection.hovered;
      if (hovered >= 0 && frame.elevation[hovered]! > lowestVisible && ringed.indexOf(hovered) < 0) {
        ringed.push(hovered);
      }

      // Nothing kept: the track stays on whatever was highest until that one sets.
      if (
        fallback < 0 ||
        isChoir(fallback) ||
        frame.range[fallback]! < 0 ||
        frame.elevation[fallback]! <= lowestVisible
      ) {
        fallback = passing[0] ?? -1;
      }
    },
  };
}
