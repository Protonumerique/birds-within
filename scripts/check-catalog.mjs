#!/usr/bin/env node
/**
 * Gate before publishing: are the packed catalogues sane, and does every object
 * decode to exactly the satrec its raw CelesTrak record gives?
 *
 * deploy.yml runs this between packing and building. A failure stops the deploy
 * and the previous one stays live - a stale sky is better than a wrong one.
 *
 *   npm run check:catalog
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { json2satrec } from 'satellite.js';
import { FAMILY, decodeCatalog, KIND } from '../src/catalog-format.ts';
import { CACHE_DIR, DATASETS, ROOT } from './catalog-sources.mjs';

/** 16,563 on 2026-09-13. Far fewer means a truncated or partial download. */
const MIN_ACTIVE = 10_000;
/** Elements degrade over days. Past a week the sky is visibly wrong. */
const MAX_AGE_DAYS = 7;
/** Real data had 2 SGP4 init errors in 16,563. */
const MAX_INIT_ERROR_RATE = 0.01;

const SATREC_FIELDS = ['no', 'ecco', 'inclo', 'nodeo', 'argpo', 'mo', 'bstar', 'ndot', 'nddot', 'jdsatepoch'];
const failures = [];
const epochMs = (epoch) => Date.parse(epoch.endsWith('Z') ? epoch : `${epoch}Z`);

async function check(name) {
  let bytes;
  try {
    bytes = await readFile(resolve(ROOT, 'public/data', `${name}.bin`));
  } catch {
    failures.push(`${name}.bin is missing${DATASETS[name] ? ' - run `npm run fetch:catalog`' : ''}`);
    return null;
  }

  const cat = decodeCatalog(bytes);
  let initErrors = 0;
  const satrecs = new Array(cat.count);
  for (let i = 0; i < cat.count; i++) {
    satrecs[i] = json2satrec({ ...cat.elementsAt(i), OBJECT_ID: '', ELEMENT_SET_NO: 0 });
    if (satrecs[i].error) initErrors++;
  }

  const kinds = { other: 0, rocket: 0, debris: 0 };
  for (const k of cat.kind) {
    if (k === KIND.DEBRIS) kinds.debris++;
    else if (k === KIND.ROCKET_BODY) kinds.rocket++;
    else kinds.other++;
  }

  // Families are cosmetic - an untagged object sings the default voice - so a thin
  // one is reported and not fatal. All of them empty means the mechanism broke, and
  // that is worth stopping for. Checked on `full` only; `active` is a subset of it.
  const families = new Map();
  for (const f of cat.family) families.set(f, (families.get(f) ?? 0) + 1);
  const tagged = cat.count - (families.get(FAMILY.NONE) ?? 0);
  const byFamily = [...families]
    .filter(([f]) => f !== FAMILY.NONE)
    .sort((a, b) => b[1] - a[1])
    .map(([f, n]) => `${n} in family ${f}`)
    .join(', ');

  const ageDays = (Date.now() - cat.generatedAt.getTime()) / 86_400_000;
  console.log(
    `  ${name.padEnd(9)}${String(cat.count).padStart(7)} objects  ` +
      `${kinds.debris} debris / ${kinds.rocket} rocket bodies / ${kinds.other} other  ` +
      `SGP4 init errors ${initErrors}  elements ${ageDays.toFixed(1)} days old\n` +
      `  ${' '.repeat(9)}${byFamily || 'no families tagged'}`
  );

  if (name === 'full' && tagged === 0) {
    failures.push(
      'full.bin has no object in any family - the tagging in scripts/catalog-sources.mjs ' +
        'reached nothing, so every bird would sing the same voice'
    );
  }

  if (initErrors / cat.count > MAX_INIT_ERROR_RATE) {
    failures.push(`${name}: ${initErrors} of ${cat.count} element sets fail SGP4 init`);
  }
  if (DATASETS[name] && ageDays > MAX_AGE_DAYS) {
    failures.push(`${name}: elements are ${ageDays.toFixed(1)} days old (limit ${MAX_AGE_DAYS})`);
  }

  // Exact round trip against the raw JSON the binary was packed from.
  if (DATASETS[name]) {
    const raw = new Map();
    for (const id of DATASETS[name]) {
      let records;
      try {
        records = JSON.parse(await readFile(resolve(ROOT, CACHE_DIR, `${id}.json`), 'utf8'));
      } catch {
        failures.push(`${name}: ${CACHE_DIR}/${id}.json missing, cannot verify the round trip`);
        return cat;
      }
      for (const r of records) {
        const list = raw.get(Number(r.NORAD_CAT_ID)) ?? [];
        list.push(r);
        raw.set(Number(r.NORAD_CAT_ID), list);
      }
    }

    let mismatched = 0;
    for (let i = 0; i < cat.count; i++) {
      const source = raw.get(cat.catnr[i])?.find((r) => epochMs(r.EPOCH) === cat.epochMs[i]);
      const expected = source && json2satrec(source);
      const same = expected && SATREC_FIELDS.every((f) => satrecs[i][f] === expected[f] || (Number.isNaN(satrecs[i][f]) && Number.isNaN(expected[f])));
      if (!same) {
        if (mismatched < 5) failures.push(`${name}: object ${cat.catnr[i]} (${cat.names[i]}) does not round-trip`);
        mismatched++;
      }
    }
    if (mismatched > 5) failures.push(`${name}: ...and ${mismatched - 5} more round-trip mismatches`);
  }

  return cat;
}

console.log('packed catalogues');
const results = {};
for (const name of [...Object.keys(DATASETS), 'synthetic']) results[name] = await check(name);

if (results.active && results.active.count < MIN_ACTIVE) {
  failures.push(`active: only ${results.active.count} objects (expected at least ${MIN_ACTIVE})`);
}
if (results.active && results.full && results.full.count < results.active.count) {
  failures.push(`full (${results.full.count}) is smaller than active (${results.active.count})`);
}

if (failures.length) {
  console.error(`\n${failures.length} problem(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('\nall catalogues decode exactly and look sane');
