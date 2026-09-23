import {
  CLOCK,
  FAMILY_LEGEND,
  FAMILY_LOOK,
  GROUP_LOOK,
  HIGHLIGHT,
  IMMERSION,
  READOUT,
  SKY,
  observerLabel,
  type Dataset,
} from './config';
import type { Clock } from './clock';
import type { SkyFrame } from './sky-frame';
import type { Selection } from './selection';
import { createFullscreen } from './fullscreen';
import { Group } from './ui-group';
import { ChoirGrid } from './ui-choir';
import type { AudioEngine } from './audio';

const pad = (n: number) => String(n).padStart(2, '0');

export interface Hud {
  update(date: Date, frame: SkyFrame | null): void;
  /**
   * Repaint the pulse bars, and only those. Called **every frame**, unlike `update`,
   * which runs at 4 Hz - a level sampled four times a second misses most of a bird's
   * phrase and reads as laggy beside the ring on the same object, which runs at frame
   * rate. See `Group.pulse`.
   */
  pulse(): void;
  /** What wears a ring on the sky: every row on show, plus anything kept or pointed at. */
  ringed(): readonly number[];
  /** The FAMILY value the pointer is revealing from the legend, or -1. */
  revealing(): number;
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
  /** 1 on a featured object: its row wears the cool white, not amber. See FEATURED. */
  featured: Uint8Array;
  /** Per-object FAMILY value: a kept row wears its family's colour. See FAMILY_LOOK. */
  family: Uint8Array;
  /** What the pointer is touching and what it has stuck to. Shared with the scene. */
  selection: Selection;
  /** The sound. The panel owns its one control; nothing else here knows about it. */
  audio: AudioEngine;
  /**
   * How immersed the sky is, 0-1. A callback rather than the scene itself, so the panel
   * still knows nothing about three.js. See IMMERSION in config.ts.
   */
  immersion(amount: number): void;
}

const releaseBelow = (HIGHLIGHT.releaseBelowDeg * Math.PI) / 180;
/** The floor the sky is drawn to. The panel uses the same one - see SKY.lowestVisibleDeg. */
const lowestVisible = (SKY.lowestVisibleDeg * Math.PI) / 180;

/**
 * How wide this browser draws a thin scroll bar, measured rather than assumed.
 *
 * The panel pushes both bars into a gutter *outside* the rows, which means the column
 * has to know the width to give back - and `scrollbar-width: thin` is 6px in one
 * engine and 10 in another, with `::-webkit-scrollbar` winning in a third. Guessing
 * costs the rows the difference and leaves a kept row's box out of line with the
 * controls above it. The probe carries the real class, so whichever rule that engine
 * honours is the one being measured.
 */
