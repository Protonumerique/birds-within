#!/usr/bin/env node
/**
 * Generate public/data/synthetic.bin: ~1700 INVENTED orbits - plausible LEO shells
 * plus a geosynchronous belt - in the packed catalogue format.
 *
 * It is the development fallback and nothing else. Nothing in it is a real object,
 * and no conclusion about where anything actually is may be drawn from it. The dev
 * server loads it only when the real catalogue has not been fetched, and the HUD
 * says "synthetic" whenever it is on screen. Production never falls back to it.
 *
 * Deterministic and committed, so a fresh clone runs offline with no network and
 * no generation step. Drag terms are zero so the orbits never decay: this file has
 * to look like a sky for years, not for the week real elements are good for.
 *
 * Ported from the original Python generator, which could not run everywhere the
 * project is developed. Same shells, same construction; a different random stream,
 * so the individual orbits differ.
 *
 *   npm run make:synthetic
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FAMILY, encodeCatalog } from '../src/catalog-format.ts';
import { ROOT, familyOf } from './catalog-sources.mjs';

const MU = 398600.4418; // km^3/s^2
const R_EARTH = 6378.137; // km
const EPOCH = new Date(Date.UTC(2026, 8, 12));

/** mulberry32: small, seedable, identical on every platform. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = seeded(20260912);
const uniform = (lo, hi) => lo + (hi - lo) * random();
const wrap360 = (deg) => ((deg % 360) + 360) % 360;
/** The packed format stores angles to 4 decimals and ecc / mean motion to 8, exactly. */
const fixed = (x, digits) => Number(x.toFixed(digits));

/** Revolutions per day for a circular orbit at this altitude. */
const meanMotion = (altitudeKm) => 86400 / (2 * Math.PI * Math.sqrt((R_EARTH + altitudeKm) ** 3 / MU));

/**
 * count, altitude km, inclination deg, name, family.
 *
 * **The names are not decoration.** Two of these shells are named so that the family
 * rules in catalog-sources.mjs match them by exactly the path production takes, which
 * is the only way the voices are exercisable offline - the same principle that put a
 * synthetic belt in this file. The altitudes and inclinations are the real ones for
 * those constellations, so the shells look like what they are pretending to be.
 *
 * The military family is the exception, and has to be: it is a join against a group
 * list CelesTrak publishes, and there is no group list offline. Those records are
 * tagged **explicitly** here, which is a stand-in for the join and not a second rule.
 */
const SHELLS = [
  [700, 550, 53.0, 'STARLINK', null], // the real Starlink shell, tagged by name
  [250, 780, 86.4, 'IRIDIUM', null], // the real Iridium shell, tagged by name
  [200, 1200, 87.9, 'COSMOS', FAMILY.MILITARY], // near-polar; stands in for the group join
  [150, 800, 98.6, 'SSO', null], // sun-synchronous, untagged: the default whistle
  [200, null, null, 'SYNTH DEB', null], // broad spread; named so kindFromName reads it as debris
  /*
   * **Spent stages, and this file had none until 2026-09-21.** `kindFromName` reads
   * R/B, nothing here carried it, and the consequence was that the `machine` voice -
   * the regular knock under the birdsong - could not be heard offline at all. Anyone
   * developing against the synthetic sky heard payloads and debris and concluded the
   * wreckage was all one calm texture, which is exactly what happened.
   *
   * Over-represented at ~9%, on the same argument that put 240 belt objects in here:
   * a dev sky has to show the thing being worked on. The real `full` catalogue is a
   * few per cent rocket bodies.
   */
  [120, null, null, 'SYNTH R/B', null],
  /*
   * **Semi-synchronous, and the only thing here that is genuinely far.** Everything
   * else that passes tops out at 1,400 km, so `AUDIO.performer.byRange` - which only
   * starts attenuating past 1,500 km - was inaudible on this sky and could not be
   * judged offline at all. The real catalogue has the four navigation constellations
   * at ~20,000 km, plus Molniya orbits reaching further at apogee.
   *
   * GPS altitude and inclination. At 2.004 revolutions a day it sits well outside
   * `isGeosynchronous`'s 0.95-1.05 window, so it stays a **pass** and goes to the
   * performers rather than the belt - which is the point of putting it here.
   *
   * **Tagged GNSS since 2026-09-23**, when navigation got a voice of its own. It was
   * already the navigation shell in everything but the byte; leaving it untagged meant
   * the one low boom in the piece could not be heard offline.
   */
  [60, 20200, 55.0, 'SYNTH NAV', FAMILY.GNSS],
  /*
   * **Weather and science, added 2026-09-23 with their voices.** Both are joins
   * against CelesTrak group lists, so like the military shell they are tagged
   * explicitly here - there is no group list offline.
   *
   * Heavily over-represented, and deliberately: they are the two smallest families on
   * the real sky, 69 and 45 objects out of 20,990, which is 0.3% and 0.2%. At that
   * share a 1,859-object dev catalogue would carry six and four, and whether the two
   * songbird voices actually differ is not a question four objects can answer. The
   * same argument put 240 belt objects and 120 rocket bodies in here.
   *
   * Real orbits for both: polar sun-synchronous for the weather platforms, and a
   * mid-inclination low orbit for the science ones.
   */
  [40, 830, 98.7, 'SYNTH WX', FAMILY.WEATHER],
  [30, 600, 45.0, 'SYNTH SCI', FAMILY.SCIENCE],
];

