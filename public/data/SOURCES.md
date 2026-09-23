# Where the element sets come from

The code in this repository is AGPL-3.0-or-later. **The orbital element sets the site
publishes are not**, and nothing here relicenses them. This file records where each one
comes from and what the source asks of anyone redistributing it.

## The files

| file | origin | real? | in git? |
|---|---|---|---|
| `active.bin` | CelesTrak GP, `GROUP=active` | **yes** | no — built at deploy |
| `full.bin` | union of every CelesTrak GP dataset | **yes** | no — built at deploy |
| `synthetic.bin` | `scripts/make-synthetic.mjs` | **no** — invented | yes |

`active.bin` and `full.bin` are CelesTrak's OMM JSON re-encoded, without loss, into the
binary format described at the top of `src/catalog-format.ts`. The numbers are
CelesTrak's; every deploy verifies that each object decodes to exactly the satrec its
original record gives. Each file's header records when it was fetched, and the page shows
it.

`synthetic.bin` is ~1,450 **invented** orbits across plausible LEO shells. Nothing in it
corresponds to a real object, and no conclusion about where anything actually is may be
drawn from it. It exists so development works offline: the dev server shows it only when
the real catalogue has not been fetched, and labels it on screen. The published site never
uses it.

`scripts/fixtures/validation.tle`, the frozen input to the propagation check, is not
published at all. See the header inside it.

## What CelesTrak publishes — and what it does not

CelesTrak has no single query for the whole catalogue. `full.bin` is the union of every GP
dataset that adds objects (`scripts/catalog-sources.mjs` is the authoritative list):

| dataset | objects, 2026-09-13 |
|---|---|
| `GROUP=active` | 16,563 payloads |
| `GROUP=analyst` | 566 tracked, not yet identified |
| `GROUP=last-30-days` | 255 |
| `SPECIAL=GPZ-PLUS` | 1,728 — the GEO protected zone, incl. its rocket bodies and debris |
| `SPECIAL=DECAYING` | 95 |
| `GROUP=fengyun-1c-debris` | 1,969 — 2007 anti-satellite test |
| `GROUP=cosmos-2251-debris` | 585 — 2009 collision |
| `GROUP=iridium-33-debris` | 110 — the same collision |
| **union** | **20,933** |

CelesTrak's own SATCAT counted **35,093** objects on orbit the same day. So the image
contains every payload, but only about 3,000 of the ~15,000 debris fragments and rocket
bodies up there — nearly all from those three breakups. The rest are not published as GP
data. The sky in this piece is denser than it looks, and the real one denser still.

Since 2026-07-11 new objects carry 6-digit catalog numbers and have no TLE at all, which is
why this project reads OMM.

## CelesTrak

<https://celestrak.org/> — Dr T.S. Kelso's service, the canonical free source of general
perturbations data, derived from the US Space Force's public catalogue. Orbital elements
produced by a US government body are not themselves copyrightable, but CelesTrak's
*service* is a private one run at someone's expense, and its terms are enforced
technically rather than legally:

- GP data refreshes every **2 hours**. Do not request a dataset more than once per cycle
  — a repeat inside the cycle returns HTTP 403.
- Abuse earns **HTTP 403**, then an **IP-level firewall block**. Retrying a 403 or a 404
  does not help and makes a block more likely.
- Further restrictions apply past **100 MB/day**.
- Automated consumers should identify themselves in the `User-Agent` header.

### The arrangement this repo uses, and why a fork must keep it

`scripts/fetch-catalog.mjs` is the only thing in this project that talks to CelesTrak. It
runs inside `.github/workflows/deploy.yml` every six hours, refuses to request any dataset
fetched under two hours ago, never retries, and keeps its cached copy whenever CelesTrak
refuses. A full run is ~9 MB. **The browser never contacts CelesTrak** — it reads the
packed files that job published.

This is not merely polite. A public page fetching CelesTrak directly puts *every visitor's*
request on this project's account, which is exactly the pattern their 403s and IP blocks
exist to stop; and CelesTrak sends no CORS headers, so it would not work from a browser
anyway. Every six hours is far more often than the data needs — element accuracy degrades
over days, not minutes.

If you fork this, keep the fetch-and-cache arrangement intact.

## Space-Track

<https://www.space-track.org/> holds the complete catalogue, debris included, but requires
authentication and restricts redistribution — and a public page that ships element sets to
every visitor's browser is redistribution. It is the only way to the missing ~14k objects,
and is noted here so that choice is on the record.

## The UCS Satellite Database

<https://www.ucsusa.org/resources/satellite-database> — the Union of Concerned
Scientists' database of active satellites, with an operator, a purpose and a class of
user for each one. This project uses the **1 May 2023** edition, which is the last one
UCS published.

**What is taken from it is 613 integers.** `scripts/ucs-military.py` reads the
spreadsheet once and writes `scripts/ucs-military.json`: the NORAD numbers of every row
whose `Users` column mentions Military, and nothing else — no names, no operators, no
orbital data. That list is committed and joined against the catalogue at pack time to
decide one byte per object. The spreadsheet itself is **not** committed and is not
published here in any form; anyone re-deriving the list downloads it from UCS.

Credit is given because the classification is theirs and is the whole value of it. There
is no all-military GP group — CelesTrak does not make that call — so without this the
family was 24 leftover objects plus two name rules of our own invention. It is now 409,
and 303 of them are somebody's published judgement rather than ours.

**It is frozen, and that is stated wherever it is used.** 57.9% of the catalogue on
2026-09-22 launched after the snapshot, so the list can only ever describe the older
half of the sky and will describe less of it every year. The name rules in
`scripts/catalog-sources.mjs` exist to cover what it cannot see, and the snapshot date
is written into the derived file so the staleness is visible rather than inferred.

The elements themselves still come from CelesTrak. Nothing in `active.bin` or `full.bin`
is UCS's except which family byte 409 objects carry.