function thinBarWidth(): number {
  const probe = document.createElement('div');
  probe.className = 'lists';
  probe.style.cssText = 'position:absolute;visibility:hidden;overflow-y:scroll;width:60px;height:60px';
  document.body.append(probe);
  const width = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return width;
}

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
  const { names, selection, choir, kind, featured, family } = source;
  const isChoir = (i: number) => choir[i] === 1;
  const isDebris = (i: number) => kind[i] === 2;

  const asOf = source.generatedAt.toISOString().slice(0, 10);

  document.documentElement.style.setProperty('--bar-w', `${thinBarWidth()}px`);

  root.innerHTML = `
    <div class="scrim"></div>
    <div class="col">
      <header>
        <h1>Birds Within</h1>
        <div class="sub">${observerLabel()}</div>
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
    ${IMMERSION.enabled ? `
    <div class="immerse">
      <input id="immerse" type="range" min="0" max="100" step="1" value="0" title="immersion" />
      <div class="immerse-label">IMMERSE</div>
    </div>` : ''}
    <div class="hints">
      <div class="hintline" id="hint"></div>
      <div class="conventions" id="conv"></div>
      <button id="full" type="button" hidden>FULL SCREEN</button>
    </div>
  `;

  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const tEl = $('t');
  const tlEl = $('tl');
  const pauseBtn = $<HTMLButtonElement>('pause');
  const scrub = $<HTMLInputElement>('scrub');

  pauseBtn.onclick = () => clock.togglePause();
  // NOW is the way back, not just a jump: it takes the clock to this instant, puts
  // the rate back to 1x and lets a held clock go. Anything that reads as "where was
  // I?" should be undone by one press, and a look-ahead left running at 100x is
  // exactly that.
  const rateSel = $<HTMLSelectElement>('rate');
  $('now').onclick = () => {
    clock.resetToNow();
    clock.timeRate = 1;
    rateSel.value = '1';
    if (clock.isPaused) clock.togglePause();
    scrub.value = '0';
    lastScrub = 0;
  };
  rateSel.onchange = (e) => {
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

  // Full screen. Its own corner rather than the controls block, because it changes
  // the frame and not the image - see fullscreen.ts. Escape is the browser's own way
  // out; the hint for it is only drawn while there is something to get out of.
  const fullBtn = $<HTMLButtonElement>('full');
  const hintEl = $('hint');
  const fullscreen = createFullscreen(document.documentElement);
  fullBtn.hidden = !fullscreen.available;
  fullBtn.onclick = () => void fullscreen.toggle();
  // However it changed - the button, `f`, or Escape - the face is redrawn from state.
  const paintFullscreen = () => {
    fullBtn.hidden = !fullscreen.available;
    const on = fullscreen.active;
    fullBtn.textContent = on ? 'LEAVE FULL SCREEN' : 'FULL SCREEN';
    fullBtn.classList.toggle('on', on);
    hintEl.textContent = on ? `${READOUT.hint} · esc to leave` : READOUT.hint;
  };
  fullscreen.onchange = paintFullscreen;
  paintFullscreen();

  /*
   * Immersion, bottom centre and starting at 0 - which is the piece exactly as it was.
   * Its own control rather than the scroll wheel, because zoom and immersion are
   * different axes and would fight over one gesture.
   *
   * Drawn only behind ?immerse: the effect is unfinished at catalogue scale and an
   * unfinished control is worse than none. See IMMERSION.enabled in config.ts.
   */
  if (IMMERSION.enabled) {
    const immerse = $<HTMLInputElement>('immerse');
    immerse.oninput = () => source.immersion(Number(immerse.value) / 100);
  }

  let lastScrub = 0;
  scrub.oninput = () => {
    const minutes = Number(scrub.value);
    clock.nudge((minutes - lastScrub) * 60);
    lastScrub = minutes;
  };

  // Three groups, because the sky holds three kinds of thing that do not compare.
  // Each rests at the colour its objects already wear and shows the mark's own shape
  // beside its name, so the legend lives where the thing it explains does.
  const level = (i: number) => source.audio.level(i);
  /*
   * **The conventions block, and it reverses "there is no legend any more".**
   *
   * That rule was right for the thing it was written about: a disc, a triangle and a
   * colour that each belong to a *group*, which has a heading of its own to sit
   * beside. A family has no heading - its members are scattered through both lists
   * and across the sky - so the only place its colour can be explained is a block
   * that names it. A hue cannot introduce itself.
   *
   * It lists what a *kept* object turns, which is the honest scope: none of these
   * colours appears until something is clicked, so the block is describing an
   * interaction rather than labelling the sky.
   *
   * Built once. Families are a fact about the catalogue, not about the frame.
   */
  const conv = $('conv');
  conv.innerHTML = FAMILY_LEGEND.map(
    ({ family: value, label }) =>
      `<span class="conv"><i style="background:${FAMILY_LOOK[value]}"></i>${label}<b class="cn"></b></span>`
  ).join('');
  const convRows = [...conv.querySelectorAll<HTMLElement>('.conv')];
  const convNum = convRows.map((row) => row.querySelector<HTMLElement>('.cn')!);
  /** Which legend entry each family maps to, so lighting one is an array index. */
  const convAt = new Map<number, number>(FAMILY_LEGEND.map((e, n) => [e.family, n]));
  /** What was lit last time, so an unchanged frame writes no style at all. */
  let convLit = 0;
  /** The last count written beside each name, for the same reason. */
  const convCount = FAMILY_LEGEND.map(() => -1);
  /** Members of each family above the horizon, refilled on the cull. */
  const famUp: number[][] = FAMILY_LEGEND.map(() => []);
  /**
   * Which legend entry the pointer is resting on, or -1.
   *
   * Hovering a *name* reveals where that family is; it deliberately does not keep
   * anything. The rest of the piece treats a click as the instrument, and a legend
   * that selected six objects on a mouse-over would be an accident waiting to happen
   * every time someone reached for FULL SCREEN.
   */
  let revealed = -1;
  convRows.forEach((row, n) => {
    row.onpointerenter = () => { revealed = n; };
    row.onpointerleave = () => { if (revealed === n) revealed = -1; };
  });

  const cols = [names, selection, featured, family] as const;
  const passingGroup = new Group('Passing', GROUP_LOOK.passing, READOUT.passingRows, ...cols, level);
  const debrisGroup = new Group('Debris', GROUP_LOOK.debris, READOUT.debrisRows, ...cols, level);
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

  return {
    ringed: () => ringed,
    revealing: () => (revealed >= 0 ? FAMILY_LEGEND[revealed]!.family : -1),
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
      // Said only while it is true, and never otherwise. It no longer says `silent`,
      // because nothing is silenced any more: a held clock stops the phrases and a
      // fast one stands the whole mix back, and in both the belt goes on humming.
      soundNote.textContent = source.audio.attenuated ? (clock.isPaused ? 'held' : 'stood back') : '';
      if (!frame) return;

      if (frame !== scanned) {
        scanned = frame;
        passing.length = 0;
        debris.length = 0;
        choirUp.length = 0;
        // Which objects of each family are up, gathered on the pass that is already
        // walking the catalogue. The legend's counts and its reveal both read this, so
        // the number beside a name and the rings it draws can never disagree.
        for (const list of famUp) list.length = 0;
        for (let i = 0; i < frame.count; i++) {
          if (frame.range[i]! < 0 || frame.elevation[i]! <= lowestVisible) continue;
          const at = convAt.get(family[i] ?? 0);
          if (at !== undefined) famUp[at]!.push(i);
          if (isChoir(i)) choirUp.push(i);
          else if (isDebris(i)) debris.push(i);
          else passing.push(i);
        }
        for (let n = 0; n < convRows.length; n++) {
          const count = famUp[n]!.length;
          if (count !== convCount[n]) {
            convCount[n] = count;
            convNum[n]!.textContent = String(count);
          }
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

      /*
       * Light the legend entry for every family that is wearing its colour right now.
       *
       * **Kept or hovered, not merely listed**, because those are exactly the objects
       * that take an attention hue - a listed row rings white whatever family it is in,
       * so lighting on listed would name colours that are nowhere on screen.
       *
       * Two objects are skipped for the same reason the shader skips them, and the
       * block would otherwise tell a plain lie. A belt object stays blue however it is
       * tagged, because `choir` outranks family in `RING_VERT` and in `audio.ts` alike;
       * and a featured object keeps its cool white. Neither wears the hue, so neither
       * lights the name of it.
       */
      /*
       * **Revealing a family rings its members without keeping any of them.**
       *
       * Added 2026-09-23, and it answers a real complaint: an hour of play found no
       * navigation satellite at all. There were about **forty-nine** of them passing
       * the whole time - 4.5% of the 1,087 objects above the horizon, at 20,000 km, so
       * small and slow. Nothing was broken; they were simply not findable by pointing.
       *
       * The belt members are included on purpose, though they ring blue rather than in
       * the family's colour, because `choir` outranks family in the shader. That is
       * the other half of the same answer: 42 of the 69 military objects up at once are
       * parked in the belt, and 12 of the 14 weather. A reveal that quietly dropped
       * them would hide exactly the fact the count is there to expose.
       */
      if (revealed >= 0) {
        for (const i of famUp[revealed]!) if (ringed.indexOf(i) < 0) ringed.push(i);
      }

      let lit = 0;
      const claim = (i: number) => {
        if (i < 0 || isChoir(i) || featured[i] === 1) return;
        const at = convAt.get(family[i] ?? 0);
        if (at !== undefined) lit |= 1 << at;
      };
      for (const i of selection.marked) claim(i);
      claim(hovered);
      if (lit !== convLit) {
        for (let n = 0; n < convRows.length; n++) {
          convRows[n]!.classList.toggle('lit', (lit & (1 << n)) !== 0);
        }
        convLit = lit;
      }
    },

    pulse() {
      passingGroup.pulse();
      debrisGroup.pulse();
    },
  };
}
