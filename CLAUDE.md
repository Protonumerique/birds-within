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
float64, names in a UTF-8 blob, a `kind` byte (debris / rocket body / other) read from
the name — a heuristic, but enough to read density composition — and since **format
version 2** a `family` byte, which is not a heuristic: see *Families* under **Sound**. The encoder checks
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

- **The piece opens facing south** (`SKY.startFacingDeg`). North was the default only
  because `sky-frame.ts` maps −Z to north and a camera with no yaw looks down −Z — a
  fact about the coordinate system rather than a decision about the image. South is
  where the piece is: the geostationary belt is a fixed arc across the southern sky and
  the one thing in frame that holds still while everything else streams past, so opening
  away from it wasted the first look.
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
  band — and since 2026-09-18 "empty sky" is no longer one colour: it reads the same
  `SKY_RAMP_GLSL` the backdrop does, so an object fades into the airglow that is
  actually behind it. Not everything being visible is deliberate.
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
- **Ghosting** (`GHOST`): where a thing has just been, drawn only while the clock runs
  fast. At 1× an object crosses a couple of pixels in a tick and a trail is a smudge on
  the sprite; at 100× it crosses the sky in forty seconds, and the question a time ramp
  raises — how fast is this actually going — has no answer in the image at all. The
  trail answers it, and adds a density in *time* beside the density in space.
  - **Each ghost is a stroke, not a dot.** Three dots over a span this long read as
    beads on a string — which is what shipped first, and what "quite dotty" named. A
    ghost now *sweeps* its sprite along the step back to the ghost behind it, so
    consecutive strokes abut exactly and four of them join into one tapering streak.
    Filling the same span with dots close enough to touch would have taken fifteen
    draws. The sweep is one function in the fragment shader — collapse the point onto
    the segment before evaluating the shape — so a light becomes a rounded stroke and
    a shard becomes a swept shard, with no second code path. It is very nearly free:
    2.3× the ink (850 → 1,953 pixels) for 0.4 ms.
  - **Extra draws of the same points, not a screen effect**, and that is the whole
    design. A feedback buffer smears in screen space, so turning the camera would drag
    the entire sky into streaks — and the fix for that, clearing on camera motion, reads
    as a flicker exactly when someone is looking around. A ghost here is a *position*,
    re-projected every frame like everything else, so it holds still under a drag with
    no special case. Verified: the pixels a ghost adds measure 850 facing north and
    1,038 after a 34° turn — the same order, not a smear.
  - **It costs no buffers and no uploads.** `mix` extrapolates outside [0, 1], so a
    ghost is the two ticks the GPU already holds blended at a *negative* `uT`, running
    the chord between them backwards. Which sign is backwards depends on which slot is
    older, which `showFrames` already knows. The error against the real past path is a
    fraction of a degree over the span used, and the thing being drawn is a smudge
    behind a moving dot.
  - **The belt casts no ghost.** Those objects do not move, so every copy would land on
    the original and, under additive blending, simply make it brighter — the belt would
    flare as the clock sped up. The still things stay still while everything else
    smears, which is the contrast the piece already trades on.
  - Every ghost material **spreads the shared uniform block** and overrides three
    entries, so colour, size by range, the horizon test and the shard's own shape can
    never disagree with the object being followed.
  - **The cost, stated honestly: p50 22.7 → 26.3 ms on a software rasteriser**, A/B/A'd
    to rule out drift (22.7 / 26.3 / 24.5 / 27.7 for none / four / none / four), of
    which about 0.8 ms is each extra draw rather than its fragments — the sweep itself
    barely registers. That is swiftshader at `synthetic` scale — 1,692 objects — and it
    is the one number in this file that has **not** been checked on a real GPU or at
    21k objects. `GHOST.count` is the dial: set it to 0 and the draws disappear
    entirely.
- **The backdrop** (`SKY.backdrop`): the sky's own colour lifted toward the horizon,
  with a pixel of grain over it. Added 2026-09-18, and the cheap half of the answer to
  "can we fill the black space". The sky was one flat value everywhere above the haze,
  and a flat value is what makes a frame read as *empty* rather than as dark.
  - **The lift and the haze share one ramp** (`SKY_RAMP_GLSL`), and they have to. The
    haze paints sky colour over objects as they sink — so a haze painting the *flat*
    sky erased the airglow in exactly the band where the airglow is strongest, and left
    a seam along the horizon with a dark sky above it and a lit ground below. A hazed
    object has to fade into the sky that is actually there. That was the first version,
    and it read as the floor leaking, which is the same symptom `lowestVisibleDeg`
    fixed for a different cause.
  - **Cool, not warm, and that is a rule.** A warm horizon glow reads as light
    pollution, which reads as a city, which is a *place* — and the framing is an
    abstract dome with no Earth geometry. Warm is also already spoken for by sunlight.
  - **The grain is added after the colour-space conversion**, which is the whole trick.
    sRGB's toe multiplies by 12.92 near black, so 0.012 of noise mixed in *before*
    `colorspace_fragment` arrives at about 39/255 on screen — static, not grain. Added
    after, it is 3/255, which is what dissolves the banding a gradient this shallow
    shows in 8 bits. It is hashed on `gl_FragCoord`, so it holds still in the frame
    while the sky turns behind it: the image's noise floor, not paint on the dome.
  - **It is the app's only fullscreen pass, and that is its whole cost.** +22.6 ms a
    frame on a software rasteriser with the sky alone, +29.5 once the ground moved into
    it, and the same at 1,692 objects and at 20,582 — it is fill, so object count does
    not enter into it. **Do not keep optimising the arithmetic.**
    The same sphere shaded with a constant colour still costs +11.0 ms of that, so half
    the bill is a CPU rasteriser touching a million pixels and would be nothing at all
    on a GPU. Moving the ramp onto the sine of elevation, normalising in the vertex
    shader and using a `sin`-free dither took it from +30.2; replacing the remaining
    `pow` with a cubic saved 0.6 ms, which is noise, and cost a dial.
    `SKY.backdrop.strength` of 0 skips the mesh, which is the only change that removes
    the pass. **This number has not been checked on a real GPU.**
