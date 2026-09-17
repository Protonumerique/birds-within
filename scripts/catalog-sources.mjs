/**
 * What the piece is built from. Shared by fetch-catalog.mjs, pack-catalog.mjs,
 * check-catalog.mjs and make-synthetic.mjs, so they cannot disagree.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAMILY } from '../src/catalog-format.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
  { id: 'military', query: 'GROUP=military', tagOnly: true }, // ~130
  { id: 'radar', query: 'GROUP=radar', tagOnly: true }, // ~40
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
 * So a family is a name pattern, a set of groups, or both. **First match wins**, so the
 * order here is the precedence. Anything unmatched is `FAMILY.NONE` and keeps the
 * whistle the piece started with.
 *
 * `kind` still decides what an object *is*: a Starlink rocket body is a machine and a
 * Starlink fragment is a shard. The family only chooses which bird a bird is.
 */
export const FAMILIES = [
  { value: FAMILY.STARLINK, name: /^STARLINK[- ]/i },
  { value: FAMILY.IRIDIUM, name: /^IRIDIUM[- ]/i },
  { value: FAMILY.MILITARY, groups: ['military', 'radar'] },
];

/** Every group whose membership some family reads. */
export const TAG_GROUPS = [...new Set(FAMILIES.flatMap((f) => f.groups ?? []))];

/**
 * Which family an object belongs to. `inGroup` answers whether a catalog number is in
 * a named group; the packer builds it from the tag sources.
 */
export function familyOf(name, catnr, inGroup) {
  for (const family of FAMILIES) {
    if (family.name && family.name.test(name)) return family.value;
    if (family.groups?.some((g) => inGroup(g, catnr))) return family.value;
  }
  return FAMILY.NONE;
}
