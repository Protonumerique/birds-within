# Birds Within — context for Claude Code

Read this first. It carries the decisions across sessions and machines.

## What this is

A revival of a project Luis built around 2010 in Java: satellites overhead, visualised
and sonified from their trajectories. This is the contemporary version — a browser
piece, realtime, on a standalone subdomain.

The premise is the change in the sky itself. In 2010 there were roughly a thousand
active satellites. Today it is well over ten thousand, dominated by megaconstellations,
plus tens of thousands of tracked debris fragments. Same code, today's catalogue,
categorically different image. **That density is the piece**, so decisions that make
the density legible beat decisions that make individual objects identifiable.

It is an artwork, not a tracker. stuff-in-orbit, satellitemap and KeepTrack already
exist and are excellent. Do not drift toward feature parity with them — no search, no
object info panels, no orbital element readouts beyond what serves the image.

### No tags on the sky

Decided 2026-09-13. Nothing textual is drawn on or beside objects in the sky: no name
tags, no hover tooltips, no floating data panels that follow an object. The sky carries
visual marks only. Text belongs in the lower panel, which is meant to stay uncluttered
and to hold data and, later, controls such as sound.

The pointer, added 2026-09-14, is built entirely within that rule. Nothing appears at
the cursor: hovering an object rings it amber, and its row — if it has one — is boxed in
the same amber and steps 20 px out of the column. One colour in two places is the whole
link between a mark on the sky and a name in the panel. See *The pointer* below.

## Locked-in direction

| | |
|---|---|
| **Framing** | Observer looking up, rendered abstractly. **No Earth geometry, no globe, no map.** The scene is a hemisphere in horizontal (alt/az) coordinates, camera at the observer. |
| **Scope** | **Everything CelesTrak publishes: ~21k objects** — every payload, and ~3k of the ~15k debris on orbit. The full ~35k catalogue exists only on Space-Track, which a public page cannot redistribute. See *The catalogue* below. |
| **Sound** | Phase 2. The data model already emits what it needs. |
| **Data on screen** | **No tags, labels or info panels on the sky.** Names and numbers live in the lower panel, which also becomes the home for controls (sound, likely). The sky carries only visual marks — rings, trails, haze. The pointer obeys this too: it rings objects, it never labels them. See *No tags on the sky* below. |
| **Hosting** | Standalone subdomain, own repo. |
| **Stack** | Vite + TypeScript + three.js + satellite.js v7. No framework. |

## Architecture

### Data flow

```
CelesTrak GP API ──(deploy.yml, every 6h: fetch → pack → check → build)──> Pages: data/*.bin
                          │                                                      │
                  Actions cache: .catalog-cache/                                 ▼
                                                     render thread ── bytes ──> sky worker
                                                          ▲                     (satrecs, WASM)
                                                          └──── SkyFrame per tick ────┘
```

**The browser must never fetch CelesTrak directly.** Two reasons, the second decisive:
they send no CORS headers, and their terms are enforced — one download per dataset per
2-hour cycle, HTTP 403 then IP firewall blocks on abuse, restrictions past 100 MB/day.
A public page fetching directly puts every visitor's request on our account.
`scripts/fetch-catalog.mjs` is the only thing that talks to them, and it will not
request a dataset fetched under 2 hours ago.

Element accuracy degrades over *days*, so a 6-hourly snapshot is generous. Do not add
polling, "live" refresh, or a client-side cache-busting scheme.

### The catalogue

**OMM, not TLE.** CelesTrak ran out of 5-digit catalog numbers on 2026-07-11. Everything
catalogued since has a 6-digit number and **no TLE at all** — a TLE pipeline silently
misses every new launch. The pipeline fetches `FORMAT=json` (OMM) and satrecs are built
with `json2satrec`; there is no TLE text anywhere at runtime. `json2satrec` parses `EPOCH`
with `new Date()`, i.e. to the millisecond, so storing epochs as float64 ms loses nothing
it would use.

**Packed.** `src/catalog-format.ts` is a columnar little-endian binary: a column per
field, angles ×1e4 and eccentricity / mean motion ×1e8 as int32, the drag terms as
float64, names in a UTF-8 blob, plus a `kind` byte (debris / rocket body / other) read
from the name — a heuristic, but enough to read density composition. The encoder checks
that every scaled value round-trips **bit-exactly** and falls back to float64 per field if
one does not, recording the choice in the header. Columnar beats row layout because whole
constellation shells share values; measured on `active`: JSON 1,030 KB gzipped, row
float64 895 KB, columnar float64 814 KB, columnar scaled 661 KB.

The same file runs in the browser, the worker and, through Node's type stripping, the
scripts. Keep it **import-free and erasable-syntax-only** (no enums, no parameter
properties) or the pipeline breaks. GitHub Pages gzips `application/octet-stream` — verified
on the live `.bin` files — so there is no hand-rolled compression.