- **The halo** (`GLOW`): a broad, soft falloff reaching past the dot, *inside the sprite
  the object already draws*. The cheap answer to "can we add glow" — no render target,
  no fullscreen pass, no extra draw. **+0.8 ms at 1,692 objects, +1.8 ms at 20,582**,
  on a software rasteriser, which is nearly free even there.
  - Bloom is the expensive answer and it is an architecture change, not a knob: an
    `EffectComposer` means half-float targets for the whole scene — see the
    render-target trap under *Wreckage tearing the picture* — and the glitch's canvas
    readback has to move with it. There is a real argument for it (bloom keys off
    brightness, and brightness already means *sunlit*, so it would reinforce the
    two-axis rule) and it is still open. It was not needed to fill the frame.
  - **Haloes sum, and that is the point.** Blending is additive, so a crowded patch of
    sky comes out brighter than a sparse one by more than the count of its marks.
    Density becomes a quantity the eye reads straight off the image, which is what this
    piece is about. Checked at 20,582 objects before shipping, because the risk was
    exactly the opposite — that the real sky would wash out to a single field of white.
    It does not: it reads as many.
  - Only lights have one. A shard is not a light, and the sprite does not grow for it —
    the fragment shader measures every shape against `vDotPx`, the dot's own width,
    rather than against the sprite, which is what lets the sprite carry a streak and a
    halo without either fattening the mark.
- **The ground** (`SKY.ground`): a dark field below the horizon with slow sheens
  drifting over it. Rewritten 2026-09-18, and it replaced a reflection that did not
  work.
  - **What was there was a mirror of the objects** — the same points drawn again with y
    negated, wobbled. Cheap, and wrong: a satellite has a *shape*, and a legible
    upside-down copy of a legible mark reads as a duplicate of the data rather than as
    water. Sixteen-pixel discs and triangles do not stop being discs and triangles when
    you flip them. There is now nothing identifiable down there at all — two warped sine
    fields crossed at different rates and stretched unequally, with no edge in them and
    no period a viewer can count.
  - **The ground disc was doing nothing, and had been for a long time.** It was a
    `CircleGeometry` at y = 0 and the camera sits at y = 0, so every one of its vertices
    projects onto the horizon line: seen exactly edge-on, it is degenerate. Verified by
    sampling the canvas with the mesh shown and hidden — **byte-identical**, (6, 8, 12)
    and (4, 6, 9) either way. Everything anyone has ever seen below the horizon was the
    backdrop sphere. The disc is gone, and the claim it once carried — that it dimmed
    what was under it to 28% — was false; anything written against that number,
    including this file's own note on `REFLECTION.strength`, was wrong.
  - So the ground is a branch inside the backdrop's fragment shader, which was already
    covering those pixels: no extra draw, only arithmetic on whatever part of the screen
    is below the horizon. **+6.9 ms of the backdrop's +29.5** on a software rasteriser,
    at six sines a pixel. Twelve cost +12.6 and looked no different, which is where the
    warp lost its two extra octaves.
  - **It evolves in place; it does not slide past.** Three waves whose directions and
    rates are all incommensurate, so no two agree on a velocity and their sum has none —
    it boils. That is the whole difference between light that happens and something
    being moved about: one translating layer gives the pattern a direction, and anything
    with a direction reads as an object with somewhere to be. Verified by running the
    field twenty times over and comparing frames a minute of real time apart — the
    structure is *different*, not displaced, and the amount of light in it changes too.
  - Kept dark deliberately (`amount`, down from 0.9 to 0.5). Anything bright enough to
    look like a source, or like something reflecting one, is too bright.
  - **Three things stop it reading as one mass**, which is what it did at first — a
    single swell crossing the whole ground from south to north:
    - **Frequency.** `stretch` went from (0.55, 0.13) to (1.7, 0.62): three times finer,
      and less lopsided. One feature spanning the frame is a scale problem before it is
      anything else.
    - **A folding warp.** The domain offset is over 1, so the coordinate folds back on
      itself and patches pinch off and reconnect instead of staying one continuous
      swell. It costs nothing — the warp was already there.
    - **The observer's shadow** (`shadow`): a pool of darkness deepest straight down and
      gone by the horizon. It puts the viewer in the picture, which a person on a dark
      plain always is, and it does the structural job too — **the shortest way across
      the ground from south to north runs straight through the observer**, so anything
      trying it is cut in half.
  - **The contrast window is a balance, and both ends fail differently.** Wide lifts the
    whole field at once and the ground becomes one sheet of light sliding across it;
    narrow thins the crests into hard ribbons, which are as defined a shape as anything
    this exists to avoid. 0.18–0.72 gave ribbons.
  - **Every number in it is a dial**, and that was a fair complaint when half of them
    were still in the shader: `color` and `sheen`, `amount` for how present it is,
    `stretch` for the scale on each axis, `crest` and `contrast` for how soft the swells
    are, `warp` for how hard the field folds, `speed` for the pace, `shadow` for the pool
    under the observer, `reachDeg` for how far down the light gets. Tuning this by
    looking is the point, so nothing about it should need a shader edit.
  - **It has to be darker than the sky, and that is the whole of what was wrong before.**
    Once the horizon had an airglow above it, a ground within a shade of the sky's own
    colour read as the same material with the glow inexplicably switched off. A horizon
    is a change of substance and value is what says so.
  - The coordinate is the ray projected onto a plane one unit below the eye, so the
    sheens compress toward the horizon the way anything lying flat does. **The distance
    is clamped**, because that projection runs to infinity at the horizon and an
    unclamped one aliases into a shimmering comb exactly where the eye is looking; the
    sheen is also held off the horizon itself for the same reason.
