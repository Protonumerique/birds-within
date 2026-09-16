import { HIGHLIGHT, READOUT } from './config';
import type { SkyFrame } from './sky-frame';
import type { Selection } from './selection';

const deg = (rad: number) => (rad * 180) / Math.PI;
const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (azDeg: number) => POINTS[Math.round((((azDeg % 360) + 360) % 360) / 22.5) % 16]!;

/** Hex to `r, g, b`, so a row can be tinted at any brightness. */
function channels(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

/**
 * The same curve the ring shader runs, so a kept row dims as its object descends in
 * step with the ring around it. Nothing has to be read for the two to agree.
 */
function brightness(elevation: number): number {
  const t = Math.min(Math.max(elevation / ((HIGHLIGHT.fullBrightDeg * Math.PI) / 180), 0), 1);
  return HIGHLIGHT.dimAtHorizon + (1 - HIGHLIGHT.dimAtHorizon) * t;
}

interface Row {
  el: HTMLElement;
  name: HTMLElement;
  data: HTMLElement;
  index: number;
}

/**
 * One list in the column: a heading, a handful of kept rows, and the default rows
 * under them.
 *
 * The two zones behave differently on purpose. **Default rows sort themselves by
 * elevation** and show names only - they are a view of what is up, and they churn.
 * **Kept rows do not move.** They sit above, in the order they were kept, unfolded to
 * show their data and boxed in the group's colour, and they stay put as the sky turns
 * underneath. A new one appends to the bottom of that zone, so nothing already there
 * shifts: whatever you are watching keeps the position you found it in, which is what
 * makes it addressable later - by a control, or by a voice.
 */
export class Group {
  readonly element: HTMLElement;
  /** What this group is showing, in display order. Kept first. */
  readonly listed: number[] = [];

  private rowsEl: HTMLElement;
  private countEl: HTMLElement;
  private pool: Row[] = [];
  private readonly rgb: string;
  /** Is the pointer in this list right now. See `update` for what it decides. */
  private pointerInside = false;

  constructor(
    title: string,
    look: { shape: string; tone: string; accent: string },
    private defaultRows: number,
    private names: string[],
    private selection: Selection
  ) {
    this.rgb = channels(look.accent);
    this.element = document.createElement('section');
    this.element.className = 'group';
    // Two colours on the section: what the rows rest at, and what attention looks like.
    this.element.style.setProperty('--tone', look.tone);
    this.element.style.setProperty('--accent', look.accent);
    this.element.innerHTML =
      `<h2><span class="gg"></span><span class="gt"></span><span class="gn"></span></h2><div class="rows"></div>`;
    this.element.querySelector<HTMLElement>('.gg')!.classList.add(look.shape);
    this.element.querySelector<HTMLElement>('.gt')!.textContent = title;
    this.rowsEl = this.element.querySelector<HTMLElement>('.rows')!;
    this.countEl = this.element.querySelector<HTMLElement>('.gn')!;

    // A row and its object are the same thing touched from two places.
    this.rowsEl.onclick = (e) => this.selection.toggle(this.indexAt(e.target));
    this.rowsEl.onpointerenter = () => {
      this.pointerInside = true;
    };
    this.rowsEl.onpointermove = (e) => {
      this.pointerInside = true;
      const i = this.indexAt(e.target);
      if (i >= 0) this.selection.setHovered(i);
    };
    this.rowsEl.onpointerleave = () => {
      this.pointerInside = false;
      this.selection.setHovered(-1);
    };
  }

  private indexAt(target: EventTarget | null): number {
    const el = (target as HTMLElement | null)?.closest('.row');
    const row = this.pool.find((r) => r.el === el);
    return row && row.index >= 0 ? row.index : -1;
  }

  private rowAt(n: number): Row {
    let row = this.pool[n];
    if (!row) {
      const el = document.createElement('div');
      el.className = 'row';
      el.innerHTML = `<span class="rn"></span><span class="rd"></span>`;
      this.rowsEl.append(el);
      row = { el, name: el.firstElementChild as HTMLElement, data: el.lastElementChild as HTMLElement, index: -1 };
      this.pool[n] = row;
    }
    return row;
  }

  /** `candidates` must already be sorted by elevation, highest first. */
  update(frame: SkyFrame, candidates: readonly number[], total: number): void {
    const { selection } = this;
    const hovered = selection.hovered;

    // Kept first, in the order they were kept, so a row already on screen never moves.
    this.listed.length = 0;
    for (const i of selection.marked) {
      if (candidates.indexOf(i) >= 0) this.listed.push(i);
    }
    // A hovered object with no row of its own borrows one at the bottom of the open
    // zone, so nothing above it moves - but **only while the pointer is out in the
    // sky**. An open row is two lines tall, so opening one while the pointer is in
    // this list pushes every row below it down, including the one under the cursor,
    // which then slides away and marks the wrong object when clicked. Pointing at the
    // sky cannot do that, because the pointer is nowhere near the rows.
    if (
      READOUT.hoverOpensRow &&
      !this.pointerInside &&
      hovered >= 0 &&
      !selection.isMarked(hovered) &&
      candidates.indexOf(hovered) >= 0
    ) {
      this.listed.push(hovered);
    }
    const open = this.listed.length;

    for (const i of candidates) {
      if (this.listed.length >= open + this.defaultRows) break;
      if (this.listed.indexOf(i) < 0) this.listed.push(i);
    }

    this.countEl.textContent = String(total);

    for (let r = 0; r < Math.max(this.listed.length, this.pool.length); r++) {
      const i = this.listed[r];
      if (i === undefined) {
        const row = this.pool[r];
        if (row) {
          row.index = -1;
          row.el.hidden = true;
        }
        continue;
      }
      const row = this.rowAt(r);
      row.el.hidden = false;
      row.index = i;

      const isOpen = r < open;
      row.el.classList.toggle('open', isOpen);
      // A closed row under the pointer is tinted, never unfolded: colour costs no
      // layout, so the row cannot move out from under the cursor that is on it.
      row.el.classList.toggle('lit', !isOpen && i === hovered);
      row.name.textContent = this.names[i] ?? '—';

      // A closed row drops its inline override and rests at the group's own colours.
      if (!isOpen) {
        row.el.style.removeProperty('--accent');
        continue;
      }
      const alpha = i === hovered ? 1 : brightness(frame.elevation[i]!);
      row.el.style.setProperty('--accent', `rgba(${this.rgb}, ${alpha.toFixed(2)})`);
      const azDeg = ((deg(frame.azimuth[i]!) % 360) + 360) % 360;
      const rate = frame.rangeRate[i]!;
      row.data.textContent =
        `${deg(frame.elevation[i]!).toFixed(0)}° ${azDeg.toFixed(0)}°${compass(azDeg)} ` +
        `${frame.range[i]!.toFixed(0)}km ${rate >= 0 ? '+' : ''}${rate.toFixed(1)}`;
    }
  }
}
