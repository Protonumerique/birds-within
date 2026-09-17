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

**A desaturated pink `#e2aac4` is the fourth, and it is attention *on wreckage*.** Added
2026-09-17. The two attention hues are the one place the axes are allowed to cross: which
one you get says what kind of thing you touched. Pink rather than the green also on the
table, and the deciding argument is that it must not shout — the eye's sensitivity peaks
in the green, so a green of the same magnitude reads markedly brighter against a sky this
dark. It is also the furthest thing here from the belt's blue, and unlike another warm
white it cannot be mistaken for a sunlit payload at sixteen pixels.

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
not taken from the clock.** It is a property of the mark, not of the orbit: at 100× a
scene-time tumble would race, and there is no rotation rate in the elements to be
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
  the rows its groups are showing — and an **attention** ring around whatever the pointer
  is touching or has kept: amber for a satellite, pink for wreckage, blue for the belt.
  Merely being listed stays white for every kind, so the readout's own ring goes on
  meaning "this one has a row" rather than doubling as a category. Tracks follow the same
  rule, so a kept orbit says what drew it before you read the name at the end of it. The rings
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
  the frame ticks come from, and frames matter more. At 100× the tracks lag a little,
  which is right — at that rate a 70-minute track crosses the sky in forty seconds.
- **Wreckage tearing the picture** (`GLITCH_FRAG`, `INTERFERENCE.sight`): a square of
  the finished canvas around each *kept* shard is copied back and redrawn torn - rows
  of pixels slide sideways, and inside a torn row the brightest sample wins, which
  drags bright things out into streaks. That last part is pixel sorting done cheaply,
  and it is what keeps it from reading as a plain offset. Quantised on
  `floor(uTime * stepsPerSecond)` at 12 Hz, because breaking up is discrete: a mark
  that slides between places reads as a wobble.
  - **Band thickness and axis are per fragment**, hashed off its catalogue index like
    the debris tumble, so a given piece of wreckage always tears the same way. With
    everything horizontal and the same pitch, several active shards agreed with each
    other and added far too much sideways motion to the frame; about two in five now
    tear in columns instead, which breaks that up for the cost of swapping two axes in
    the shader.
  - **It replaced a vertex-shader warp, and the difference is the whole point.** That
    version displaced the marks themselves, on the same angular falloff the sound uses.
    Two things were wrong with it. 45° is a third of the sky, so it read as everything
    in view being shaken rather than as something local; and moving the objects reads as
    *physics*, as if the wreckage were shoving satellites about, when what is meant is
    that the image of them is corrupted. A screen artefact belongs in screen space,
    after the scene is drawn. So the reach here is a radius in pixels while the sound's
    stays an angle - the two senses disagree about reach on purpose, and share a cause.
  - **It reads back the canvas** (three's `FramebufferTexture` pattern) rather than
    rendering the scene to a target, which avoided two traps and most of the cost:
    - **A render target receives LINEAR values.** three picks the output encoding from
      `renderer.outputColorSpace` only when drawing to the canvas; for an ordinary
      render target it writes linear whatever the texture's own `colorSpace` says, so
      setting that field looks right and does nothing. Worse, linear **cannot be stored
      in 8 bits for a sky this dark**: `#05070a` is about 0.0015–0.003 linear, which
      quantises to 0 or 1 out of 255. Measured symptom: empty sky came back as
      (0, 13, 13) against its true (5, 7, 10) — red rounded to zero, green and blue both
      landed on 1/255. A half-float target fixes it. The canvas needs none of this,
      because it already holds display-ready sRGB bytes.
    - **A fullscreen pass shades every pixel on screen.** On a software rasteriser that
      cost **165 ms a frame against 24**. A real GPU would barely notice, but the shape
      of the work was wrong. Per-patch it is 25.6 ms for one shard and 28.6 for four,
      against 23.6 with none.
  - Outside the disc the frame is **pixel-identical** — the shader returns the copied
    pixel untouched, so there is no colour path to get wrong. Verified by sampling empty
    sky in both paths: (5, 7, 10) and (2, 3, 4) exactly, either way.
- **Render order is a design decision**, set in `RENDER_ORDER`: points, tracks and rings
  under the haze so they emerge together; graticule and compass labels above it so the
  dome stays legible to the horizon.

**Measuring a small visual effect is harder than building one.** Finding out whether
the glitch was doing anything took far longer than writing it, and every wrong turn was
the same mistake: comparing two screenshots and assuming the difference was the effect.
It never was. The graticule is most of the lit pixels and never moves, so whole-frame
statistics barely shift even when the marks move 120 px. `main` rewrites the glitch's
source list every frame, so a value poked in from the console is gone before the next
draw. A software rasteriser's edge dithering is a noise floor of several hundred changed
pixels. And once all that was held still, the residual turned out to be the debris
tumble, then the ambient track switching objects, then the `?debug` panel's own numbers
ticking over in the DOM.

Two things work. **Draw the quantity**: `vColor = mix(vColor, red, warp)` and count red
pixels settled in one run what three benches could not - 0 with nothing kept, 100 with
one shard. And **hold everything still deliberately**: pause the clock, stub
`showFrames`, freeze `uTime`, hide the rings, the tracks and every DOM overlay. Only
then does a bounding box mean something; the tear measures 25 x 84 px inside its 116 px
patch, which is the number worth having.

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
- **`accent` is attention, and only attention** — amber for a satellite, a desaturated
  pink `#e2aac4` for wreckage, and whatever the ring turns is what the row turns. It was
  amber for both lists until 2026-09-17, on the argument that "a second highlight hue for
  debris would have to disagree with its own ring". It does not: the ring changed with
  it. What the piece gained is that a **collision of kinds** is now visible — keep a
  fragment beside a satellite and the two marks are plainly not the same sort of thing,
  before either of them moves or makes a sound.

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

**Every pixel of the grid belongs to a cell**, and a press is taken on `pointerdown`.
Both of those are fixes, found 2026-09-17 from "it misses clicks quite often". The cells
were 8 px squares with a 1 px CSS `gap`, so **21% of the grid area was dead** — a press
landing in a gap hit the grid, `closest('.cell')` answered nothing, and the click was
silently dropped. And `click` needs press *and* release on the same element: on a target
this small a hand that moves one pixel between them resolves to their common ancestor,
the grid, and is dropped the same way. So `CHOIR_GRID.cellPx` is now the **hit box** and
the square is drawn inside it by padding and `background-clip: content-box`, with no gap
at all; and the press is `pointerdown`, which also closes the window in which a rebuild
could swap the node out mid-gesture. There is nothing to drag in the panel, so there is
nothing else a press could have meant. Measured after: 60 presses, 30 at cell centres and
30 on the pixel that used to be gap, each with a pixel of travel — 60 hits.

A consequence worth knowing: every state rule sets `background-color`, never
`background`. The shorthand resets `background-clip` to `border-box` and fills the gap
back in, so a hovered cell would silently grow by a pixel.

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
  miss by degrees at the top of the rate ladder, where a tick spans ten scene seconds. It runs **once per rendered frame**
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
  `CLOCK.maxPropagationHz` (20). The ladder tops out at 100×, which asks for 10 Hz and
  still spans 10 s a tick; blends cut the corner of the arcs, and it reads as motion blur.

**The ladder stops at 100×, since 2026-09-16.** It ran to 1800×, where a pass crossed the
sky in two seconds — a curiosity rather than an image, and nothing a slower rate does not
show better. 100× is a pass in under a minute. It also settles the sound, which is ducked
above 1× and at 1800 would be a siren.
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

### Sound

Step 4, begun 2026-09-16. Two things play: the belt's drone, always, and a voice for each
pass being kept. `src/audio.ts` owns the context and the master chain; `src/drone.ts` and
`src/performers.ts` are buses on it and neither knows about the other. The debris
interference joins them the same way, without either changing.

#### Turning it on

**Nothing exists until the button is pressed.** A browser will not let a page make a sound
without a gesture, so "the drone is audible from the start" has to mean "from the first
press" — there is no arguing with the policy. The context, the forty-odd oscillators and
all of their cost are built inside that click and not before, so a page nobody turns the
sound on for pays nothing at all. The one control is `SOUND` / `MUTE`, under the time
controls, and it wears the belt's own blue while it is on. Once the fade out is inaudible
the context is **suspended**: `setTargetAtTime` is asymptotic and never actually reaches
zero, so a muted tab would otherwise run forty oscillators for its life.

#### The drone: the belt

**The bed is a bus, not a voice per object.** Five hundred oscillators is not a
performance problem so much as an acoustic one: five hundred detuned sines are white
noise, not a drone. The belt is instead sorted by azimuth — the same order the grid is
built in — and cut into as many slices of **equal population** as there are pitches in
`AUDIO.drone.ratios`, nine. Each slice is one bass voice: two sines a few cents apart with
a triangle an octave up for body, panned to the mean direction of its members, breathing
at its own slow rate. The drone *is* the arc, flattened into the stereo field, and the
object that lights a square in the grid is inside the voice that square sits over. Equal
population rather than equal angle, because the belt is not evenly filled and a slice of
empty sky would be a voice silent for no audible reason.

The pitches are a just pentatonic over an octave and a half from C1, ascending with
azimuth, so adjacent slices are adjacent in the sky *and* in pitch and sweeping the arc
rises. Nine bass voices a whole tone apart would be mud; a pentatonic is not.

**Pan is head-relative.** The stereo axis is the camera's right vector, so turning to look
sweeps the belt across the field — absolute pan would have been static, since these
objects never move. With up = +Y and the view built from yaw and pitch, the cross product
loses the pitch term entirely: right is `(cos yaw, 0, sin yaw)` whatever the camera is
looking at, and its dot with an object's direction also does the right thing overhead,
where there is no left or right and the dot goes to zero. It is the same direction vector
`SkyFrame` already carries, which is what makes HRTF a later swap of one node rather than
a rewrite of the mapping.

**Keeping an object pulls a voice out of the bed.** A kept belt object gets a sawtooth an
octave above *its own slice's* pitch, through a resonant lowpass that opens as it arrives,
detuned by where it sits inside that slice — so two neighbours kept together beat against
each other. It is in tune with the bed because it is the bed's pitch: the voice steps
forward rather than arriving from somewhere else. Twelve at once is the cap; past that a
click still marks, it just does not sound.

**How loud a voice is depends on how many voices there are** (`soloRamp`, 2026-09-17).
One on its own was overpowering: it arrived at full strength over a bed deliberately
tuned to sit back, so a single click jumped out of the image. The belt is a choir, and
one singer stepping forward at full voice is the wrong shape for it. So the first voice
enters at a fifth of its level and every voice — including that first one — rises toward
full as more are kept, reaching it at ten.

**It only ever attenuates.** At ten voices the sum is exactly what ten cost before, and
below that, less; keeping one is 14 dB quieter than it was. The level is therefore set in
`tendSolos` on every update rather than once at birth, so *taking a voice away brings the
rest down with it* as surely as adding one brought them up. The grid stops being a set of
switches and becomes something that rewards playing it.

Measured by rendering the same `Drone` into an `OfflineAudioContext`, 500 belt objects,
RMS over the settled tail:

| kept | share of `soloGain` | RMS | peak |
|---|---|---|---|
| none | — | −28.4 dBFS | 0.18 |
| one | 0.20 | −28.2 | 0.18 |
| two | 0.37 | −27.8 | 0.18 |
| four | 0.57 | −25.2 | 0.27 |
| seven | 0.80 | −22.7 | 0.33 |
| ten | 1.00 | −20.5 | 0.43 |
| twelve | 1.00 | −18.9 | 0.54 |

Mild and permanent at the bottom — one voice is now barely above the bed — invasive at
the top, monotonic, and nowhere near clipping before the master compressor even acts.
That compressor is there rather than a lower voice cap because the brief asks for it to
be *able* to get invasive.

**Measure it at both belt sizes.** `synthetic` carries 240 objects, so its slices sit at
half occupancy and its bed is 4 dB quieter than `full`, where every slice saturates — the
first tuning was done against the quiet one and shipped a drone louder than intended on
the real sky. Every figure above is the 500-object case, which is what a listener
actually hears; at 90 they all fall by about 4 dB.

`bedGain` and `soloGain` came down from 0.085 and 0.17 on 2026-09-16, on listening: the
opening was too present and the kept voices sat higher than they needed to. The bed fell
further than the voices, because a voice sits an octave up with a resonant edge and
arrives clearly from well under the bed — cutting both equally would have made keeping an
object *relatively* louder than it had been.

#### The performers: passes, and only the ones kept

Added 2026-09-16, `src/performers.ts`, a sibling of `Drone` on the same bus.

**Nothing sounds until it is kept.** A thousand objects are above the horizon at any
moment; sonifying what is merely *there* is the mush this piece exists to avoid. The
click is the instrument. A voice arrives over `attackSeconds`, leaves over
`releaseSeconds`, and is let go the moment its object sets or loses its position — the
same release the ring and the row already obey.

**Synthesised, and synthesised first.** The name comes from what radio amateurs call
satellites, and the 2010 original looped birdsong over a stereo field. A recorded bird
sounds good on its own, so it would sound fine badly panned and badly gated, and a wrong
mapping would survive for months behind it. A swept sine is unforgiving, which is the
useful property right now. Samples are a later decision — and 831 KB is the whole
catalogue, so they are not a cheap one.

**Three textures, from the one byte the catalogue actually has.** `kind` is a name
heuristic and nothing more, but it separates the three things that are up there:

- **bird** (payload) — phrases of two to five swept chirps, then a long gap. A sine.
- **machine** (rocket body) — a spent stage is not a bird. Lower, a sawtooth, and
  **regular** where the bird is not. The industrial chant under the birdsong.
- **shard** (debris) — a band of noise that is simply *there*: no phrase, no gap, nothing
  scheduled. See *The shard, and the interference* below.

**A given object always sings the same song.** Pitch, sweep direction, phrase length and
gap all come from a hash of its index — the same `sin`-and-fract trick the point shader
uses for the debris tumble. Keeping the same satellite twice sounds the same, and several
kept at once drift apart instead of locking into one pulse, because their gaps differ.
Pitches are quantised to a pentatonic over three octaves, so a handful kept together is a
chord rather than a cluster.

**Four mappings, and three of them are already the visual grammar:**

| | from | measured across a pass |
|---|---|---|
| pitch | range rate, exaggerated | +650 → 0 → −650 cents |
| level | elevation, on `HIGHLIGHT`'s own curve | 0.11 at 3° → 0.33 at 62° → 0.11 |
| pan | direction · camera right | −0.85 (east) → 0 (south) → +0.85 (west) |
| timbre | shadow | 5.4 kHz sunlit → 700 Hz in umbra |

The level curve is `HIGHLIGHT.dimAtHorizon` and `fullBrightDeg` — literally the same
numbers that dim the ring — so a voice swells and fades in exact step with the mark on
screen. Shadow is the one column nothing else in the audio path reads, and the ear takes
it better as colour than the eye takes it as brightness.

**The shard, and the interference.** The first version fired short noise bursts, and that
was exactly wrong: a repeating transient is the most attention-getting thing a mix can
hold, and debris is not asking for attention — it is contamination. It read as
interrupted and repetitive, which is what a rhythm is.

A shard is now **continuous and eventless**. Noise through a wide bandpass whose centre
drifts on one slow LFO — the swish — while a second breathes its amplitude. Brighter than
the drone, quieter than a bird, and with nothing in it to count. One is radio hiss at the
edge of the image; several sum into a wash rather than a pattern. Measured alone it is
−40.9 dBFS with a peak of 0.07, against the burst version's −39.7 and **0.21**: the
energy barely moved, but the transients are a third of what they were, and that is the
whole of the difference.

**And it deforms what it passes**, in both senses at once. All of it lives in
`INTERFERENCE`, which is deliberately *not* inside `AUDIO`: the sound and the image are
two readings of one geometry, and the constants that decide them have to be the same
constants or they would drift apart.

**"Close" is an angle, not a pixel count.** Depth is the dot product of the two objects'
unit direction vectors — the cosine of their true separation in the observer's sky — on a
smoothstep from `farDeg` (45°) in to `nearDeg` (12°). That *is* the simple version: at a
fixed field of view, angular separation and pixel distance are the same ordering. The
difference is zoom, and a pixel threshold would have meant zooming out set the whole sky
interfering and zooming in cured it — which reads as a bug rather than as a sky. The
*displacement* is in screen pixels, which is where a glitch belongs; only the trigger is
angular. No trigonometry anywhere: it is one dot product per object per source.

| separation | pitch | displacement |
|---|---|---|
| 45° | 0 cents | 0 px |
| 40° | 39 | 1.1 |
| 30° | 201 | 5.7 |
| 21° | 297 | 8.4 |
| 12° and closer | 320 | 9.0 |

**In the ear:** one wobble per voice at 4–9 Hz driving three destinations at once — the
oscillator's detune, its amplitude, and its lowpass cutoff. Any one alone reads as
vibrato, tremolo or a sweep; together they read as damage. At full depth that is 320
cents, over a tone and a half of bend.

**In the eye:** a small disc of the picture around each kept shard tears and smears —
see *Wreckage tearing the picture* under **Rendering**. Its reach is a screen radius
rather than an angle, deliberately: the sound is about the sky and this is about the
display.

The first version of this was too quiet to notice, for a reason worth keeping: `farDeg`
was 25° and `nearDeg` 4°, and a near miss that close simply does not happen often. Two
kept birds that read **0 cents** of bend for a whole session read **303 and 225** at 45°.
Reach was the problem, not depth.

**Only *kept* shards interfere.** Reading every fragment in the sky against every voice
is affordable but not legible: things would bend for reasons a listener cannot see.
Counting the kept ones makes the wreckage something you can aim — keep a fragment beside
a bird you are listening to and hear it, and see it, corrupt that bird. Widening it to
the whole catalogue is still open, and is a one-line change to what `Performers.shards`
is filled from.

**A trap in that geometry, worth stating because it caught the test and not the code.**
Two objects at the same elevation separated by 30° of *azimuth* are not 30° apart: at 45°
elevation they are 21° apart, because `cos(sep) = sin²(el) + cos²(el)·cos(Δaz)`. A test
that labels its columns by azimuth offset will read the interference curve as starting
too early and look like an off-by-one in the thresholds.

**Everything is scheduled ahead.** Web Audio's clock is not the frame loop's, and a chirp
started from a `requestAnimationFrame` callback arrives whenever the frame did. Each
voice holds the context time of its next phrase and `update` writes every event inside
`lookaheadSeconds`; frames may stutter, the song will not.

**The envelope needs a hold, and this is worth knowing.** The first pass shaped each
chirp as one exponential from full to silence across its whole length. That envelope
spends almost all of its duration near zero: the voice measured **12 dB quieter than its
peak suggested**, and a bird came out 25 dB under the drone — inaudible, while every
individual number looked plausible. It was also simply wrong. A bird's chirp is a
sustained whistle that sweeps, not a click. Attack, hold most of the duration, then
release; how much is held is most of what separates the three textures.

Balance, rendered offline against a 500-object belt, RMS over the settled tail:

| | with the bed | alone | peak alone |
|---|---|---|---|
| bed alone | −28.5 dBFS | | 0.18 |
| one bird | −27.4 | −33.8 | 0.12 |
| one machine | −27.8 | −35.6 | 0.13 |
| one shard | −28.3 | −40.9 | 0.07 |
| eight kept, mixed | −23.1 | | 0.42 |

A bird sits 5 dB under the bed in RMS and is still plainly the foreground: it is two to
five octaves higher, where the ear is far more sensitive, so RMS across registers this
far apart does not compare. The shard is the quietest thing in the mix and has no peaks to speak of, which is what a
hiss is. `timbreGain` is **measured, not nominal** — bandpassed noise throws most of its
energy away, so what a shard needs bears no relation to what a sine needs.

**It costs nothing measurable.** With a selection of eighteen held constant — six
performers, twelve belt voices — frames ran p50 26.3 / p95 30.7 ms silent and 26.0 / 29.9
sounding, on a software rasteriser. What *does* cost is the eighteen marks themselves:
their tracks, rings and rows are about 4.6 ms. Attribute it to the right thing.

#### Both buses

**Sound runs at real time and nowhere else** (`AUDIO.maxTimeRate`). Above 1× the master
ducks and the panel says `silent above 1×`; the button's state survives, because a
look-ahead must not cost a press.

**Nothing in the audio path reads `Clock`.** The drone is driven by belt membership and
by where the camera is pointing — those objects do not move. The performers are driven by
the `SkyFrame` columns of whatever tick is on screen, and their events are scheduled on
the audio context's own clock, which is why a stuttering frame does not stutter a song.

**Doppler is exaggerated, and has to be.** A LEO object at 7.5 km/s gives a fractional
shift of 2.5e-5 — about **0.04 cents**, which is nothing. The reason radio amateurs hear
it at all is that it is 2.5e-5 of a 145 MHz carrier: a 3.6 kHz slide in the beat note.
`dopplerCentsPerKmS` scales it into the audio band, which is not a cheat but the same
operation the metaphor was built on.

**There is no purpose data in the pipeline**, so the softer-weather / bolder-telecom /
bassier-military voicing cannot be built yet: `kind` is a name heuristic and CelesTrak's
GP data carries no object type at all. CelesTrak does publish classified lists on its TLE
pages, and parsing those into an optional catalogue field is the way in when it is wanted.
Deferred on purpose, not forgotten.

**The same table would give species**, which is the more interesting half of it. A
family of satellites sharing a call — Starlink as geese, so that the megaconstellation is
audible *as* a constellation and a name in the list has a sound you already recognise —
needs nothing more than a name prefix, which every object already carries. It does not
need SATCAT and it does not need purpose. Alongside it: rougher calls than the present
whistle, on the vocabulary the metaphor already supplies — caw, honk, squawk, cackle.
Both noted 2026-09-17 and deliberately not built yet.


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
- [ ] **Step 4 — sound.** Web Audio over the `SkyFrame` columns. A global view sonifies
      into mush; one observer's sky does not. See *Sound: the drone first*.
      ← *you are here*
  - [x] **The drone.** The belt as a bass bed of nine panned slices, plus a defined
        voice for every object kept. Head-relative stereo, ducked above 1×.
  - [x] **The performers.** Passes, sounding only when kept: pitch ← exaggerated range
        rate, level ← elevation, pan ← direction, timbre ← shadow. Three textures from
        the `kind` byte — bird, machine, shard. Synthesised, deliberately first.
  - [x] **The interference.** A kept shard is a continuous band of noise; it bends the
        pitch, amplitude and colour of every voice within 45° of it, and tears a small
        disc of the picture around itself. Counts kept shards, not every fragment.
  - [ ] **Bird species.** More aggressive calls — caw, honk, squawk, cackle — as rougher
        timbres beside the present whistle, and **voices by family**: Starlink as geese,
        so the megaconstellation is audible *as* a constellation. Needs a curated
        name-prefix table, which is the same table the purpose voicing wants; see the
        note at the end of this section. The strongest remaining idea in the sound.
  - [ ] **HRTF.** `PannerNode` behind a flag, on the same direction vectors, once the
        stereo mapping is known to be right.

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
