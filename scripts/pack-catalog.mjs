#!/usr/bin/env node
/**
 * Turn .catalog-cache/ into the packed catalogues the browser loads -
 * public/data/active.bin and public/data/full.bin. Format: src/catalog-format.ts.
 *
 * Packing runs on every build, from the raw JSON, rather than caching the .bin
 * files themselves - so a change to the format can never meet a stale binary.
 *
 *   npm run pack:catalog
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { encodeCatalog } from '../src/catalog-format.ts';
import { CACHE_DIR, DATASETS, ROOT, TAG_GROUPS, familyOf } from './catalog-sources.mjs';

const NUMERIC = [
  'MEAN_MOTION',
  'ECCENTRICITY',
  'INCLINATION',
  'RA_OF_ASC_NODE',
  'ARG_OF_PERICENTER',
  'MEAN_ANOMALY',
  'BSTAR',
  'MEAN_MOTION_DOT',
  'MEAN_MOTION_DDOT',
];

const epochMs = (epoch) => Date.parse(epoch.endsWith('Z') ? epoch : `${epoch}Z`);
const kb = (bytes) => `${Math.round(bytes / 1024).toLocaleString('en').padStart(5)} KB`;

async function readSource(id) {
  const at = (file) => resolve(ROOT, CACHE_DIR, file);
  try {
    return {
      records: JSON.parse(await readFile(at(`${id}.json`), 'utf8')),
      meta: JSON.parse(await readFile(at(`${id}.meta.json`), 'utf8')),
    };
  } catch {
    throw new Error(`${CACHE_DIR}/${id}.json is missing - run \`npm run fetch:catalog\``);
  }
}

/** Keep only what the format carries, and reject a malformed record rather than pack a NaN. */
function project(raw) {
  const r = {
    OBJECT_NAME: String(raw.OBJECT_NAME ?? '').trim(),
    NORAD_CAT_ID: Number(raw.NORAD_CAT_ID),
    EPOCH: String(raw.EPOCH ?? ''),
  };
  for (const field of NUMERIC) r[field] = Number(raw[field]);

  const valid =
    Number.isInteger(r.NORAD_CAT_ID) &&
    r.NORAD_CAT_ID > 0 &&
    !Number.isNaN(epochMs(r.EPOCH)) &&
    NUMERIC.every((field) => Number.isFinite(r[field]));
  return valid ? r : null;
}

await mkdir(resolve(ROOT, 'public/data'), { recursive: true });
const sources = new Map();

// The group lists a family joins against, as sets of catalog numbers. Read once, and
// a missing one is not fatal: an untagged object sings the default voice, which is a
// quieter failure than stopping a deploy over a tag.
const groupMembers = new Map();
for (const id of TAG_GROUPS) {
  try {
    const { records } = await readSource(id);
    groupMembers.set(id, new Set(records.map((r) => Number(r.NORAD_CAT_ID))));
  } catch {
    groupMembers.set(id, new Set());
    console.warn(`  ${id.padEnd(8)}group list unavailable - nothing will be tagged from it`);
  }
}
const inGroup = (group, catnr) => groupMembers.get(group)?.has(catnr) ?? false;

for (const [name, ids] of Object.entries(DATASETS)) {
  const byCatnr = new Map();
  let rejected = 0;
  let oldestFetch = Infinity;

  for (const id of ids) {
    if (!sources.has(id)) sources.set(id, await readSource(id));
    const { records, meta } = sources.get(id);
    oldestFetch = Math.min(oldestFetch, Date.parse(meta.fetchedAt));

    for (const raw of records) {
      const r = project(raw);
      if (!r) {
        rejected++;
        continue;
      }
      // The same object appears in several datasets. Keep the newest elements.
      const seen = byCatnr.get(r.NORAD_CAT_ID);
      if (!seen || epochMs(r.EPOCH) > epochMs(seen.EPOCH)) byCatnr.set(r.NORAD_CAT_ID, r);
    }
  }

  // Which voice each object sings with. Decided here, once, and packed as a byte -
  // the browser never sees a name pattern or a group list.
  const families = { 0: 0 };
  for (const r of byCatnr.values()) {
    r.FAMILY = familyOf(r.OBJECT_NAME, r.NORAD_CAT_ID, inGroup);
    families[r.FAMILY] = (families[r.FAMILY] ?? 0) + 1;
  }

  // Stamped with the OLDEST fetch among its sources: "elements at least this fresh".
  const bytes = new Uint8Array(encodeCatalog([...byCatnr.values()], new Date(oldestFetch)));
  await writeFile(resolve(ROOT, 'public/data', `${name}.bin`), bytes);

  console.log(
    `  ${name.padEnd(8)}${String(byCatnr.size).padStart(7)} objects  ${kb(bytes.length)}  ${kb(gzipSync(bytes).length)} gzipped` +
      `  elements as of ${new Date(oldestFetch).toISOString().slice(0, 16)}Z` +
      (rejected ? `  (${rejected} malformed records skipped)` : '')
  );
  const tagged = Object.entries(families)
    .filter(([value]) => value !== '0')
    .map(([value, count]) => `${count} family ${value}`)
    .join(', ');
  console.log(`  ${' '.repeat(8)}${tagged || 'nothing tagged'}`);
}