| dataset | objects (2026-09-13) | size | what |
|---|---|---|---|
| `full` | 20,933 | 831 KB gzipped | union of every CelesTrak GP dataset, newest elements win — **the default** |
| `active` | 16,563 | 661 KB gzipped | every payload CelesTrak lists as active: the same sky with the wreckage removed |
| `synthetic` | 1,692 | 129 KB | **invented** orbits, committed, development fallback only |

`?catalog=` switches without a rebuild: which image the piece wants is an aesthetic
question, answered by looking. **`full` became the default on 2026-09-14**, once debris
had a mark of its own — the piece is about density, and `active` is payloads only, so it
was publishing a sky with the wreckage edited out. `?catalog=active` still gives that sky.
It costs 831 KB gzipped against 661, and a worker tick of 14–17 ms against ~13. The **dev server** falls back to `synthetic` when the real
catalogue has not been fetched, and the HUD labels it. **Production never falls back** —
a missing catalogue is an error, because the piece is about what is actually up there.

**CelesTrak has no full-catalogue query.** `SPECIAL=GPZ` is the GEO Protected Zone, not
"everything". SATCAT counted 35,093 objects on orbit on 2026-09-13; every CelesTrak GP
dataset together is 20,933 of them — every payload, but ~3k of ~15k debris, nearly all
from the Fengyun-1C, Cosmos 2251 and Iridium 33 breakups. General debris and most rocket
bodies are not published as GP data. `scripts/catalog-sources.mjs` holds the list.

### The choir

Decided 2026-09-14. The geosynchronous belt is not a set of passes and is not treated
as one. From Berlin it is a **fixed arc across the southern sky**, peaking at 30° due
south and sinking to the horizon toward east and west — roughly 150° of the ring is up,
and those objects never rise and never set. Turn the camera south and they read as a
line of still points while everything else streams past. That contrast is free: it
falls straight out of the geometry.

- **Membership is decided from the elements**, in `isGeosynchronous` in
  `catalog-format.ts`: 0.95–1.05 revolutions a day and eccentricity under 0.05. Not
  from range — a Molniya or Tundra orbit reaches the same distance at apogee and *does*
  pass, slowly; the eccentricity is what tells them apart. A half-synchronous navigation
  satellite (two revolutions a day) rises and sets like anything else. The band is
  generous, ±1300 km around the geostationary radius, so it takes in the graveyard and
  the inclined ones left drifting when station-keeping stopped.
- **The worker computes it once at init** and ships a `choir` byte array in `ready`,
  beside `kind`. It has to happen there: the render thread transfers the catalogue away
  and never sees a mean motion.
- **They are kept out of the lists entirely** — the readout's *Passing* and *Debris*
  groups count only passes. They get **no track**, kept or not — 70 minutes of a geosynchronous orbit
  is a few degrees of wobble around a fixed point, a smudge where the object already is.
  They are **never the track's fallback** either, so keeping one does not take the
  ambient track away from the sky.
- **They are blue from the start**, points and rings alike — not only when touched. See
  *Colour and visual conventions*. Their ring is also **smaller** (`CHOIR`) and at a
  steady brightness rather than dimmed by elevation: they do not climb or descend, so
  dimming them by it would say something untrue.
- **Exempt from `releaseBelowDeg`** (5°): a good many sit under it forever, and that
  rule would make the low half of the belt impossible to keep. They are let go at
  `SKY.lowestVisibleDeg` instead — nothing holds a mark the sky is not drawing.
- Their data lives in a **grid of squares** at the foot of the column, not a list —
  see *The panel*. Five hundred objects that never move are not a list.
- `synthetic.bin` carries **240 invented belt objects** so all of this is exercisable
  offline. Deliberately over-represented at ~15% against a real few per cent: a dev sky
  has to show the thing being worked on.

### Propagation: all of it in the sky worker

`src/sky.worker.ts` is the only place orbits are computed for display. The render thread
fetches the catalogue, checks its header, and **transfers** the bytes to the worker, which
decodes them, builds satrecs, and from then on answers two requests: a `SkyFrame` for a
given scene time, and one object's track. satellite.js is not even in the render thread's
bundle.

satellite.js v7's **WASM `BulkPropagator`**, single-threaded:

| path | objects | per tick |
|---|---|---|
| pure JS, eci + lookAngles (`npm run bench`) | 30,000 | ~41–59 ms |
| WASM, 8 calculators (`npm run bench`) | 30,000 | ~15–21 ms |
| WASM in the worker, as configured | 20,931 (`full`) | 14–17 ms |