- **The glow pass** (`BLOOM`): light bleeding out of the whole finished frame — objects,
  orbits, rings, the graticule, the compass. Added 2026-09-18. `GLOW`'s halo lives
  inside each object's sprite and reaches objects alone; this is the other kind.
  - **It works entirely in display space, which is what makes it safe here.** The
    documented trap is that a render target receives linear values and `#05070a` cannot
    survive 8 bits of linear. This pass never meets it: it starts from a copy of the
    **canvas**, which already holds display-ready sRGB bytes, and no shader in the chain
    includes `colorspace_fragment` or tags a texture as sRGB, so every value passes
    through untouched from copy to composite. Blurring in display space is not
    physically correct and on a sky this dark it is the better-looking wrong — a linear
    blur blows the bright cores out.
  - Four kinds of pass: threshold-and-downsample, blur across, blur down, composite.
  - **The kernel is not scalable, and stretching it drew boxes.** The blur is a nine-tap
    Gaussian folded into five bilinear samples, and those offsets only weight correctly
    at their own spacing. Widening them to `spread: 2.2` pulled the five taps into
    separate lobes and put a visible **square** around every bright mark. Reach comes
    from `passes` — blurs compose, so n of them give `sigma*sqrt(n)` — and from
    `downscale`, never from moving the taps.
  - **+19.5 ms on a software rasteriser**, A/B/A'd (63.9 / 83.6 / 65.3 / 84.7), and
    almost all of it is the two full-size operations: the canvas copy and the composite.
    The nine low-resolution passes at 1/36 of the frame each are nearly free, which is
    the tuning guidance worth having — **raising `passes` costs almost nothing, lowering
    `downscale` costs a lot.** `strength: 0` skips every pass and both render targets.
  - Checked at 20,582 objects before shipping, because bloom over a sky that already
    sums additive haloes is exactly the thing that could turn into one white field. It
    does not: it reads as dense.
  - The panel does not glow. It is DOM and sits above the canvas, which is where this
    pass ends.
- **Render order is a design decision**, set in `RENDER_ORDER`: points, tracks and rings
  under the haze so they emerge together; graticule and compass labels above it so the
  dome stays legible to the horizon. **Tracks are under the objects** since 2026-09-18 —
  a track drawn over its own satellite puts a line across the mark being looked at, and
  the mark is the thing; the orbit is where it has been. The two shared an order before,
  and the tie went to whichever material three sorted first, which is not a decision
  anyone made.

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

That trap caught the ghosting too, and in exactly the same way: `main` calls
`scene.setTimeRate` every frame, so a `visible` flag poked in from the console was gone
before the next draw and the before/after screenshots were identical. **Stub the setter,
not the value.**

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
  both point and ring shaders now do. **Any** compile error in `POINT_FRAG` does this,
  and the second one found here was `float half` — a reserved word in GLSL — so the
  symptom is worth recognising: sky empty, rings intact, one line in the console.
- **Looking at the zenith kills the camera.** At pitch 90° the view direction is
  parallel to the camera's up vector, `lookAt` cannot build a basis, and the whole
  scene disappears. `render` clamps pitch to ±89° itself rather than trusting whoever
  set it — the drag handler is not the only thing that does, debug snippets included.

### Immersion

Added 2026-09-18, **and it is an experiment**: a slider at the bottom of the frame,
starting at 0, and 0 is exactly the piece as it was. `IMMERSION` in config.ts.

**Distance is invisible here, and that is the finding the whole thing rests on.** Every
object is drawn at `dir * SKY.radius` — one sphere, all 21k of them — and the camera sits
at the origin and only ever rotates. A perspective projection from the origin sends
`dir * r` to the same pixel for *every* r, which `picking.ts` has said out loud for
months. So moving objects to their true ranges would change nothing whatsoever on
screen: no parallax, no perspective, no growth. Parallax would need the camera to
translate, and that would give the dome a scale the piece does not have.

**So nothing moves.** The `range` column the shader already carries drives **size** and
**defocus** directly, because from a fixed eyepoint that is the only way depth can show
at all. The expensive version — real 3D positions, a depth buffer, a post-process DOF —
is not merely deferred, it is unnecessary.

**Defocus is nearly free here, for a reason that would not hold anywhere else.** Real
depth of field needs a depth buffer and a screen-space gather. But a defocused point
light **is** a soft disc, and every object here is a point sprite that already draws one
— so widening its own falloff is per-object bokeh with no render target, no pass and no
extra draw. The sprite is the bokeh. Out of focus a point does not become a *softer
point*: it becomes a disc, nearly flat across its face with a soft rim, because the lens
spreads the light evenly over the circle of confusion. That is what `POINT_FRAG` blends
toward, and a shard just gets its antialias band widened until the triangle stops being
one.

**Near is the subject and stays sharp; far is the background and goes soft.** That is
what a lens focused on something near does, and **the first version had it exactly
backwards** — it defocused the near marks and left the belt crisp, which is a lens
focused at *infinity*. Getting it right is one sign, but two more things had to follow
it, and neither was optional:

- **The core has to tighten as a mark is magnified** (`coreTighten`). Scaling a soft
  profile up only gives a bigger soft profile: a 16 px dot at six times reads as a 96 px
  *blur*, indistinguishable from the background bokeh it is meant to be the opposite of.
  Holding a hot core inside a spreading halo is what makes a near mark read as a light
  that has come close rather than one that has gone out of focus.
- **The two ends need different energy bargains** (`nearDim`, `farDim`). A near mark
  needs most of the conservation, because there are hundreds of them and anything
  generous piles them into a white cloud. A far one needs *less* than full: a belt point
  is faint and two pixels wide, so spreading it over sixteen times the area at 1/16 the
  brightness does not blur it, it **deletes** it. Out-of-focus highlights are supposed to
  be visible — that is what bokeh is.

**`farKm` decides what the picture is about**, and it is wide on purpose. The passing sky
is 300–2,500 km, so a generous far point leaves nearly all of it on the near side of the
ramp — subject, sharp, enlarged — while the belt at 36,000 km is flatly background,
excluded by arithmetic rather than by a special case. At 2,500 almost everything counted
as far and the whole frame turned to bokeh with no subject in it, which is the opposite
failure to the first one. It also means a pass arrives as it crosses overhead, because
that is when it is genuinely nearest. Nothing about this is staged.

**It blows out at catalogue scale, and `synthetic` will never show you.** On 1,692
objects (~100 above the horizon) almost any setting looks well. On 20,582, with 800
passing, the additive marks pile into **one white cloud** wherever a constellation shell
is dense. Every exponent here was set against the real count, not the development one.
**Check this at both scales.**

**The cost is fill, it scales with the catalogue, and it is the largest single thing
added so far.** A/B/A'd on a software rasteriser:

