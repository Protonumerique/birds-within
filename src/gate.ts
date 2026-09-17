import { GATE, OBSERVER } from './config';
import { posterSvg } from './poster';

/**
 * The first screen: a title, a drawing, four sentences and one button.
 *
 * It exists because the piece is meant to sit in a hero section on someone else's
 * page, and a visitor who scrolls past one should pay nothing for it. Three.js,
 * satellite.js, the WASM propagator and 831 KB of elements are all behind the press -
 * see `GATE` in config.ts, and the dynamic import in main.ts that does the splitting.
 *
 * The layout is the panel's own: the words sit in a column at the left, over a scrim
 * feathered on its right edge, with the sky filling the rest of the frame. So the
 * press does not replace one image with another - the poster becomes the thing it was
 * a drawing of, and the column is already where the column will be.
 */
export interface Gate {
  /** What the press is doing, said under the button while it does it. */
  status(text: string): void;
  /** Fade out and remove. Resolves once it is gone. */
  dismiss(): Promise<void>;
  /** The piece did not start. The screen stays, and says so. */
  fail(err: unknown): void;
}

export interface GateHandlers {
  /** The press. */
  launch(): void;
  /**
   * The pointer has reached the button, which is intent rather than arrival: start
   * fetching the piece's chunk now, so the press has less to wait for. Optional, and
   * called at most once.
   */
  warm?(): void;
}

export function createGate(root: HTMLElement, handlers: GateHandlers): Gate {
  const lat = `${Math.abs(OBSERVER.latitudeDeg).toFixed(2)}°${OBSERVER.latitudeDeg >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(OBSERVER.longitudeDeg).toFixed(2)}°${OBSERVER.longitudeDeg >= 0 ? 'E' : 'W'}`;

  const el = document.createElement('div');
  el.className = 'gate';
  // One source of truth for how long the screen takes to leave: the stylesheet fades
  // it, `dismiss` waits for exactly that, and both read GATE.fadeMs.
  el.style.setProperty('--gate-fade', `${GATE.fadeMs}ms`);
  el.innerHTML = `
    ${posterSvg()}
    <div class="gate-scrim"></div>
    <div class="gate-copy">
      <h1 class="gate-title">${GATE.title}</h1>
      <div class="gate-tagline">${GATE.tagline}</div>
      <p class="gate-lede">${GATE.lede}</p>
      <button class="gate-launch" type="button">${GATE.launchLabel}</button>
      <div class="gate-status" role="status" aria-live="polite"></div>
      <div class="gate-meta">${OBSERVER.name} · ${lat} ${lon} · elements from CelesTrak</div>
      <div class="gate-hint">${GATE.hint}</div>
    </div>
  `;
  root.append(el);

  const button = el.querySelector<HTMLButtonElement>('.gate-launch')!;
  const statusEl = el.querySelector<HTMLElement>('.gate-status')!;

  let warmed = false;
  const warm = () => {
    if (warmed) return;
    warmed = true;
    handlers.warm?.();
  };
  // Intent, not arrival: a pointer resting on the button, or a keyboard reaching it,
  // is enough to start fetching. The press itself then has less to wait for.
  button.addEventListener('pointerenter', warm);

  let pressed = false;
  button.addEventListener('click', () => {
    if (pressed) return;
    pressed = true;
    button.disabled = true;
    button.textContent = GATE.loadingLabel;
    warm();
    handlers.launch();
  });

  // Focused, so Enter works for anyone who never touches a pointer - but without
  // scrolling the host page, which a hero section would feel as a jump.
  //
  // **Before the focus listener is attached, and that ordering is the whole point.**
  // Warming on focus and then focusing the button is the same thing as loading the
  // piece on page load, which is exactly what this screen exists not to do - and it
  // costs 160 kB silently, with nothing on screen to show for it. Focus counts as
  // intent only when something other than this line causes it.
  button.focus({ preventScroll: true });
  button.addEventListener('focus', warm);

  return {
    status(text) {
      statusEl.textContent = text;
    },

    fail(err) {
      button.disabled = false;
      button.textContent = GATE.launchLabel;
      pressed = false;
      statusEl.classList.add('err');
      statusEl.textContent = String(err);
    },

    dismiss() {
      el.classList.add('out');
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          el.remove();
          resolve();
        }, GATE.fadeMs);
      });
    },
  };
}
