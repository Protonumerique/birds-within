import { GATE, observerIsCustom, observerLabel, resetObserver } from './config';
import { askPermission, canPoint, preferPointing } from './orientation';
import { canLocate, locate } from './place';
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
      <div class="gate-go">
        <div class="gate-mode" hidden>
          <div class="gate-mode-label">${GATE.modeLabel}</div>
          <button class="mode-switch point" type="button" role="switch" aria-checked="true" aria-label="${GATE.modeLabel}">
            <span class="ms-drag">DRAG</span><i class="ms-track"><b class="ms-knob"></b></i><span class="ms-point">POINT</span>
          </button>
        </div>
        <button class="gate-launch" type="button">${GATE.launchLabel}</button>
      </div>
      <div class="gate-status" role="status" aria-live="polite"></div>
      <div class="gate-where">
        <span class="gate-place"></span>
        <button class="gate-locate" type="button" hidden></button>
      </div>
      <div class="gate-placenote"></div>
      <div class="gate-meta">elements from CelesTrak, refreshed every six hours</div>
      <div class="gate-hint">${matchMedia('(pointer: coarse)').matches ? GATE.touchHint : GATE.hint}</div>
    </div>
  `;
  root.append(el);

  const button = el.querySelector<HTMLButtonElement>('.gate-launch')!;

  /*
   * How to look, chosen before the press so the visitor knows what to expect. Offered
   * only where pointing can work at all - a finger, a sensor API and a secure page - and
   * it starts on POINT there, because on a phone that is the piece at its best. See
   * *Pointing the phone at the sky* in CLAUDE.md.
   */
  const modeEl = el.querySelector<HTMLElement>('.gate-mode')!;
  const modeSwitch = el.querySelector<HTMLButtonElement>('.mode-switch')!;
  const pointable = canPoint();
  modeEl.hidden = !pointable;
  let pointMode = pointable;
  const paintMode = () => {
    modeSwitch.classList.toggle('point', pointMode);
    modeSwitch.setAttribute('aria-checked', String(pointMode));
  };
  modeSwitch.addEventListener('click', () => {
    pointMode = !pointMode;
    paintMode();
  });
  paintMode();
  const statusEl = el.querySelector<HTMLElement>('.gate-status')!;

  /*
   * Where you are standing, and the offer to stand somewhere else.
   *
   * **This is the only place the observer can change without a reload**, and the
   * reason is the first screen itself: at this moment the piece does not exist - no
   * worker, no satrecs, no catalogue - because all of it is behind the press. Moving
   * the observer here costs nothing at all. Once LAUNCH is pressed the worker holds
   * the observer it was built with, and changing it would mean re-initialising twenty
   * thousand orbits; that is why the offer lives here and not in the panel.
   *
   * Nothing is asked before the press. See place.ts.
   */
  const placeEl = el.querySelector<HTMLElement>('.gate-place')!;
  const placeNote = el.querySelector<HTMLElement>('.gate-placenote')!;
  const locateBtn = el.querySelector<HTMLButtonElement>('.gate-locate')!;

  const paintPlace = () => {
    placeEl.textContent = observerLabel();
    // Offered only when there is something to offer: somewhere else to stand, or the
    // way back. A browser that will not share a location gets no button at all rather
    // than a button that always fails.
    const custom = observerIsCustom();
    locateBtn.hidden = !custom && !canLocate();
    locateBtn.textContent = custom ? 'BACK TO BERLIN' : 'USE MY LOCATION';
  };

  locateBtn.addEventListener('click', async () => {
    if (observerIsCustom()) {
      resetObserver();
      placeNote.textContent = '';
      paintPlace();
      return;
    }
    locateBtn.disabled = true;
    locateBtn.textContent = 'LOCATING…';
    placeNote.textContent = '';
    try {
      await locate();
      placeNote.textContent = 'the sky from where you are';
    } catch (err) {
      placeNote.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      locateBtn.disabled = false;
      paintPlace();
    }
  });

  paintPlace();

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
    // Asked here, synchronously inside the press, because iOS grants the sensor to no
    // other kind of call - and the piece that will use it loads a second too late.
    preferPointing(pointMode);
    if (pointMode) void askPermission();
    modeSwitch.disabled = true;
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
      modeSwitch.disabled = false;
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