| `full`, 20,582 | immersion 0 | 0.5 | 1 | 0 again |
|---|---|---|---|---|
| near blurred (the wrong version) | 96.0 ms | 118.9 | 158.6 | 98.4 |
| near sharp, far bokeh (this one) | 96.4 ms | 148.1 | **264.1** | 98.4 |

**+166 ms at full immersion on 20,582 objects**, against +62 for the version that only
grew the near marks — because now *everything* grows, the background included. At
`synthetic` scale the same effect was +3 ms, so this is entirely a question of how many
objects are on screen.

For scale, the backdrop's whole fullscreen pass costs +22 ms on the same rasteriser, so
this is roughly seven passes' worth of fill — which on a GPU should be one or two
milliseconds, **though that has not been checked on one.** It is comfortably the most
expensive thing in the app. The levers are `maxGain` and `bokeh`, and area goes as the
square of each, so trimming either pays back fast. The dimming exponents do not help:
the sprites are the same size whatever they are set to.

**A near mark is a body, not a glow** (`bodyEdge`, `bodyGain`): a hard-edged disc, and a
shard keeps its triangle. **Additive blending cannot occlude** — it adds to whatever is
behind it, so nothing drawn this way is opaque in the compositing sense. What it can do
is *saturate*: against a `#05070a` sky a disc over 1.0 clamps to white, and once clamped,
what is behind contributes nothing more. That is the honest cheap version of opacity.
Real occlusion would need alpha blending and a depth buffer — and here is the one thing
the "distance is invisible" finding does **not** cover: radius is invisible to the
*projection*, but it is not invisible to the *depth buffer*. Giving the points real z
would buy occlusion and nothing else. It would also mean depth-writing points in a scene
where every layer currently sets `depthWrite: false` and `renderOrder` decides
everything, so it is a real change, not a knob.

**Where this stands, and it is not finished.** The mechanism works and every part of it
is cheap. What does not work is the *density*: at catalogue scale about 800 objects are
above the horizon, so "bring the near ones close" brings **hundreds** of them close and
the frame becomes a wall of discs at any tuning. Narrowing the range band does not fix
it — it swings to the other failure, where at some instants nothing at all is inside the
band and there is no subject, because the effect is at the mercy of what happens to be
overhead. That is a design problem, not a shader or performance one.

The promising answer is the one the sound already reached, for the same reason and in
almost the same words: **nothing sounds until it is kept**, because sonifying what is
merely *there* is mush. Immersing what is merely there is the same mush in the other
sense. Immersing only the **kept** objects would give one to five subjects, sharp and
close, against a soft field — legible, and consistent with the grammar the piece already
has. It needs picking to survive the effect first, which is the next piece of work.

**Markers leave, and picking stops.** A mark drawn eight times its size and spread into a
soft disc is nowhere near where `picking.ts` projects it, so rings and tracks fade out by
`markersGoneAt` and `piece.ts` stops picking above 0.02. A pointer that lies is worse
than no pointer. Making picking follow the effect is the next step, not this one.

**Its own control, not the scroll wheel.** Zoom and immersion are different axes and
would fight over one gesture.

### The first screen

Added 2026-09-18. The piece is meant to sit in a hero section on another page, and a
visitor who scrolls past one should pay nothing for it. So `main.ts` is now almost
nothing — it renders a title, a drawing, four sentences and a LAUNCH button — and
**everything else is behind a dynamic `import('./piece')`**: three.js, satellite.js, the
WASM propagator, the worker and the packed catalogue. `src/piece.ts` is the old `main`,
`src/gate.ts` is the screen, `src/poster.ts` is the drawing.

**Measured, on the production build: 8.7 KB before the press.** The page, the stylesheet
and a 12.7 KB entry chunk (5.7 gzipped). The press then fetches the piece chunk — 617.8 KB,
159.8 gzipped — the catalogue, the worker and the WASM build. Nothing else has ever been
this cheap to not look at.

**The trap in that, and it cost the whole saving before it was caught.** The button is
focused on creation, so Enter works for anyone who never touches a pointer. Warming the
chunk on `focus` — reasonable on its own, since tabbing to a button is intent — then made
that focus load the piece, which is *loading it on page load* with nothing on screen to
show for it. The measurement said 164 KB and the screen looked identical. The listener is
now attached **after** the programmatic focus, so focus counts as intent only when
something other than that line causes it. Check the number, not the behaviour: this
failure is invisible.

**It hands over at the first frame that has a sky in it.** `run` resolves from inside the
frame loop, on the first render with a pair of ticks in it — not when the loop starts,
which is a second or so earlier and would uncover an empty canvas. Anything that fails
before then leaves the screen up with the error on it and LAUNCH pressable again; a
missing catalogue in production is exactly that case.

**It does not start the sound, on purpose.** The press is a real user gesture and could
create the audio context — but a hero section that makes a noise when someone scrolls
onto it is precisely what `armFromSelection` exists to avoid. LISTEN and keeping an
object remain the two ways in. See *Turning it on*.

**`?launch` skips it**, for development and for a link that means to arrive already
inside the piece. Without the screen the loading text goes back to where the panel will
be.

#### The poster

`src/poster.ts` builds it as an SVG string from `PALETTE`, `KIND_LOOK` and `HIGHLIGHT`,
so the cover and the piece cannot drift apart. It obeys the same rules the sky does: no
Earth geometry, hue for category and value for state, debris as a turning shard, and
**not one character drawn on the sky**. Amber appears exactly once, on the one object
something is paying attention to — which is what makes amber read as attention rather
than as a property of the object.

**The belt does not drift.** Everything else in the drawing moves, very slowly; the
geostationary arc is left out of that group and holds still, which is the same contrast
the piece itself trades on. A fragment turns at its own rate and phase from the same
hash the point shader uses.

**It is drawn, not screenshotted.** A screenshot goes stale the first time the image
changes, and a cover showing a photograph of what is behind it reads as a substitute for
the thing rather than as a way in to it.

