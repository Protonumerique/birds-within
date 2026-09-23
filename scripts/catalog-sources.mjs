/**
 * What the piece is built from. Shared by fetch-catalog.mjs, pack-catalog.mjs,
 * check-catalog.mjs and make-synthetic.mjs, so they cannot disagree.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAMILY, KIND, kindFromName } from '../src/catalog-format.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Military catalog numbers from the UCS Satellite Database, derived once by
 * `scripts/ucs-military.py` and committed - see that file for why, and
 * `public/data/SOURCES.md` for the credit. Read here rather than imported so the
 * scripts need no JSON import attributes.
 *
 * It is a **frozen snapshot of 1 May 2023**, which is what makes it a supplement to
 * the name rules below and never a replacement for them: 57.9% of the catalogue
 * launched after it, including 56 of our 164 YAOGAN.
 */
export const UCS_MILITARY = JSON.parse(
  readFileSync(resolve(ROOT, 'scripts/ucs-military.json'), 'utf8'),
);

/** Raw CelesTrak JSON. Gitignored; carried between CI runs by the Actions cache. */
export const CACHE_DIR = '.catalog-cache';

/** CelesTrak updates GP data every 2 hours and 403s a repeat inside the cycle. */
export const MIN_REFETCH_MS = 2 * 60 * 60 * 1000;

/** CelesTrak asks automated clients to identify themselves. */
export const USER_AGENT =
  'birds-within/0.2 (satellite art project; https://github.com/Protonumerique/birds-within)';

/**
 * Every CelesTrak GP dataset that contributes objects.
 *
 * CelesTrak publishes no full-catalogue query. On 2026-09-13 their SATCAT counted
 * 35,093 objects on orbit, and the union of everything below was 20,933: every
 * payload, but only ~3k of the ~15k debris, almost all of it from three breakups.
 * General debris and most rocket bodies are not published as GP data at all.
 * Space-Track has them, but requires an account and restricts redistribution,
 * which a public page shipping element sets to browsers would be.
 *
 * Counts in the comments are from 2026-09-13, for scale only.
 */
export const SOURCES = [
  { id: 'active', query: 'GROUP=active' }, // 16,563 - payloads
  { id: 'analyst', query: 'GROUP=analyst' }, // 566 - tracked, not yet identified
  { id: 'last-30-days', query: 'GROUP=last-30-days' }, // 255, 19 not in active
  { id: 'gpz-plus', query: 'SPECIAL=GPZ-PLUS' }, // 1,728 - GEO protected zone, incl. its rocket bodies and debris
  { id: 'decaying', query: 'SPECIAL=DECAYING' }, // 95
  { id: 'fengyun-1c-debris', query: 'GROUP=fengyun-1c-debris' }, // 1,969 - 2007 ASAT test
  { id: 'cosmos-2251-debris', query: 'GROUP=cosmos-2251-debris' }, // 585 - 2009 collision
  { id: 'iridium-33-debris', query: 'GROUP=iridium-33-debris' }, // 110 - same collision

  // Fetched for their membership only - see FAMILIES. `tagOnly` keeps their objects
  // out of the union: these are payloads `active` already has, and the point of
  // downloading them is the list of catalog numbers, not the elements.
  { id: 'military', query: 'GROUP=military', tagOnly: true }, // 24 on 2026-09-22
  { id: 'gnss', query: 'GROUP=gnss', tagOnly: true },
  { id: 'weather', query: 'GROUP=weather', tagOnly: true },
  { id: 'science', query: 'GROUP=science', tagOnly: true },
];

export const gpUrl = ({ query }) => `https://celestrak.org/NORAD/elements/gp.php?${query}&FORMAT=json`;

/** The packed catalogues the browser can load, and the sources each is the union of. */
export const DATASETS = {
  active: ['active'],
  full: SOURCES.filter((s) => !s.tagOnly).map((s) => s.id),
};

