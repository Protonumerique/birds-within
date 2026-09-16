import { CHOIR_GRID, GROUP_LOOK } from './config';
import type { SkyFrame } from './sky-frame';
import type { Selection } from './selection';

const deg = (rad: number) => (rad * 180) / Math.PI;
const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (azDeg: number) => POINTS[Math.round((((azDeg % 360) + 360) % 360) / 22.5) % 16]!;

/**
 * The belt, as a grid of squares - one per geostationary object above the horizon.
 *
 * Five hundred objects that never rise and never set are not a list. They are a fixed
 * arc across the southern sky, and the same set is up at every hour of every day, so
 * there is nothing to sort and nothing to update: the right shape for them is a
 * keyboard, not a table.
 *
 * **Squares are in azimuth order, read left to right and wrapped** like text: the first
 * square is one end of the arc, the last is the other, and neighbours in the grid are
 * neighbours on the belt. An arbitrary order would have cost exactly the same and meant
 * nothing.
 *
 * It filled column by column at first, which made *horizontal position* in the grid
 * equal horizontal position in the sky - a stronger mapping, but it left the remainder
 * as a ragged part-column down the right-hand edge. Wrapping by rows puts the remainder
 * on the bottom row, where a half-finished line is what every reader already expects.
 * Adjacency survives the trade; only the global x = azimuth reading is given up.
 *
 * No text lives in the grid. One box above it fills while the pointer is on a square
 * and is otherwise empty, which is how five hundred objects cost five hundred squares
 * and not one label - the same rule the sky itself obeys.
 */
export class ChoirGrid {
  readonly element: HTMLElement;

  private box: HTMLElement;
  private grid: HTMLElement;
  private countEl: HTMLElement;
  /** Frame-column index per cell, in grid order. */
  private cells: number[] = [];
  private nodes: HTMLElement[] = [];
  private lastHovered = -1;
  private lastMarks = -1;

  constructor(private names: string[], private selection: Selection) {
    this.element = document.createElement('section');
    this.element.className = 'group choir';
    this.element.style.setProperty('--tone', GROUP_LOOK.belt.tone);
    this.element.innerHTML =
      `<h2><span class="gg ${GROUP_LOOK.belt.shape}"></span>` +
      `<span class="gt">Geostationary</span><span class="gn"></span></h2>` +
      `<div class="cbox"><span class="cn"></span><span class="cd"></span></div>` +
      `<div class="cgrid"></div>`;
    this.countEl = this.element.querySelector<HTMLElement>('.gn')!;
    this.box = this.element.querySelector<HTMLElement>('.cbox')!;
    this.grid = this.element.querySelector<HTMLElement>('.cgrid')!;
    this.grid.style.setProperty('--cols', String(CHOIR_GRID.columns));
    this.grid.style.setProperty('--cell', `${CHOIR_GRID.cellPx}px`);
    this.grid.style.setProperty('--gap', `${CHOIR_GRID.gapPx}px`);

    this.grid.onpointermove = (e) => {
      const i = this.indexAt(e.target);
      if (i >= 0) this.selection.setHovered(i);
    };
    this.grid.onpointerleave = () => this.selection.setHovered(-1);
    this.grid.onclick = (e) => this.selection.toggle(this.indexAt(e.target));
  }

  private indexAt(target: EventTarget | null): number {
    const el = (target as HTMLElement | null)?.closest('.cell') as HTMLElement | null;
    if (!el) return -1;
    const n = Number(el.dataset.n);
    return Number.isInteger(n) ? (this.cells[n] ?? -1) : -1;
  }

  /** `up` is every choir object above the horizon, in any order. */
  update(frame: SkyFrame, up: readonly number[]): void {
    this.countEl.textContent = String(up.length);

    // The membership of the belt barely changes - these objects never set - so the
    // grid is rebuilt only when it actually differs, not every tick.
    if (this.cells.length !== up.length || this.cells.some((i, n) => i !== up[n])) {
      this.cells = [...up];
      this.cells.sort((a, b) => frame.azimuth[a]! - frame.azimuth[b]!);
      this.build();
    }

    const hovered = this.selection.hovered;
    const marks = this.selection.marksVersion;
    if (hovered !== this.lastHovered) {
      this.nodes.forEach((el, n) => el.classList.toggle('hov', this.cells[n] === hovered));
      this.lastHovered = hovered;
      this.fillBox(frame, hovered);
    }
    if (marks !== this.lastMarks) {
      this.nodes.forEach((el, n) => el.classList.toggle('on', this.selection.isMarked(this.cells[n]!)));
      this.lastMarks = marks;
    }
  }

  private fillBox(frame: SkyFrame, i: number): void {
    const name = this.box.firstElementChild as HTMLElement;
    const data = this.box.lastElementChild as HTMLElement;
    if (i < 0 || this.cells.indexOf(i) < 0) {
      name.textContent = '';
      data.textContent = '';
      return;
    }
    const azDeg = ((deg(frame.azimuth[i]!) % 360) + 360) % 360;
    name.textContent = this.names[i] ?? '—';
    data.textContent =
      `${deg(frame.elevation[i]!).toFixed(0)}° ${azDeg.toFixed(0)}°${compass(azDeg)} ` +
      `${frame.range[i]!.toLocaleString('en', { maximumFractionDigits: 0 })}km`;
  }

  private build(): void {
    this.grid.textContent = '';
    this.nodes = this.cells.map((_, n) => {
      const el = document.createElement('div');
      el.className = 'cell';
      el.dataset.n = String(n);
      this.grid.append(el);
      return el;
    });
    this.lastHovered = -1;
    this.lastMarks = -1;
  }
}