**Single-thread, deliberately.** `createMultiThreadRuntime()` would divide this further,
but pthreads needs `SharedArrayBuffer`, which needs cross-origin isolation, which means
the host must send `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. **GitHub Pages cannot send headers.**
Netlify and Cloudflare Pages can. Nothing currently needs it.

The single-thread WASM build embeds its binary inside JavaScript (`wasm-build/base-release`,
~150 KB, dynamically imported by the worker). There is **no `.wasm` asset**, so no MIME type
to get wrong on the host.

The worker's calculators: `EciBase`, `Gmst`, `EcfPosition`, `EcfVelocity`, `LookAngles`
(observer geodetic), `DopplerFactor` (observer as an **ECF vector**, not geodetic),
`SunPosition`, `ShadowFraction` (0 = sunlit, 1 = umbra). Shadow is **naked-eye
visibility**, and is doing real artistic work: which of these thousands of objects you
could actually see.

**Range rate is `DopplerFactorCalculator`, verified before use.** It was checked against a
central difference (±0.5 s) of the validated JS range, on every object of `full` at three
instants:

| class | p99 | worst |
|---|---|---|
| near earth (SGP4), above horizon | 0.14 m/s | 1.3 m/s |
| near earth (SGP4), below horizon | 0.12 m/s | 2.2 m/s |
| deep space (SDP4), above horizon | 0.37 m/s | 3.0 m/s |
| deep space (SDP4), below horizon | 0.76 m/s | 5.4 m/s |

A mishandled Earth-rotation term would show ~280 m/s at this latitude; the residual is
SGP4's velocity not being exactly the derivative of its position. The 1-second forward
difference it replaced was 69 m/s off near closest approach — it estimates the rate half a
second late — and cost a second propagation per object; Doppler costs 0.9 ms per tick.
`npm run validate` keeps checking it on the fixture, at 1 m/s tolerance.

`BulkPropagator` allocates WASM memory that is not garbage collected. The worker disposes
the propagator and runtime before re-initialising; otherwise they live as long as the page.
Init — decode, 21k `json2satrec`, and a ~600 ms `setSatRecs` — takes 0.6–0.8 s in the worker,
behind a "building N orbits…" status, with the page responsive throughout.

### Colour and visual conventions

Decided 2026-09-14, in `PALETTE` and `KIND_LOOK`. Two axes, kept strictly apart:

- **Hue says what a thing *is*.** Warm white `#fff2d6` is a passing satellite; blue
  `#8ad4ff` is geostationary. A geostationary object is blue whether it is sunlit,
  eclipsed or below the horizon, because belonging to the belt is a permanent fact
  about it and not a condition it is passing through.
- **Value says what state it is *in*.** Full brightness is sunlit — what the eye could
  actually see. Half is eclipsed. Dim is below the horizon.

**Eclipsed used to be blue and is now a neutral grey `#808080`.** That is the point of
the change: blue had to be freed to mean exactly one thing. Below-horizon is likewise
a neutral `#4a4f54`, never blue, for the same reason.

**Amber `#ffb454` is the third hue and it is the pointer's alone.** Nothing in the sky
is amber until a person touches it, which is what makes a ring read as attention
rather than as a property of the object.

**Debris is a shard, not a light.** It emits nothing, reflects badly, tumbles, and is
the reason a spacecraft has to move — so it is drawn as a **slowly turning triangle**,
flat, with no glow, each fragment at its own rate and phase from a hash of its index.
A rocket body stays a round mark, smaller and without the flare.

Shape rather than brightness, because **brightness was already spoken for**. This was
measured, not guessed: an isolated debris object against an isolated payload, both
sunlit and at comparable range, rendered at **0.67× peak and 0.63× area**. Real, but
range varies a point's size four-fold and shadow varies its brightness three-fold, so
a mark differing only in *amount* cannot be read against that noise. A different
*kind* of mark survives it. A fourth and fifth hue would have broken the two-axis rule
instead.

It is free. The triangle is a signed distance field inside the same point sprite — no
extra geometry, no extra draw call, no vertex work, only fragments inside debris
sprites. Measured on a **software rasteriser**, which exaggerates fragment cost
enormously: every object a light gave p50 28.1 and 28.6 ms, every object a shard gave
27.8 and 28.5 ms. Indistinguishable. A real tetrahedron would need instanced meshes
and at four to sixteen pixels would look exactly like this anyway.

The tumble reads `uTime` in **wall seconds — the one quantity in the app deliberately
not taken from the clock.** It is a property of the mark, not of the orbit: at 1800× a
scene-time tumble would strobe, and there is no rotation rate in the elements to be
faithful to.

The `kind` byte this reads has been in the catalogue since Step 1 and went unused
until now. It is a **heuristic on the name** (`kindFromName`): GP data carries no
object type at all, SATCAT does but joining it is a second dataset for one byte, and
an unnamed fragment therefore reads as a payload. Good enough to read density
composition, which is what the image needs; not a classification. `full` is the default precisely so this is
visible; `?catalog=active` is payloads only and shows almost none of it.

A fragment can be **both** — there is debris in the geosynchronous belt — and it draws as
a blue shard. The two axes compose rather than compete, which is the test of the rule.

**Vocabulary:** *choir* is the internal name — code, config, this file — and is meant
to carry through to Step 4, where the belt is a drone under the passes. On screen the
word is **geostationary**, which is what a reader knows. (Strictly the membership test
is geo*synchronous* and takes in inclined and drifting belt objects too; the screen
uses the common word on purpose.)