**The viewBox is anchored at the horizon** (`xMidYMax slice`), because a hero frame is
wider than 16:9 and something has to be cropped: the zenith can go, the horizon cannot —
it is what the image measures itself against. Hence the deliberately thin strip of ground
at the bottom of the viewBox. What survives: a 16:9 frame shows all of it, a wide hero the
bottom two thirds, a phone the full height and about a third of the width, centred. **The
amber ring is placed inside that intersection rather than wherever the highest object
happens to be** — the first version put it on the highest, and a 1600×620 hero cropped it
away entirely while leaving its track visible, which reads as a stray orange line.

### Where you are standing

Added 2026-09-18. `OBSERVER` used to be a constant; it is now a default with two ways
to override it — `?lat=&lon=` on the URL, and a **USE MY LOCATION** button on the first
screen. `src/place.ts` owns the browser call, `config.ts` owns the value and the URL.

**Nothing is asked before a press.** A hero section that fires a permission dialog at
someone scrolling past is hostile, most people deny, and a denial is sticky per origin —
so the one chance would be spent on a visitor who had not yet seen what the page is.
`getCurrentPosition` is called from inside that click and from nowhere else, which is
the same bargain the sound already makes.

**The first screen is the only place the observer can change without a reload, and
that is not a coincidence.** At that moment the piece does not exist — no worker, no
satrecs, no catalogue — because all of it is behind LAUNCH. Moving the observer there
costs nothing. Once the press has happened the worker holds the observer it was built
with, and changing it would mean re-initialising twenty thousand orbits; so the offer
lives on the first screen, and a later change would be a reload on the URL the button
already writes.

- **`OBSERVER` is mutable on purpose**, and every reader takes its fields at use time —
  `createHud`, `createGate` and `run` all read inside a function. **Nothing may capture
  them at module load**, or it holds Berlin for the life of the page.
- **The default must not move.** `scripts/reference.py` pins `OBS_*` to Berlin and
  `npm run validate` compares against the `reference.json` computed from them. A runtime
  override cannot reach that check — nothing in the build imports `config.ts`, the
  scripts take `catalog-format.ts` alone — but the default and `reference.py` still have
  to agree.
- **Two decimals, deliberately.** That is about a kilometre, which moves a 500 km object
  by a tenth of a degree — invisible — and it means a shared URL never carries anyone's
  precise coordinates. A location control that publishes a street address in a link is
  not one worth having.
- **A URL coordinate is not "your location".** A link someone else sent gets its
  coordinates and no name; only a fix from the device is named. `observerLabel()` is the
  one place either is formatted, so the first screen and the panel cannot disagree.
- **There is no geocoder and there will not be one.** A place name means a third-party
  lookup per visitor, which is the arrangement `fetch-catalog.mjs` exists to avoid.
- **Embedded, it needs `allow="geolocation"`** on the iframe, exactly like full screen,
  and the API is absent on `http:` altogether. `canLocate()` asks both questions and the
  button is not drawn when the answer is no, rather than drawn and broken.

**The trap, and it is a good one: `getCurrentPosition`'s own `timeout` does not cover
the prompt.** It starts counting once permission exists. While the dialog is open — or
if it is never shown, which is what a headless browser and some embedded webviews do —
neither callback fires and neither does the timeout, so the button sits on `LOCATING…`
for as long as the page is open. That reads as broken rather than as waiting. `locate`
therefore keeps a deadline of its own (`WAIT_MS`, 15 s) and **ignores a callback that
arrives after it**: a location landing thirty seconds after someone gave up and pressed
LAUNCH would move the sky out from under them.

**Latitude changes the piece, and the belt most of all.** The geostationary arc peaks at
`atan((cos φ − 0.1513) / sin φ)` — 44° at 40°N, 30° from Berlin, 22° at 60°N, 11° at
70°N — and above 81.3° it never rises at all. Belt objects above the sky's floor,
measured on `synthetic`: **96 from Berlin, 76 from Tromsø, 35 from Svalbard, 2 at 85°N,
105 at the equator.** The two left at 85°N are the inclined and drifting ones, which is
exactly right — a strictly geostationary satellite is below that horizon and one left
wandering at ±5° is not. Nothing breaks on the way: an empty slice is already silent
(`voice.members === 0` in `regroup`), so the bed thins out rather than dividing by zero,
and the grid simply gets smaller. **The drone is latitude-dependent, and that is a fact
about the sky rather than a bug.** Passing objects go the other way — 76 from Berlin,
103 at 85°N, 28 at the equator — because most of what is up there is in a
high-inclination shell.

### Full screen

Added 2026-09-18, in `src/fullscreen.ts`. The button lives in the hints corner rather
than in the controls block, because it changes the *frame* and not the image: it is not
one of the piece's controls. `f` does the same thing from the keyboard, and does nothing
while something is being typed into.

**Escape is the browser's own, and there is nothing here to implement.** Every engine
leaves full screen on Escape and says so the first time. What the code does is render
from state — `fullscreenchange` repaints the label and the hint however the change
happened, the button included — so an exit nobody here asked for cannot leave the panel
claiming otherwise. The `esc to leave` hint is drawn only while there is something to get
out of.

**Embedded, it may simply not be allowed**, and `document.fullscreenEnabled` is exactly
that answer: an iframe gets no full screen unless the embedding page says
`allow="fullscreen"`. So the button is **not drawn at all** rather than drawn and broken.
iPhone Safari never allows it for an element and answers the same way. A request that
still rejects — a permission invisible from in here — stops the offer for the rest of the
page rather than failing again.

**Headless Chromium cannot exercise Escape.** A synthesised key event does not reach the
browser-UI handler that exits full screen, so `page.keyboard.press('Escape')` leaves it
on and looks like a bug in this code. The reachable proof is calling `exitFullscreen()`
from the page — an exit this code did not initiate, which is what Escape is internally —
and checking the label follows it. The button and `f` cover the rest.

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

**The controls are one block, three rows.** PAUSE, NOW and the speed share the
column's width between them; the scrub slider is the same width under it; LISTEN is the
same width again. Revised 2026-09-17, when they read as "kind of lost" - they were
short, squat and all the same weight, so nothing in the row said where to start.

Two of them are now **filled rather than outlined**: the speed and LISTEN. Those are the
offers; the rest of the row is a tint on the sky, and an offer should not look like a
tint. The speed also carries a **drawn drop-down cue** - `appearance: none` took the
native arrow away years ago and without one a select reads as a button that does nothing
when pressed. LISTEN turns the belt's own blue while it is on, because the belt is what
sings.

