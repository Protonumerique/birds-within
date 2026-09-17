/**
 * Full screen, and the way back out of it.
 *
 * The piece is a canvas that fills whatever box it is given, so in a hero section it
 * is a wide letterbox. Full screen is the only control that changes the *frame* rather
 * than the image, which is why it lives in the corner with the hints rather than in the
 * column with the clock: it is not one of the piece's controls.
 *
 * **Escape is the browser's own, not ours.** Every engine leaves full screen on Escape
 * and says so the first time; there is nothing here to implement and nothing that could
 * swallow it. The hint appears while it is on, because "how do I get out" is the one
 * question a full-screen canvas with no chrome reliably raises.
 *
 * **Embedded, it may simply not be allowed.** An iframe gets no full screen unless the
 * page that embeds it says `allow="fullscreen"`, and `document.fullscreenEnabled` is
 * exactly that answer - so the button is not drawn at all rather than drawn and broken.
 * iPhone Safari never allows it for an element, and answers the same way.
 */
export interface Fullscreen {
  /** Whether this browser, in this frame, will do it at all. */
  readonly available: boolean;
  readonly active: boolean;
  toggle(): Promise<void>;
  /** Called whenever it goes on or off, however it happened - Escape included. */
  onchange: ((active: boolean) => void) | null;
  dispose(): void;
}

// Safari carried the prefixed names well past the point of needing them, and an old
// one in the wild costs two casts to keep working.
interface Prefixed {
  webkitRequestFullscreen?: () => Promise<void> | void;
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
}

export function createFullscreen(target: HTMLElement): Fullscreen {
  const doc = document as Document & Prefixed;
  const box = target as HTMLElement & Prefixed;

  const request = target.requestFullscreen?.bind(target) ?? box.webkitRequestFullscreen?.bind(box);
  const exit = document.exitFullscreen?.bind(document) ?? doc.webkitExitFullscreen?.bind(doc);
  const element = () => document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;

  // Not merely "does this engine have the API" but "will this frame be given it":
  // inside an iframe without `allow="fullscreen"`, the call rejects and the only
  // honest button is no button.
  //
  // Asked with `typeof` rather than for truthiness because lib.dom declares the
  // unprefixed methods as always present - an engine old enough to need the prefix is
  // exactly one the type definitions do not describe.
  let available =
    (document.fullscreenEnabled ?? doc.webkitFullscreenEnabled ?? false) &&
    (typeof target.requestFullscreen === 'function' ||
      typeof box.webkitRequestFullscreen === 'function') &&
    (typeof document.exitFullscreen === 'function' || typeof doc.webkitExitFullscreen === 'function');

  const api: Fullscreen = {
    get available() {
      return available;
    },
    get active() {
      return element() !== null;
    },
    onchange: null,

    async toggle() {
      if (!available) return;
      try {
        if (element()) await exit?.();
        else await request?.();
      } catch (err) {
        // Refused after all - an embedding permission we could not see from here.
        // Stop offering it rather than offering it and failing again.
        console.warn('[fullscreen]', err);
        available = false;
        api.onchange?.(false);
      }
    },

    dispose() {
      removeEventListener('fullscreenchange', changed);
      removeEventListener('webkitfullscreenchange', changed);
      removeEventListener('keydown', key);
    },
  };

  function changed() {
    api.onchange?.(api.active);
  }
  // `f` as well as the button: a piece meant to be looked at should not need the
  // pointer moved into a corner to fill the screen. Never while something is being
  // typed into, and never on top of a shortcut the browser already owns.
  function key(e: KeyboardEvent) {
    if (e.key !== 'f' && e.key !== 'F') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    e.preventDefault();
    void api.toggle();
  }

  addEventListener('fullscreenchange', changed);
  addEventListener('webkitfullscreenchange', changed);
  addEventListener('keydown', key);

  return api;
}