**There is no legend any more.** It became the **shape in each group's heading** —
a disc for `PASSING`, a triangle for `DEBRIS`, a disc for `GEOSTATIONARY` — the mark's
own form in the mark's own colour, sitting beside the name of the thing it explains
instead of in a list underneath everything. They are **CSS boxes, not characters**:
`●` and `▲` land wherever their font puts them inside the em box, so no alignment
centres them against the capitals beside them and half the disc sits under the text
line. Drawn, the element *is* the ink and centring it centres the mark — which is also
what the sky does, drawing a round sprite and a triangle by hand rather than asking a
font for either. *Below horizon* and *eclipsed* are named nowhere: one is barely in the image
and the other is a state, not a group.

### Rendering: two ticks per object, blended on the GPU

three.js, `src/scene.ts`. Every object is drawn from **two ticks at once** and blended in
the vertex shader by one uniform, `uT`. The CPU work per rendered frame is setting that
uniform; a tick arriving uploads into whichever of the two GPU slots is stale.

- **Blend unit direction vectors and renormalise.** This is why there is no azimuth
  wrap-around problem — lerping 359° → 1° goes the long way round, but a vector has no
  seam. Do not reintroduce alt/az interpolation.
- **Appearance is decided from blended values in the shader** — above or below the
  horizon, lit or eclipsed, size by range — so an object changes colour exactly where it
  crosses the horizon on screen. Step 3's visual work belongs there.
- `src/sky-frame.ts` is **the one place** alt/az maps to scene space: +Y up, +X East,
  −Z North, so the camera's default forward looks North. The worker and the graticule
  both use it.
- **`SKY.lowestVisibleDeg` is 2: the sky ends there.** Below it an object is not drawn,
  not listed, not in the belt's grid, and a mark on it is let go — one floor, so the
  panel can never name something the sky is not showing. Settled 2026-09-16; it used to
  be −90, with the whole sphere drawn and the far side faintly present through the
  ground. That produced a **discontinuity nobody designed**: the haze is opaque at 0°,
  so an object at +1° is ~97% hazed away, but below 0° there is no haze at all and the
  ground disc leaves an object at −1° at 28% of its brightness. Objects faded out as they
  sank and then *brightened again* the moment they crossed, which reads as the floor
  leaking rather than as a choice. Two degrees rather than zero because a point sprite is
  16 px wide, and cutting at exactly 0° leaves half a sprite straddling the horizon line.
  The cost, stated plainly: objects on the far side of the Earth are now **gone**, not
  dimmed, and the ground's transparency no longer carries the meaning its comment once
  claimed for the title.
- **Haze** (`SKY.haze`): a sky-coloured band from the horizon to `topDeg`, opacity computed
  per pixel from elevation, so objects come into view gradually as they climb. It is
  colour-managed like the clear colour, so full haze is exactly empty sky, not a darker
  band. Not everything being visible is deliberate.
- **Highlight rings** (`HIGHLIGHT`): a white ring around each object the readout lists —
  the rows its groups are showing, and for now the default voices for Step 4 — and an
  amber one around whatever the pointer is touching or has kept. The rings
  are a second, *indexed* draw of the points' own GPU buffers running the same
  `BLEND_GLSL`, so a ring cannot drift from its object at any time rate; the only CPU work
  is swapping a handful of indices when membership changes. Hover is **one uniform**
  compared against a static per-object index, so sweeping the pointer across the sky
  uploads nothing; a mark is a per-object attribute, re-uploaded only on a click. A
  marked ring's brightness is computed **in the shader** from the blended elevation, so
  it dims as the object descends in exact step with what is drawn — and its row dims by
  the same curve.
- **Tracks** (`TRAIL`): where a kept object has been and is going, 35 minutes either
  way. Every track shares one draw, and each is **cut exactly at the horizon** — the
  crossing segment is clipped at y = 0 rather than dropped, so the end of a track never
  depends on where the 20-second samples happened to fall — and dissolved over the last
  `fadeTopDeg` above it, so an orbit leaves the image instead of ploughing through the
  ground. The fade is baked into the vertex colours, not alpha: sky and ground are both
  within a shade of black, so darkening and dissolving look identical, and one material
  then draws every track at once. They are `LineSegments2`, three's instanced-quad fat
  lines, because GL's own `linewidth` is one pixel whatever you ask for on ANGLE —
  `TRAIL.widthPx` and `TRAIL.opacity` are therefore real controls. `src/trails.ts` caps
  requests in flight and only recomputes a track once scene time has drifted
  `refreshSeconds`: a track is a few hundred JS propagations on the same worker thread
  the frame ticks come from, and frames matter more. At 1800× the tracks lag, which is
  right — at that rate a 70-minute track crosses the sky in two seconds.
- **Render order is a design decision**, set in `RENDER_ORDER`: points, tracks and rings
  under the haze so they emerge together; graticule and compass labels above it so the
  dome stays legible to the horizon.

**Two traps, both of which look like something else entirely:**

