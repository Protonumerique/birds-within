/**
 * What the pointer is touching, and what it has stuck to.
 *
 * Shared by the scene (which draws the rings) and the readout (which pins the rows),
 * so the two can never disagree about which objects are marked. Indices are frame
 * columns, like every other index in the app.
 *
 * Nothing textual belongs on the sky, so the whole response to the pointer is a ring
 * on the object and a box on its row in the lower panel - see CLAUDE.md.
 */
export class Selection {
  /** Objects the user clicked. They stay ringed, and hold a row, until they set. */
  readonly marked = new Set<number>();

  /** Bumped whenever anything here changes, so readers can upload only on a change. */
  version = 0;
  /**
   * Bumped only when a mark is taken or let go, never by hover. Tracks are rebuilt
   * from this: the pointer moves far too often to rebuild them on `version`.
   */
  marksVersion = 0;

  /**
   * Called when a click *takes* an object, never when it lets one go.
   *
   * It exists so that keeping something can start the sound. That has to happen
   * inside the click itself - a browser only allows an AudioContext to be created
   * from a user gesture, and the frame loop is not one - and both ways of keeping
   * something, the sky and the belt's grid, already come through `toggle`. Hanging it
   * here rather than on either caller is what stops the grid needing to know the
   * sound exists at all.
   */
  onMark: ((index: number) => void) | null = null;

  private hoveredIndex = -1;
  /** Marking order, most recent last: the newest mark is the one wearing the trail. */
  private order: number[] = [];

  /** The object under the pointer, or -1. */
  get hovered(): number {
    return this.hoveredIndex;
  }

  setHovered(index: number): void {
    if (index === this.hoveredIndex) return;
    this.hoveredIndex = index;
    this.version++;
  }

  isMarked(index: number): boolean {
    return this.marked.has(index);
  }

  /** Click: stick to an unmarked object, let go of a marked one. */
  toggle(index: number): void {
    if (index < 0) return;
    if (this.marked.delete(index)) {
      this.order = this.order.filter((i) => i !== index);
    } else {
      this.marked.add(index);
      this.order.push(index);
      this.onMark?.(index);
    }
    this.version++;
    this.marksVersion++;
  }

  /** Drop a mark the user did not drop - an object that has set below the horizon. */
  release(index: number): void {
    if (!this.marked.delete(index)) return;
    this.order = this.order.filter((i) => i !== index);
    this.version++;
    this.marksVersion++;
  }

  /** The most recently marked object, or -1. */
  get newest(): number {
    return this.order.length ? this.order[this.order.length - 1]! : -1;
  }

  /**
   * The most recently marked object the caller will accept, or -1. The track goes to
   * this one: the choir gets none, so the newest mark is not always the answer.
   */
  newestWhere(accept: (index: number) => boolean): number {
    for (let k = this.order.length - 1; k >= 0; k--) {
      const i = this.order[k]!;
      if (accept(i)) return i;
    }
    return -1;
  }
}
