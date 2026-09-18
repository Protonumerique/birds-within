# Birds Within

The tracked satellite catalogue, overhead, in realtime — from where you stand.

An abstract sky dome rather than a map: no Earth, no globe, just the hemisphere above
one observer and the objects crossing it. Sunlit objects are drawn as what you could
actually see with the naked eye; eclipsed ones as what is there but invisible.

A revival of a project first built in Java around 2010. The premise is what changed in
between: roughly a thousand active satellites then, well over ten thousand now plus
tens of thousands of tracked debris fragments.

## Running it

```bash
npm install
npm run fetch:catalog   # the real sky - see below
npm run dev
```

Without the fetch, the dev server shows `synthetic.bin` — ~1,450 **invented** orbits,
committed so the project runs offline — and says so on screen. `npm run fetch:catalog`
pulls the real catalogue from CelesTrak and packs it into `public/data/active.bin`
(16,563 active payloads) and `full.bin` (20,933: everything CelesTrak publishes, debris
included). Add `?catalog=full` to the URL for the larger set, and `?debug` for frame
timing and worker stats.

The page opens on a first screen — a title, a drawing of the sky, where you are standing
and a LAUNCH button.
Nothing heavy is fetched until that press: three.js, satellite.js, the propagation worker
and the catalogue are all behind a dynamic import, so the piece can sit in a hero section
on another page without costing a visitor who scrolls past it anything. `?launch` skips
the screen.

Drag to look around, scroll to zoom, click an object or a row to keep it. FULL SCREEN is
in the top right, `f` does the same from the keyboard, and Escape leaves.

## Embedding it

```html
<iframe src="https://birds.protonumerique.net/" allow="fullscreen; geolocation"
        style="width:100%;aspect-ratio:16/7;border:0"></iframe>
```

Neither permission is optional: without them the browser refuses full screen and
geolocation to the frame, and each button is hidden rather than drawn and broken.
Nothing asks for a location until someone presses USE MY LOCATION.

## How the data works

CelesTrak is contacted **only** by `scripts/fetch-catalog.mjs` — never by the browser.
Their GP data refreshes every two hours and their terms are enforced with 403s and IP
blocks, so a public page fetching directly would put every visitor's request on this
project's account. The deploy workflow fetches every six hours, packs the elements into a
compact binary, checks it, and publishes it with the site. Nothing is committed; the raw
data rides between runs in the Actions cache.

Element sets arrive as OMM JSON rather than TLE: since July 2026 new objects carry catalog
numbers the TLE format cannot represent. The binary format is documented at the top of
`src/catalog-format.ts`.

CelesTrak publishes about 21k of the ~35k objects on orbit — every payload, but only a
fraction of the debris. `public/data/SOURCES.md` has the detail.

## How it stays smooth

All orbit computation runs in a Web Worker on satellite.js's WASM `BulkPropagator` — about
15 ms for the whole `full` catalogue, a few times a second. The render thread never
propagates. Each object is drawn from two propagation ticks at once and blended on the
GPU every frame, so motion is continuous at any time rate while the CPU does almost
nothing per frame.

## Verifying it

The coordinate and time handling is validated against an independent implementation —
Brandon Rhodes' `sgp4` (Vallado's C++ reference) plus Skyfield — along every road a
position takes here: from TLE text, from OMM, from OMM through the packed binary, and
through the WASM propagator exactly as the worker runs it. Doppler range rate is checked
too.

```bash
npm run validate        # Node only
npm run check:catalog   # the fetched catalogues decode exactly, and look sane
```

ECI positions agree to about 10 cm; alt/az to a few thousandths of a degree; range rate
to well under 1 m/s.

Both sides of `validate` propagate `scripts/fixtures/validation.tle`, which is frozen on
purpose and must never be refreshed: the checked-in `scripts/reference.json` was computed
from those exact elements, so replacing them turns the check into a comparison of two
different things. Regenerating the reference is the only step that needs Python:

```bash
pip install sgp4 skyfield
python3 scripts/reference.py > scripts/reference.json
```

## Scale

```bash
npm run bench
```

satellite.js v7's WASM `BulkPropagator` handles 30k objects — with Doppler, sun position
and shadow fraction — in roughly 15–20 ms single-threaded, two to four times faster than
the pure-JS path. Single-threaded on purpose: the multi-threaded runtime needs response
headers GitHub Pages cannot send, and nothing needs it yet.

## Layout

```
src/
  config.ts            observer, dataset, dome, trail and clock settings
  catalog-format.ts    the packed catalogue binary - shared with the worker and scripts
  catalog.ts           fetching it and checking its header
  sky.worker.ts        every orbit computation: satrecs, WASM propagation, trails
  sky-frame.ts         the worker <-> render thread contract, and alt/az -> scene space
  sky-stream.ts        ticks ahead of scene time, and the pair to blend for now
  scene.ts             three.js — dome, GPU-blended points, trails, look controls
  clock.ts             scene time (the single authority)
  ui.ts                overlay
  fullscreen.ts        the full-screen toggle, and what to do when it is not allowed
  place.ts             where the visitor is, asked only when they press for it
  gate.ts              the first screen
  poster.ts            its drawing, built from the same palette the sky uses
  debug.ts             ?debug panel
  piece.ts             wiring and the frame loop — everything heavy hangs off this
  main.ts              the entry: the first screen, and a dynamic import of the piece
scripts/
  catalog-sources.mjs  which CelesTrak datasets, and why
  fetch-catalog.mjs    CelesTrak client — the only thing that talks to them
  pack-catalog.mjs     raw JSON -> public/data/*.bin
  check-catalog.mjs    pre-deploy gate: sanity + exact round trip
  make-synthetic.mjs   the invented offline fallback
  reference.py         independent reference (Python)
  validate.mjs         cross-implementation check
  bench.mjs            JS vs WASM at catalogue scale
  fixtures/            frozen elements for the check — never refreshed
public/data/           synthetic.bin (committed), active/full.bin (built), SOURCES.md
```

See `CLAUDE.md` for the architecture decisions and the roadmap.