/**
 * Bird families: which voice an object sings with, decided here and packed as a byte.
 *
 * **Join on the catalog number, not the name.** Every GP record carries
 * `NORAD_CAT_ID`, and so does the packed catalogue - it is the sort key. CelesTrak
 * publishes the hard cases as *groups*, so membership is theirs to define and ours to
 * read: fetch `GROUP=military`, take its catalog numbers, join. That survives an object
 * being renamed, and it is a real classification rather than a guess. Matching on names
 * was the obvious idea and is the worse one - "COSMOS 2553" against "COSMOS-2553" is
 * exactly the kind of thing that silently tags nothing.
 *
 * **Names are still right for the megaconstellations**, and only for them. Every
 * Starlink is `STARLINK-####` and every Iridium `IRIDIUM ###`; the convention is
 * absolute, so the rule costs nothing and cannot drift. Fetching `GROUP=starlink`
 * instead would make it the largest download in the pipeline, four times a day, to
 * learn something the name already says.
 *
 * So a family is a name pattern, a set of groups, an explicit list of catalog numbers,
 * or any mix of them. **First match wins**, so the order here is the precedence.
 * Anything unmatched is `FAMILY.NONE` and keeps the whistle the piece started with.
 *
 * `kind` still decides what an object *is*: a Starlink rocket body is a machine and a
 * Starlink fragment is a shard. The family only chooses which bird a bird is.
 */
export const FAMILIES = [
  { value: FAMILY.STARLINK, name: /^STARLINK[- ]/i },
  { value: FAMILY.IRIDIUM, name: /^IRIDIUM[- ]/i },
  // Navigation before military on purpose, and it is a real choice rather than an
  // ordering accident: GPS is a US Space Force system and its satellites can appear
  // in both lists. "That one is telling you where you are" is the more informative
  // reading of a mark in the sky than "that one belongs to an air force", and
  // navigation is a narrative of its own - a dozen satellites, always up, that
  // everything on the ground depends on.
  { value: FAMILY.GNSS, groups: ['gnss'] },
  /*
   * **Military. Three sources, and no one of them is enough.**
   *
   * There is no all-military GP group, because that classification is contested and
   * CelesTrak does not make it. What their `military` group actually is, checked on
   * 2026-09-22, is a **leftover bucket of 24**: 22 Praetorian SDA, SAR-Lupe 2,
   * Sapphire, Victus Haze Puma. `GROUP=radar` used to be in here too and is now out -
   * its ten members are passive **calibration spheres**, Calsphere and Rigidsphere and
   * LCS, aluminium balls flown from 1964 for radars to range against. Verified the way
   * these things have to be: the first object to rise wearing the military colour was
   * CALSPHERE 1, and a 1964 metal ball is not what that colour means.
   *
   * So the family reads **three** things, unioned:
   *
   *   `GROUP=military`   24, CelesTrak's bucket
   *   UCS_MILITARY      613 numbers, a published classification - see ucs-military.py
   *   two name rules     YAOGAN and USA ###, for what postdates the UCS snapshot
   *
   * **The UCS list is what makes this a classification rather than our judgement**,
   * which is the thing the rest of this file exists to preserve. It joins on the
   * catalog number like everything else here, and it resolves the case a name rule
   * never could: `COSMOS ####` matches 805 objects, 611 of them fragments of the 2009
   * Cosmos 2251 collision, so a name rule would tag the wreckage of a communications
   * satellite as a weapon. UCS names **62 specific military Cosmos payloads** by
   * number and leaves the debris and the civil ones alone. That is the whole argument
   * for joining on numbers, arriving in one example.
   *
   * **The name rules stay, and are not decoration.** UCS froze on 1 May 2023 and
   * 57.9% of the catalogue launched after it. Measured on 2026-09-22: of the 409
   * objects this family now holds, 106 come from the name rules alone - 76 YAOGAN, 21
   * Praetorian SDA, 8 USA, Victus Haze Puma - every one of them a launch UCS never
   * saw. The list gives breadth, the names give currency.
   *
   *   YAOGAN   164 objects, China's reconnaissance series
   *   USA ###   23 objects, the US military designator
   *
   * Both are naming conventions that are absolute and cannot drift, which is the same
   * standard the megaconstellations are matched by.
   *
   * 402 of the 613 UCS numbers are still on orbit; 99 of those are navigation and are
   * taken by the GNSS rule above before this one is reached, which is that ordering
   * doing its job on Beidou and Navstar.
   */
  { value: FAMILY.MILITARY, groups: ['military'], catnrs: UCS_MILITARY.catnrs, name: /^(YAOGAN|USA[- ]\d)/i },
  { value: FAMILY.WEATHER, groups: ['weather'] },
  { value: FAMILY.SCIENCE, groups: ['science'] },
];