- **`gl_PointSize` is vertex-only.** Reading it in a fragment shader is a compile
  error, three.js logs it to the console and carries on, and the result is that *the
  entire points draw vanishes* — an empty sky with the rings still on it, which reads
  as a data problem, not a shader one. Pass the size down as a varying (`vSizePx`), as
  both point and ring shaders now do.
- **Looking at the zenith kills the camera.** At pitch 90° the view direction is
  parallel to the camera's up vector, `lookAt` cannot build a basis, and the whole
  scene disappears. `render` clamps pitch to ±89° itself rather than trusting whoever
  set it — the drag handler is not the only thing that does, debug snippets included.

### The panel

Redesigned 2026-09-15. **One narrow column** (`READOUT.widthPx`, 272 px), pinned left,
full height: title and time at the top, the lists under them, a spacer that eats the
slack, and the belt's grid **aligned to the floor** of the frame at any window size.
The piece often lives in a small canvas, so the panel had to stop being a table.

`src/ui.ts` owns the column; `src/ui-group.ts` and `src/ui-choir.ts` are components
that do not know where they are. **Moving the whole panel to a strip along the bottom
is a change to one CSS block, not a rewrite** — the layout choice is not locked in.

**Three groups, because the sky holds three kinds of thing that do not compare:**
what is passing, what is wreckage, and the belt. `GROUP_LOOK` gives each one a glyph and
**two** colours, and the two mean different things:

- **`tone` is the colour the object already is on the sky**, and it is what a row *rests*
  at — warm white `#fff2d6` for passing, the shard's own light brown `#80796b`
  (`PALETTE.lit` at the debris intensity), blue for the belt. A name in the list and a
  mark overhead are therefore the same colour before anything is touched. Resting rows at
  a neutral "info text" grey was a real regression: it made the list a table of strings
  beside the sky rather than a reading of it.
- **`accent` is attention, and only attention.** It is amber for *both* lists, because
  amber is what the ring turns when you touch an object — anything outside the belt gets
  `uMarkColor`. A second highlight hue for debris would have to disagree with its own
  ring. A distinct blue for it was considered and **deferred, not rejected** — any blue
  has to survive sitting beside the belt's, and nothing needs it yet.

The glyph is the third piece: shape and hue together, which is the whole grammar in one
character.

**A row is a name until you keep it.** Default rows sort themselves by elevation and
show nothing else; they churn, and that is what they are for. Keeping one **opens** it:
data on a second line, a box in the group's colour, and it **stops moving** — kept rows
sit above the defaults in the order they were kept, and a new one appends to the bottom
of that zone so nothing already on screen shifts. Whatever you are watching holds the
position you found it in, which is what will make it addressable later by a control or
a voice.

**Hovering opens a row — but only from the sky.** An open row is two lines tall, so
opening one while the pointer is *inside the list* pushes every row below it down,
including the one under the cursor, which slides away and marks the wrong object when
clicked (found by driving it: three clicks, three wrong objects). Pointing at the **sky**
cannot do that, because the pointer is nowhere near the rows. So each group tracks
whether the pointer is in its own list: the sky names what you point at, the list only
tints. Turning it off wholesale was the first fix and it was wrong — it made two thirds
of the sky feel dead, since the lists show ten objects out of a thousand.

**The ring follows the pointer, not the row.** Whatever the pointer is on gets a ring,
whether or not it has a row, whatever group it belongs to. This is its own line in
`ui.ts` rather than a clause inside the per-group loops, because hanging it off the rows
is exactly the bug that shipped on 2026-09-15: splitting the readout into groups quietly
scoped the ring to *listed* objects, and since the lists hold ten of a thousand, hovering
anything else silently did nothing at all.

**The belt gets a grid, not a list.** One square per geostationary object above the
floor, **in azimuth order, read left to right and wrapped** like text: the first square
is one end of the arc, the last is the other, and neighbours in the grid are neighbours
on the belt. An arbitrary order would have cost the same and meant nothing. The set
barely changes (these objects never set), so the grid is rebuilt only when membership
actually differs.

It filled *column by column* at first, which made horizontal position in the grid equal
horizontal position in the sky — a stronger mapping, but it left the remainder as a
ragged part-column down the right-hand edge. Wrapping by rows puts the remainder on the
bottom row, where a half-finished line is what every reader already expects. Adjacency
survives the trade; only the global x = azimuth reading is given up.

**No text in the grid.** One box above it fills while the pointer is on a square and is
otherwise blank — five hundred objects cost five hundred squares and not one label,
which is the *No tags on the sky* rule applied to the panel. Clicking a square keeps the
object exactly as clicking it in the sky does; the grid is meant to become the belt's
keyboard when the sound arrives.

**How to work it lives top right** (`.hints`), clear of the column and of the debug
panel at the bottom, and never takes the pointer, so the sky behind it stays draggable.

**A soft scrim sits under the column** (`.scrim`, `--scrim-alpha`). The panel is over the
sky and the sky is full of moving lights: chase a satellite across the left of the frame
and the names stop being readable. It is full height and hugs the left edge, so its only
edge inside the image is the right one, and that is **feathered over `--scrim-fade`**
rather than cut — a panel with a line around it would be a window, and this is not a
window. It costs a permanently darker strip of sky, which is the trade.