**NOW is the way back, not just a jump.** Since 2026-09-18 it returns the clock to
this instant, puts the rate back to 1× *and* lets a held clock go. One press should
undo anything that reads as "where am I?", and a look-ahead left running at 100× is
exactly that — the drone is humming, the sky is streaking and the panel says `stood
back`, none of which a jump to now would have cleared on its own.

**No control writes its own label.** PAUSE and LISTEN are both rendered from state in
`update`. The note under them says `held` or `stood back` and never `silent`, because
nothing is silenced any more — see *Both buses*. That is not tidiness: the sound can now start without its button being touched
at all, so a label written inside the click would be a lie the moment that happened.

**The lists scroll, and nothing else does.** They used to be clamped - each group
`overflow: hidden`, so on a short window rows were cut off at a border with no sign that
more existed, and the two groups took space from each other. Now the spacer gives up its
slack first, then the belt's grid gives way and scrolls, and the lists keep a floor of
84 px so they can never be squeezed to a single row.

**A group is `flex: none`, and that one word is the whole fix.** It was `min-height: 0`,
which in a column flexbox *removes* the automatic minimum size - so a crowded PASSING
shrank below its own rows and they spilled out over DEBRIS underneath. Two lists drawn on
top of each other, which is what a short window showed and what "released the clamping"
had appeared to fix. At their natural height they push each other down instead, and past
the pair the block scrolls as one. Measured at 900, 620, 480 and 400 px tall with five
rows kept open: no row leaves its group, no group meets the next, and the column never
overflows the window.

**The scroll bars live in a gutter outside the rows.** A bar at the right edge of the
column sits on the names and on the box a kept row draws around itself. So both scrolling
boxes are widened past the column by the bar's width plus 6 px with a negative margin, and
given exactly that much padding back: the rows keep the full 272 px, the bar stands 6 px
clear of them, and `scrollbar-gutter: stable` reserves the track whether or not it is
scrolling so nothing jogs sideways when a list fills up.

**The bar's width is measured, not assumed** (`thinBarWidth` in `ui.ts`). `scrollbar-width:
thin` is 6 px in one engine and 10 in another, and `::-webkit-scrollbar` wins in a third.
Guessing 6 where Chromium draws 10 cost the rows 4 px and left every kept row's box out of
line with the controls above it - visible, and for no reason a reader could see. The probe
carries the real class, so whichever rule that engine honours is the one being measured.

**Headless Chromium paints no scroll bars at all** unless `--hide-scrollbars` is removed
from Playwright's default arguments. `offsetWidth - clientWidth` still reports the reserved
width, so the layout measures correctly while the screenshot shows nothing - which looks
exactly like a bar that failed to render.

The floor matters more than it looks. The belt's grid is four rows on the synthetic sky
and **twenty-one on the real one** - five hundred squares - so a rule tuned against
`synthetic` would hand a short window entirely to the grid. Check a layout change at both.

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

**Nothing exists until a gesture.** A browser will not let a page make a sound without
one, so "the drone is audible from the start" has to mean "from the first press" — there
is no arguing with the policy. The context, the forty-odd oscillators and all of their
cost are built inside that gesture and not before, so a page nobody turns the sound on
for pays nothing at all.

**There are two gestures, not one.** `LISTEN` / `SILENCE` under the time controls is the
explicit one. The other is **keeping an object** — from the sky or from the belt's grid —
which starts the sound by itself. Selecting something is the one gesture a first-time
visitor is certain to make, and hearing the sky is the point of the piece, so the button
should not be the only way in.

That runs through `Selection.onMark`, a hook called when a click *takes* an object and
never when it lets one go. It has to be a hook rather than a line in either caller: the
context can only be built inside the gesture, the frame loop is not one, and both ways of
keeping something already pass through `toggle` — so hanging it there is what stops the
belt's grid from needing to know the sound exists.

**Working the button turns that off.** `armFromSelection` does nothing once the person
has pressed `LISTEN` or `SILENCE` themselves, either way. Someone who asks for silence and
then clicks a satellite means to keep looking in silence, and having the sound come back
would read as the button being broken. Once the fade out is inaudible
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

#### Families: which bird a bird is

Added 2026-09-17. `STARLINK` sings as geese, `IRIDIUM` as starlings, and anything
CelesTrak files under `military` or `radar` as something big and squawking. Everything
else keeps the whistle the piece started with. The byte is decided by the **build** and
packed; the browser only reads it.

**Join on the catalog number, not the name.** This is the whole design decision. Every
GP record carries `NORAD_CAT_ID`, and so does the packed catalogue — it is the sort key.
CelesTrak publishes the hard cases as *groups*, so membership is theirs to define and
ours to read: fetch `GROUP=military`, take its catalog numbers, join. Name matching was
the obvious idea and is the worse one, and the fixture test shows exactly why — our
catalogue calls 55841 `COSMOS 2553` and the military list calls it `COSMOS-2553`, and
39232 is `USA 245` against `USA-245 (KH-11)`. A name join tags neither; a number join
tags both, and goes on working when an object is renamed.

**Names are still right for the megaconstellations, and only for them.** Every Starlink
is `STARLINK-####` and every Iridium `IRIDIUM ###` — the convention is absolute, so the
rule costs nothing and cannot drift. Fetching `GROUP=starlink` instead would make it the
largest download in the pipeline, four times a day, to learn something the name already
says. So a family is a name pattern, a set of groups, or both; first match wins, and
`scripts/catalog-sources.mjs` is the only place that knows any of it.

The two group lists are `tagOnly` sources: fetched the same timid way, **not** unioned
into the catalogue. They are payloads `active` already has, and what is wanted is the
list of numbers. Two more small requests per cycle against a budget of 100 MB a day.

**`kind` still decides what an object is.** A Starlink rocket body is a machine and a
Starlink fragment is a shard; the family only chooses which bird a *bird* is. That
ordering is what keeps the wreckage grammar intact.

The voices, in `AUDIO.performer.voices` — each a full parameter set rather than a patch
on a default, because a family that differs in one number is not a family:

| | wave | register | rhythm | ring |
|---|---|---|---|---|
| none | sine | — | 2–5 quick swept chirps | — |
| starlink | sawtooth, driven | −1 octave | 1–2 long falling honks, long gaps | — |
| iridium | square | +1 octave | 4–9 very short notes, wide sweeps | 2.76× base, Q 20 |
| military | sawtooth, driven hard | −2 octaves | 1–3 slow falling squawks | 2.76× base, Q 20 |

Measured alone, mid-pass at 45°: none −38.2 dBFS, starlink −35.1, iridium −36.9,
military −32.6; all four at once −29.2, peak 0.385. **Those are corrected for register,
not levelled by RMS.** The ear is roughly 6 dB less sensitive at 220 Hz than at 1 kHz and
8 dB less at 175, so the low families have to *measure* hotter to sit level. Tuning them
by RMS alone buried the geese 5.5 dB under the songbirds.

**`FAMILY_VOICE` is a total map over `Family`**, not an array or a lookup with a
fallback, so adding a family and forgetting to give it a voice is a compile error rather
than a satellite that quietly sings the default.

**How to verify the join without CelesTrak.** This environment cannot reach
celestrak.org, and in general nothing should be fetched casually — their terms are
enforced. So the join is tested against a fixture: write a fake `.catalog-cache/` with a
handful of records whose names deliberately disagree between the catalogue and the group
lists, run `pack-catalog.mjs`, and assert each object's family. That covers precedence
too — `STARLINK-30000` appears in the military list and must still come out Starlink. The
real per-family counts appear in `check:catalog`'s output on the next CI run, which is
also the gate: all families empty on `full` fails the deploy, a thin one does not,
because an untagged object sings the default voice and that is not wrong.

`synthetic.bin` carries the families too — its Starlink and Iridium shells are named so
the *name* rules match them by exactly the path production takes, at the real altitudes
and inclinations. The military shell is tagged explicitly, which it has to be: there is
no group list offline, and that is a stand-in for the join rather than a second rule.

**And there is a third scale to test at.** The fixture proves the join; `synthetic`
exercises the runtime; neither is 20,000 objects. Writing a **full-scale stand-in**
straight into `.catalog-cache/` - a plausible composition of names, with group lists that
spell the same objects differently - and packing it through the real pipeline gets the
rest: `check:catalog` passed on 19,785 invented objects, worker init 546 ms, tick 15.2 ms
with a queue of 4 ready and 0 in flight, and every family carried through to a distinct
voice in the browser. What it cannot tell you is anything about the *sky*: the
composition that comes out is the composition you put in. Delete the cache afterwards, or
the next local `fetch:catalog` will see fresh metadata and pack the invention.

One case only scale shows: `IRIDIUM 33 DEB` fragments match the Iridium *name* rule, so
110 of them carry `FAMILY.IRIDIUM` while `kind` still says debris - and they sound as
shards, because kind decides the class. That is the rule working, not a mis-tag.

#### Both buses

**Sound runs at every time rate, and the rate attenuates it** (`AUDIO.rateDuck`).
Changed 2026-09-18. It used to stop dead above 1×, on the reasoning that a drone whose
pans sweep at that speed is a siren. That was true of the 1800× ladder and stopped being
true when the ladder was capped at 100×, but the mute stayed behind.

**Nothing in the audio path actually accelerates**, and that is worth knowing before
touching it. Every continuous parameter moves through `setTargetAtTime` with a time
constant in *real* seconds (0.09–0.4 s), and phrases are scheduled on the audio
context's own clock — so the song keeps its tempo however fast the sky runs. What does
change is welcome: range rate is a physical quantity and does not scale with playback,
so the Doppler bend is the same ±650 cents but sweeps across a pass in forty seconds
instead of thirty-five minutes. That is the swoop the exaggeration was for.

Measured by rendering `Performers` offline against the same pass walked at each rate —
six voices, eight seconds, the largest sample-to-sample step as the click detector:

| rate | RMS | peak | largest step |
|---|---|---|---|
| 1× | −29.3 dBFS | 0.372 | 0.079 |
| 10× | −27.4 | 0.448 | 0.096 |
| 60× | −25.5 | 0.563 | 0.093 |
| 100× | −27.4 | 0.416 | 0.075 |

**The step is not smaller at 100× by luck — it is the waveform's own slope, not a
discontinuity.** A square wave steps by its full amplitude between samples, so this
detector reads the timbre, and the finding is the flat column: nothing the rate does
introduces a jump that is not there at 1×. The level climbs to 60× because more of the
pass is inside the window, then falls again as objects set and voices are let go.

**The rate is heard as pitch, not as level** (`AUDIO.rateDrive`, added the same day).
Attenuating alone answered only "the sound has not broken". Running the bed *up* makes
the clock itself audible: `Drone.setRateCents` transposes every oscillator on that bus
by up to +1900 cents at 100×, glided over `rateGlideSeconds`, and the bed climbs out of
its sub-bass into a hum. Measured by spectral centroid over an offline render, 500 belt
objects: **58 Hz at 1×, 112 at 10×, 165 at 60×, 181 at 100×** — a factor of 3.1, which
is the 1900 cents.

It is **the drone's alone**. The birds keep their register, because a satellite's own
song is not what the clock is doing. There is a fair objection — the belt does not
move, so why should it change with the rate? Because the bed is not the sound of five
hundred objects; it is the sound of the sky they are the floor of, and that is what is
running.

**The transpose is an offset on a remembered base, never an overwrite.** Each
oscillator's own `detune` is already spoken for — the bed's few cents of spread, a kept
voice's place inside its slice — so `Drone.tuned` holds every node beside the detune it
was born with. Stopped solos are spliced out of that list, or a page left playing all
day would keep every dead voice in it; verified over three keep-and-release rounds,
27 → 35 → 27.

So the level attenuates *and* the pitch rises: full at 1×, `rateDuck.to` at 100×,
logarithmic in between because the ladder is. That number **came down from 0.55 to
0.30** when the transpose arrived, and the reason is the ear rather than the meter:
equal-loudness puts hearing some 15 dB more sensitive at 181 Hz than at 58, so holding
the old level would have made the hum arrive far louder than the drone it grew out of.
−10.5 dB gives back about two thirds of that, leaving the rise plainly audible without
it taking the room. Measured live at 0.450, 0.349, 0.270, 0.135 for 1/10/60/100×.