/** Every group whose membership some family reads. */
export const TAG_GROUPS = [...new Set(FAMILIES.flatMap((f) => f.groups ?? []))];

// A Set per family that carries an explicit number list, built once rather than per
// object: `familyOf` runs 21,000 times a pack and a linear scan of 613 would show.
// The catalogue's NORAD_CAT_ID arrives as a string from CelesTrak's JSON, so both
// sides are coerced to Number - a Set of ints never matches the string '25544'.
for (const family of FAMILIES) {
  if (family.catnrs) family.catnrSet = new Set(family.catnrs.map(Number));
}

/**
 * Which family an object belongs to. `inGroup` answers whether a catalog number is in
 * a named group; the packer builds it from the tag sources.
 */
export function familyOf(name, catnr, inGroup) {
  /*
   * **Wreckage has no family.** Changed 2026-09-23, and it reverses a decision this
   * file used to defend as "the rule working".
   *
   * `IRIDIUM 33 DEB` matches the Iridium name rule, so 109 fragments of the 2009
   * collision carried `FAMILY.IRIDIUM` - more than half the family. The argument for
   * keeping them was that hue carries the constellation while shape carries the kind,
   * so nothing is lost. What that missed is that the three channels then **disagree**:
   * the mark is a shard, the voice is a shard, and the colour says *working Iridium
   * satellite*. Reported exactly so - "they look like a shard and produce
   * interference, but are colored green. This makes no sense."
   *
   * A family names a constellation, and a fragment is not a member of one. It is what
   * is left of a member, which is a different fact and one the wreckage grammar
   * already tells better than a hue could.
   *
   * It costs the Iridium family 109 of its 190 objects, and the 2009-collision story
   * with them. That story is still in the sky - those fragments are drawn, they tear
   * the picture and they hiss - it simply is not told in Iridium's colour any more.
   *
   * **Rocket bodies joined it on 2026-09-24**, and the line is now the general one:
   * only a payload can be in a family. This paragraph used to say spent stages were
   * deliberately left in, on the grounds that a launcher is not wreckage and there
   * was exactly one in the whole table. Both halves were wrong.
   *
   * It was reported from the live piece: two objects named `FREGAT R/B`, one wearing
   * the military green and one not. That is the Iridium failure exactly - the mark is
   * a round machine, the voice is the industrial knock, and the colour says *working
   * military satellite* - and it is arguably worse, because the two stages sat in the
   * same sky disagreeing with each other about what they were.
   *
   * A Fregat is an upper stage; it carried the payload and was discarded. Whatever
   * the payload belonged to, the stage does not: a family names a constellation and a
   * spent stage is not a member of one, any more than a fragment is. And "exactly one"
   * only ever counted the **name** rules. A stage reaches a family through the catalog
   * number join as easily as a payload does, which is how `FREGAT R/B` - a name no
   * rule here mentions - ended up military in the first place.
   *
   * `KIND.ROCKET_BODY` is untouched and must stay that way: a stage is still a round
   * mark rather than a shard, and still sings `machine` rather than hissing. What it
   * loses is only the constellation hue it was never entitled to.
   */
  if (kindFromName(name) !== KIND.OTHER) return FAMILY.NONE;

  for (const family of FAMILIES) {
    if (family.name && family.name.test(name)) return family.value;
    if (family.groups?.some((g) => inGroup(g, catnr))) return family.value;
    if (family.catnrSet?.has(Number(catnr))) return family.value;
  }
  return FAMILY.NONE;
}