**The wording is deliberately thin.** A group heading is a glyph, a word and a count. "showing
N", "N kept", "never rise, never set" are gone — they were the panel explaining itself,
which is what a panel does when it has not decided what it is.

### The pointer

`src/selection.ts` holds what the pointer is touching and what it has stuck to; the
scene and the readout both read it, so the two can never disagree. Nothing else knows
about the mouse.

- **Picking reads the blend, not the tick.** `src/picking.ts` mixes and renormalises the
  two frames exactly as `BLEND_GLSL` does, then projects. Picking the raw tick would
  miss by degrees at 1800×, where a tick spans 90 s. It runs **once per rendered frame**
  at most, however many `pointermove`s arrive, and costs one projection per object above
  the horizon — the ~6–9% that are up. Everything else falls out on a sign test.
- **Only what is above the horizon can be taken.** Below-horizon objects are drawn but
  are on the other side of the world; a mark on one could never enter the readout.
- **Click, drag and hover are one gesture.** The canvas fills the window, so every click
  begins as a potential drag. A press that travels under `DRAG_SLOP` (6 px) is a click;
  anything further was someone turning to look and must not mark what it lands on.
- **A click sticks; clicking again lets go.** A kept object holds its row however far it
  falls, and the readout stays sorted by elevation, so it slides down the list rather
  than sitting apart from it. **It is let go below `HIGHLIGHT.releaseBelowDeg`** (2°),
  not at the horizon: the haze is opaque down there, so an object creeping through its
  last degree is already gone from the image while its row sits on. Two degrees also
  settles the geostationary case — a satellite parked at +0.4° in the south *never*
  sets, and at a 0° threshold would hold its row for the life of the page.
- The sky can hold more rings than the column holds rows, and the whole belt is
  reachable from its grid, so a ring does not imply a row.
- `READOUT.hoverOpensRow` decides whether pointing at an object no row is showing gives
  it one. **On, and only while the pointer is out in the sky** — see *The panel*.
- **Anything the pointer is on is ringed**, row or no row, group or no group. A ring
  must never be conditional on a row: the lists show ten objects out of a thousand.
- **Every kept object gets a track** (`TRAIL.allMarked`), falling back to a single one
  through whatever is highest when nothing is kept. See *Tracks* below.

### The tick stream

`src/sky-stream.ts` is the render thread's side of the worker. It requests frames **ahead
of scene time**, keeping two ticks of lead with at most three requests in flight, and
hands the scene the pair bracketing "now".

- **Tick rate adapts to the time rate:** `CLOCK.propagationHz` (5) at 1×, raised so that no
  two ticks are more than `CLOCK.maxStepSeconds` (10 s of scene time) apart, capped at
  `CLOCK.maxPropagationHz` (20). At 1800× a tick still spans 90 s, and blends cut the
  corner of long arcs — at that speed it reads as motion blur.
- **Discontinuities flush the buffer.** Scrubbing, NOW and rate changes bump
  `Clock.generation`; the stream drops its frames and refills from the new time, keeping
  the last frame on screen meanwhile. Late answers from an old generation are discarded.
- **Frame buffers are transferred, not copied**, and handed back to the worker for reuse.

Measured in a real browser at 60 Hz with `?debug`: frame p50 and p95 **17.0 ms, 0 of 180
frames over 25 ms, at every time rate**; worker tick 14 ms; queue 4 ready, 0 in flight.
Before this step, `full` dropped a frame on every tick and positions stepped five times a
second.

**Judging smoothness.** `?debug` shows rolling frame percentiles, worker tick cost and
queue depth, and exposes `window.birds = { stream, scene, clock }` for the console.
Healthy is p95 near the display's refresh interval and a queue of 2–4 ready, 0–1 in
flight; "1 ready, 3 in flight" stuck in place means the stream is starving. **Measure in a
real browser.** Embedded or unfocused browser panes can throttle WebGL presentation to
about one frame a second, which looks exactly like a pipeline stall — a bare WebGL
`clear()` loop in the same tab is the control.

### Time

`src/clock.ts` is the single authority for scene time. Everything — propagation requests,
trails, sun position — reads from it. Mixing in a bare `new Date()` anywhere else is how a
scrubbed timeline silently desynchronises from what is drawn. `Clock.generation` counts
discontinuities; anything that buffers ahead in scene time must flush when it changes.

## Deployment

Pages **Source must be "GitHub Actions"**, not "Deploy from a branch". Serving from a
branch publishes the repo as-is, so `index.html` asks the browser for `/src/main.ts` —
a TypeScript file no browser can execute. The symptom is a blank page that works
perfectly in `npm run dev`. `.github/workflows/deploy.yml` builds and publishes `dist/`.

`base` in `vite.config.ts` is `'./'` — relative, so one build works both at a domain root
and under `/birds-within/`. With `base: '/'` the built page requests `/assets/…`, which
404s on a project page: the same blank screen. **Do not change it back to `'/'`.** The
worker and its WASM chunk are resolved relative to it too.