const records = [];
let catnr = 90000;

for (const [count, altitude, inclination, label, family] of SHELLS) {
  // Walker-like: spread planes in RAAN, spread objects within each plane.
  const planes = Math.max(1, Math.round(Math.sqrt(count)));
  const perPlane = Math.max(1, Math.floor(count / planes));

  for (let p = 0; p < planes; p++) {
    for (let k = 0; k < perPlane; k++) {
      catnr++;
      const alt = altitude ?? uniform(380, 1400);
      const inc = inclination ?? uniform(0, 105);

      records.push({
        OBJECT_NAME: `${label}-${catnr}`,
        NORAD_CAT_ID: catnr,
        // By name where production would match by name, explicitly where it would join.
        FAMILY: family ?? familyOf(`${label}-${catnr}`, catnr, () => false),
        EPOCH: EPOCH.toISOString(),
        INCLINATION: fixed(inc, 4),
        RA_OF_ASC_NODE: fixed(wrap360((p / planes) * 360 + uniform(-1.5, 1.5)), 4) % 360,
        ARG_OF_PERICENTER: fixed(uniform(0, 360), 4) % 360,
        MEAN_ANOMALY: fixed(wrap360((k / perPlane) * 360 + p * 11 + uniform(-1.5, 1.5)), 4) % 360,
        ECCENTRICITY: fixed(uniform(2e-7, 9e-5), 8),
        MEAN_MOTION: fixed(meanMotion(alt) * uniform(0.9995, 1.0005), 8),
        BSTAR: 0,
        MEAN_MOTION_DOT: 0,
        MEAN_MOTION_DDOT: 0,
      });
    }
  }
}

/*
 * **A stand-in for the ISS, carrying the real catalog number.**
 *
 * `FEATURED` joins on 25544, and the join happens in the worker at init - so without a
 * 25544 in here, nothing offline draws a featured mark, a featured orbit, or exercises
 * the second track layer at all. The elements are invented like everything else in this
 * file; the *number* is real, so the join runs by exactly the path production takes.
 * That is the same trick the Starlink and Iridium shells use with their names.
 *
 * ISS altitude and inclination, so its passes look like the real thing's - high and
 * frequent from the mid-latitudes, which is why it is worth featuring.
 */
records.push({
  OBJECT_NAME: 'ISS (ZARYA)',
  NORAD_CAT_ID: 25544,
  FAMILY: familyOf('ISS (ZARYA)', 25544, () => false),
  EPOCH: EPOCH.toISOString(),
  INCLINATION: fixed(51.64, 4),
  RA_OF_ASC_NODE: fixed(117.3, 4),
  ARG_OF_PERICENTER: fixed(88.5, 4),
  MEAN_ANOMALY: fixed(271.7, 4),
  ECCENTRICITY: fixed(4.2e-4, 8),
  MEAN_MOTION: fixed(meanMotion(420), 8),
  BSTAR: 0,
  MEAN_MOTION_DOT: 0,
  MEAN_MOTION_DDOT: 0,
});

/**
 * The choir: a synthetic geosynchronous belt.
 *
 * Without one, nothing in development exercises the code that keeps the belt out of
 * the readout, rings it blue and gives it no track - the whole distinction would be
 * invisible until the real catalogue was fetched.
 *
 * Deliberately over-represented. The real belt is a few per cent of the catalogue;
 * here it is nearer fifteen, because a dev sky has to *show* the thing being worked
 * on. As with everything in this file, nothing may be concluded from it.
 *
 * At these inclinations the ascending node is degenerate - an orbit in the equatorial
 * plane has no meaningful node - so the slot around the ring is really
 * RAAN + ARGP + MEAN_ANOMALY. Pinning the first two at zero makes the mean anomaly
 * the longitude outright, which spreads the belt evenly and predictably.
 */
const CHOIR_COUNT = 240;

for (let k = 0; k < CHOIR_COUNT; k++) {
  catnr++;
  // One in ten sits in the graveyard a few hundred kilometres above the belt, where
  // retired satellites are boosted, carrying the inclination left behind when
  // station-keeping stopped.
  const retired = k % 10 === 0;
  const alt = retired ? uniform(36_050, 36_350) : 35_786 + uniform(-25, 25);
  const inc = retired ? uniform(0.5, 12) : uniform(0.01, 0.6);

  records.push({
    OBJECT_NAME: `SYNTH GEO ${catnr}`,
    NORAD_CAT_ID: catnr,
    EPOCH: EPOCH.toISOString(),
    INCLINATION: fixed(inc, 4),
    RA_OF_ASC_NODE: 0,
    ARG_OF_PERICENTER: 0,
    MEAN_ANOMALY: fixed(wrap360((k / CHOIR_COUNT) * 360 + uniform(-0.6, 0.6)), 4) % 360,
    ECCENTRICITY: fixed(uniform(2e-7, 9e-5), 8),
    MEAN_MOTION: fixed(meanMotion(alt), 8),
    BSTAR: 0,
    MEAN_MOTION_DOT: 0,
    MEAN_MOTION_DDOT: 0,
  });
}

const bytes = new Uint8Array(encodeCatalog(records, EPOCH));
await writeFile(resolve(ROOT, 'public/data/synthetic.bin'), bytes);
console.log(`synthetic.bin: ${records.length} invented objects, ${Math.round(bytes.length / 1024)} KB`);