The belt's bed stays audible at every rate, which also answers the thing a mute could
not: a listener has no way to tell a silenced piece from a broken one.

**Pause freezes the instrument; it does not silence it** (`AUDIO.paused`). The sound
here is state plus events — where a thing is, how high, lit or eclipsed, and the
phrases a bird sings. `PAUSE` stops the events: `Performers.update` takes a `held` flag
and writes no phrase while it is set. The state stops changing by itself, because the
frame does. What is left is what does not move anyway — the belt's bed and the shards'
hiss — at `paused.level`, so the press is audible. Turning the camera still sweeps the
belt across the field, because looking is not time passing.

Measured: the second half of an eight-second render, held at four seconds, falls from
−29.6 to −44.7 dBFS at 1× and from −32.7 to −40.0 at 100×.

**A held voice carries `nextAt` forward with the clock.** Letting it fall behind while
no phrase is written would leave the lookahead loop a backlog to catch up on — every
held bird singing at once the moment the clock started again. The guard of 8 would cap
it and the burst would still be wrong.

**Nothing in the audio path reads `Clock`.** The drone is driven by belt membership and
by where the camera is pointing — those objects do not move. The performers are driven by
the `SkyFrame` columns of whatever tick is on screen, and their events are scheduled on
the audio context's own clock, which is why a stuttering frame does not stutter a song.

**Doppler is exaggerated, and has to be.** A LEO object at 7.5 km/s gives a fractional
shift of 2.5e-5 — about **0.04 cents**, which is nothing. The reason radio amateurs hear
it at all is that it is 2.5e-5 of a 145 MHz carrier: a 3.6 kHz slide in the beat note.
`dopplerCentsPerKmS` scales it into the audio band, which is not a cheat but the same
operation the metaphor was built on.

**Purpose is still not in the pipeline**, and the family table is how it would arrive
when it is wanted. The softer-weather / bolder-telecom voicing needs no new mechanism
now: CelesTrak publishes `weather`, `intelsat`, `ses` and the navigation constellations
as groups, so each is a row in `FAMILIES` and a voice in `AUDIO.performer.voices`. What
it costs is one more small fetch per group per cycle. `kind` remains a name heuristic and
GP data still carries no object type at all; the families go around that rather than
through it.


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

### Embedding it

The page is meant to be iframed into a hero section. Two things the embedding page has
to do, both cheap and both invisible when missed:

- **`allow="fullscreen"` on the iframe**, or `document.fullscreenEnabled` is false in
  here and the FULL SCREEN button is not drawn at all. That is the honest behaviour, but
  it looks like the feature was never built.
- **`allow="geolocation"` too**, for the same reason and with the same symptom: without
  it USE MY LOCATION is not drawn. Nothing is ever asked before that button is pressed —
  see *Where you are standing*.
- **Give it a real height.** The canvas fills whatever box it is given, and the panel is
  a full-height column; under about 400 px the lists scroll rather than fitting, which is
  handled but is not the image.

`?launch` skips the first screen, `?lat=&lon=` stands somewhere else, `?catalog=active`
drops the wreckage, and `?debug` turns on frame timing — see *The first screen*, *Where
you are standing* and *The catalogue*.

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
  - [x] **Filling the frame.** Airglow and grain on a backdrop the haze shares its ramp
        with, a halo inside the sprite each object already draws, and a ground that is
        a different substance from the sky. See *Rendering*.
  - [x] **Immersion.** A slider that brings the near things close and defocuses them,
        leaving the belt small and sharp behind. Nothing moves - from a camera at the
        origin every radius projects to the same pixel - so range drives size and bokeh
        instead. Markers and picking are still to follow. See *Immersion*.
  - [x] **The glow pass.** Screen-space bloom over the whole finished frame, orbits and
        rings included — and it turned out not to need half-float targets after all,
        because working from a copy of the canvas keeps the whole chain in display
        space. See *The glow pass*.
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
  - [x] **Bird species.** Starlink as geese, Iridium as ringing starlings, military and
        radar as heavy squawks, everything else the original whistle. Tagged at build
        time and packed as a byte — by a join on catalog number against CelesTrak's own
        group lists, by name only for the megaconstellations. See *Families*.
  - [ ] **More of them.** Weather, telecoms and the navigation constellations are each
        a row in `FAMILIES` and a voice, now that the mechanism exists. And a wider
        vocabulary of calls than the four here — caw, cackle, the rest of it.
  - [ ] **HRTF.** `PannerNode` behind a flag, on the same direction vectors, once the
        stereo mapping is known to be right.

## Conventions

- **`main.ts`, and everything it imports, must stay free of three.js, satellite.js and
  the catalogue.** Anything heavy belongs in `src/piece.ts` or behind it. The first
  screen's whole point is that a page nobody presses costs 8.7 KB; one stray static
  import puts 160 KB back, silently and with nothing on screen to show for it. Check the
  entry chunk's size in `npm run build`'s output after touching the entry.
- The observer's **default** lives in `src/config.ts` as `DEFAULT_OBSERVER` and **must**
  match `OBS_*` in `scripts/reference.py`, or the validation compares different things.
  `OBSERVER` itself is settable at runtime — see *Where you are standing* — so **nothing
  may read its fields at module load**; take them inside the function that needs them.
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
  fresh clone runs offline; nothing may be concluded from it. **Any change to
  `catalog-format.ts` that bumps `FORMAT_VERSION` has to regenerate it in the same
  commit** - `active.bin` and `full.bin` are rebuilt by every deploy and cannot go
  stale, but this one is in git and a browser refuses a version it does not read.
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
                         # in Claude Code on the web this needs celestrak.org added to the
                         # environment's network egress allowlist, or every fetch 403s
npm run check:catalog    # sanity + exact round trip of the packed catalogues
npm run validate         # four roads to a position, against the Python reference
npm run bench            # WASM vs JS at catalogue scale
npm run build            # typecheck + production build
npm run make:synthetic   # regenerate the committed offline fallback
```