### The catalogue is built at deploy time, never committed

`deploy.yml` runs on push, on demand, and every 6 hours. Each run restores the newest raw
JSON from the Actions cache, runs `fetch-catalog.mjs`, **saves the cache immediately**,
then packs, runs `check-catalog.mjs` and `validate`, and builds. Packed snapshots delta
poorly; committed four times a day they would add on the order of 1–2 GB of history a
year that every clone downloads. `active.bin`, `full.bin` and `.catalog-cache/` are
gitignored.

- `check-catalog.mjs` is the gate: minimum counts, element age under 7 days, SGP4 init
  error rate, and an **exact round trip of every object** against the raw JSON. A failure
  leaves the previous deployment live. A stale sky beats a wrong one.
- `cancel-in-progress` is false: a cancelled run can discard a download CelesTrak will not
  serve again for two hours.
- **GitHub disables scheduled workflows in public repos after 60 days without repository
  activity.** The old TLE workflow committed data, which reset that timer as a side effect;
  nothing does now. The last step of each scheduled run re-enables the workflow through
  the API. That is common practice but **unproven here until day 60** — if the published
  elements ever go stale, check the Actions tab before anything else.

### The subdomain

The site lives at **birds.protonumerique.net**, a DNS `CNAME` to
`protonumerique.github.io`, served over HTTPS with **Enforce HTTPS** on, so both
`http://` and `protonumerique.github.io/birds-within/` 301 to the canonical origin.

With Pages built by Actions the custom domain lives in **repo Settings**, and the
artifact's `CNAME` file is not strictly required. Keep `public/CNAME` populated anyway
so the repo and Settings cannot disagree — `dist/CNAME` falls out of Vite copying
`public/`. The one state to avoid is the **zero-byte** file this repo carried for a
while: neither absent (Settings wins) nor present (they agree), and invisible in a diff.

**If HTTPS is broken, the fix is almost certainly Settings, not DNS or that file.** The
certificate went unissued here for days. Everything people normally suspect was checked
and was fine: the `CNAME` record pointed at `protonumerique.github.io`; CAA resolved
through it to GitHub's own set, which permits `letsencrypt.org`; the
`_github-pages-challenge-Protonumerique` TXT was present; and no other repo claimed the
domain. Populating `public/CNAME` and redeploying changed nothing, because a deploy does
not retrigger certificate issuance.

What worked: **Settings → Pages → Custom domain → Remove, wait a minute, re-enter it,
Save.** That refiles the DNS check and the certificate request, and the Let's Encrypt
cert appeared within the hour. There is no other retry control. Two cautions learned the
hard way — a 500 on that settings page means the backend is mid-reconcile, so wait rather
than clicking again; and after ticking **Enforce HTTPS** the redirect takes a few minutes
to reach GitHub's edge, so an immediate `curl` showing plain `http://` is not a failure.

DNS is at manitu (`dns01/dns02.manitu.net`). The zone's default TTL is **86400**, from
the SOA, which is what a blank TTL field inherits; the `birds` record now sets **300**
explicitly. That matters only when a record *changes* — a long TTL means every correction
takes up to a day to become visible, which is what made this painful to iterate on.
Nothing is wrong with a cached 86400 answer while the record is correct.

## Correctness

The coordinate and time chain is the easiest thing to get subtly and invisibly wrong.
It is validated against an independent implementation, and that validation is
repeatable:

```bash
python3 scripts/reference.py > scripts/reference.json   # sgp4 (Vallado C++) + skyfield
npm run validate                                        # satellite.js vs that
```

`validate` checks **four roads to a position**: `twoline2satrec` on the frozen TLE text;
`json2satrec` on the same elements as an OMM record; that record through
`catalog-format.ts` encode → decode first, which is what the browser receives; and those
packed satrecs through the **WASM `BulkPropagator` configured exactly as the worker
configures it**, which is what is drawn. Before propagating, it also requires the OMM
roads to reach SGP4 with the same satrec fields as the TLE road, and the WASM road checks
Doppler range rate against a central difference. All four agree with the reference
identically, 25 cases across 5 objects and 5 instants:

| quantity | worst deviation |
|---|---|
| ECI position | 9.8e-5 km (≈10 cm) |
| azimuth | 1.5e-3 ° |
| elevation | 4.9e-4 ° |
| range | 2.7e-2 km |
| sub-satellite lat/lon | < 4.1e-4 ° |
| range rate (WASM Doppler vs central difference) | 2.1e-4 km/s |

Small non-zero topocentric differences are expected and correct: satellite.js rotates
TEME → ECEF by GMST alone, Skyfield applies the full TEME → ITRF transform including
polar motion. **Re-run `npm run validate` after touching `src/sky.worker.ts`,
`src/sky-frame.ts` or `src/catalog-format.ts`**, and keep its calculator list in step with
the worker's. CI runs it on every deploy.

