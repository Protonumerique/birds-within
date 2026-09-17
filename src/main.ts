import './style.css';

import { GATE } from './config';
import { createGate, type Gate } from './gate';

/**
 * The entry point, and deliberately almost nothing.
 *
 * Everything the piece needs - three.js, satellite.js, the WASM propagator, the
 * worker, the 831 KB catalogue - lives behind the dynamic `import('./piece')` below,
 * so a page that shows the first screen and is never pressed fetches none of it. That
 * is what lets the piece sit in a hero section on another page without charging every
 * visitor who scrolls past for a sky they did not ask to see. See `GATE` in config.ts.
 *
 * `?launch` skips the screen and starts straight into the piece: development, and a
 * link that means to arrive already inside it.
 */

/** Started at most once, and possibly before the press - see `warm` in gate.ts. */
let chunk: Promise<typeof import('./piece')> | null = null;
const load = () => (chunk ??= import('./piece'));

/** Without the first screen, the piece says what it is doing where the panel will be. */
function hudStatus(text: string) {
  const hud = document.querySelector<HTMLElement>('#hud');
  if (hud) hud.innerHTML = `<div class="col"><h1>${GATE.title}</h1><div class="sub">${text}</div></div>`;
}

function hudError(err: unknown) {
  const hud = document.querySelector<HTMLElement>('#hud');
  if (hud) hud.innerHTML = `<div class="col"><h1>${GATE.title}</h1><p class="err">${String(err)}</p></div>`;
}

async function start(gate: Gate | null) {
  try {
    const { run } = await load();
    // Resolves at the first frame with a sky in it, so the screen leaves at the
    // moment there is something behind it rather than a moment before.
    await run(gate ? (text) => gate.status(text) : hudStatus);
    await gate?.dismiss();
  } catch (err) {
    console.error(err);
    if (gate) gate.fail(err);
    else hudError(err);
  }
}

if (new URLSearchParams(location.search).has('launch')) {
  void start(null);
} else {
  const gate = createGate(document.body, {
    launch: () => void start(gate),
    warm: () => void load(),
  });
}