Both sides read **`scripts/fixtures/validation.tle`**, a frozen file, and never the
published catalogue. This is not tidiness. The check originally read the TLE snapshot a
cron job rewrote every six hours. The first time it did, `reference.json` began comparing
the same objects propagated from *different element sets*, and `npm run validate` reported
~11,000 km of ECI "deviation" that was not a bug in anything. A validation fixture a cron
job can edit is not a fixture. If you ever change that file, regenerate `reference.json`
in the same commit. It stays TLE text on purpose: the OMM roads are derived from it inside
`validate.mjs`, so one frozen source covers all four.

Regenerating needs `pip install sgp4 skyfield`. Comparing does not — `npm run validate`
is pure Node, so the check runs anywhere even when Python is unavailable.

One trap worth knowing even though nothing falls into it now: `eciToEcf` is a pure
rotation and does **not** subtract the frame's angular velocity, so dotting that "ECF
velocity" against the line of sight gives a range rate wrong by the observer's own motion
— hundreds of m/s at this latitude, a large fraction of the Doppler signal.
`DopplerFactorCalculator` applies the rotation correction correctly (see the table above).
Anything that computes range rate by hand must not repeat the naive version.

## Roadmap

- [x] **Step 0 — spike.** Vendored snapshot, JS propagation decoupled from the render
      loop, abstract dome, one trail, clock with scrub, sunlit/eclipsed distinction.
      Validated against Python.
- [x] **Step 1 — data pipeline.** CelesTrak OMM JSON, fetched at deploy time, packed into
      a columnar binary, gated by an exact round-trip check, never committed. `active`
      and `full` behind `?catalog=`, committed `synthetic` as the offline fallback.
- [x] **Step 2 — scale.** WASM `BulkPropagator` in a Web Worker; every object blended
      between two ticks on the GPU; ticks run ahead of scene time at an adaptive rate;
      Doppler range rate verified; the readout culled to what is above the horizon. Smooth
      at every time rate in a real browser — p95 17.0 ms, 0 of 180 frames over 25 ms.
      ← *you are here*
- [ ] **Step 3 — aesthetics.** The actual work. Visual grammar, shader design, what a
      satellite *is* on screen, how trails read, how density reads, whether the far side
      of the Earth is drawn at all. Appearance already lives in the vertex shader, fed
      blended direction, shadow and range; the `kind` byte is in the catalogue for it.
- [ ] **Step 4 — sound.** Web Audio over the `SkyFrame` columns: pitch ← range rate,
      amplitude ← elevation, pan ← azimuth, events on AOS/LOS. A global view sonifies into
      mush; one observer's sky does not.

## Conventions

- Observer location lives in `src/config.ts` and **must** match `OBS_*` in
  `scripts/reference.py`, or the validation compares different things.
- Angles are radians internally; degrees only at the UI boundary.
- Distances in kilometres throughout.
- **Only the worker propagates** — frames and trails alike. If the render thread ever
  needs orbital information, add a message to `sky-frame.ts`'s protocol rather than
  importing satellite.js there.
- `SkyFrame` columns are indexed like `stream.names`. Objects SGP4 rejects at init are
  dropped before indexing. `range` is `NO_POSITION` (−1) where SGP4 fails at that instant,
  and every reader — shader included — must check it.
- `public/data/active.bin` and `full.bin` are **built, never committed**. Locally
  `npm run fetch:catalog` makes them. It will not re-request anything fetched in the last
  2 hours, so running it repeatedly is safe — do not work around that.
- `public/data/synthetic.bin` **is** committed. `npm run make:synthetic` regenerates it:
  deterministic, drag-free so it never decays, and **not real objects**. It exists so a
  fresh clone runs offline; nothing may be concluded from it.
- The readout lists only the highest few of each group above the horizon, refreshed at
  4 Hz. At catalogue scale there is no listing the whole thing, and rebuilding rows every
  frame is wasted DOM work. Passing, debris and the belt are three separate groups — see
  *The panel* — so anything reading "what is overhead" must say which of the three it
  means.

## Licence

Code is **AGPL-3.0-or-later** (AGPL, not GPL: this is a web app, and plain GPL's
obligations do not trigger on hosting). The `LICENSE` file is added through GitHub's
license-template picker so the text is canonical.

The element sets the site publishes are not covered by it — their origin and CelesTrak's
terms are documented in `public/data/SOURCES.md`. Keep the fetch-and-cache arrangement
intact in any fork; pointing browsers straight at CelesTrak earns 403s and an IP block.

## Commands

```bash
npm install
npm run dev              # localhost:5173 - the synthetic sky until you fetch; add ?debug
npm run fetch:catalog    # CelesTrak -> .catalog-cache/ -> public/data/{active,full}.bin
npm run check:catalog    # sanity + exact round trip of the packed catalogues
npm run validate         # four roads to a position, against the Python reference
npm run bench            # WASM vs JS at catalogue scale
npm run build            # typecheck + production build
npm run make:synthetic   # regenerate the committed offline fallback
```
