/**
 * The packed catalogue: CelesTrak OMM element sets as a columnar binary.
 *
 * Shared, unmodified, by the browser (decode) and scripts/fetch-catalog.mjs
 * (encode), so this file has no imports and uses only erasable TypeScript - Node
 * runs it directly with type stripping.
 *
 * Why OMM and not TLE: CelesTrak ran out of 5-digit catalog numbers on 2026-07-11,
 * and nothing catalogued since has a TLE at all. satellite.js builds a satrec from
 * OMM with `json2satrec`, so no TLE text is needed anywhere at runtime.
 *
 * Why columnar: similar values sit next to each other (whole megaconstellation
 * shells share an inclination), which is what gzip feeds on. Measured on the
 * `active` set, 16,563 objects: JSON 1,030 KB gzipped, row-oriented float64 895 KB,
 * columnar float64 814 KB, columnar with scaled integers 661 KB.
 *
 * Why scaled integers are safe: CelesTrak publishes angles to 4 decimals and
 * eccentricity and mean motion to 8. For such a value v, `round(v * s) / s` is the
 * double nearest to v, i.e. bit-identical to what JSON.parse produced. The encoder
 * does not assume this - it checks every value and falls back to float64 for any
 * field where one fails, recording the choice in the header. Round-tripping the
 * real catalogue through encode -> decode -> json2satrec gives identical satrecs.
 *
 * Epochs are stored as float64 milliseconds. json2satrec itself parses EPOCH with
 * `new Date()`, which keeps milliseconds only, so this loses nothing it would use.
 *
 * Layout, little-endian. Every section starts on an 8-byte boundary so the decoder
 * can view it as a typed array in place, without copying.
 *
 *   0  u32  magic 'BWCT'
 *   4  u16  format version
 *   6  u16  header size in bytes
 *   8  u32  object count N
 *  12  u32  names blob size in bytes
 *  16  f64  generated at, ms since 1970 - when the snapshot was fetched
 *  24  u16  field mask - bit i set: FIELDS[i] stored as scaled i32, else f64
 *  26  u16  reserved
 *  28  u32  reserved
 *  --- sections ---
 *       u32 x N     NORAD catalog number, delta from the previous (sorted ascending)
 *       f64 x N     epoch, ms since 1970
 *       per FIELD   i32 x N or f64 x N, per the field mask
 *       u8  x N     kind, see KIND
 *       u8  x N     family, see FAMILY
 *       u32 x N+1   name offsets into the blob
 *       u8  x names UTF-8 names
 */

export const MAGIC = 0x54435742; // 'BWCT' read as a little-endian u32
export const FORMAT_VERSION = 2;
const HEADER_BYTES = 32;

/** The OMM fields json2satrec reads, plus the name. */
export interface OmmElements {
  OBJECT_NAME: string;
  NORAD_CAT_ID: number;
  EPOCH: string;
  MEAN_MOTION: number;
  ECCENTRICITY: number;
  INCLINATION: number;
  RA_OF_ASC_NODE: number;
  ARG_OF_PERICENTER: number;
  MEAN_ANOMALY: number;
  BSTAR: number;
  MEAN_MOTION_DOT: number;
  MEAN_MOTION_DDOT: number;
}

/**
 * What the packer hands in: the elements, plus the tags it worked out.
 *
 * `OmmElements` stays exactly what `json2satrec` reads, so a tag can never leak into
 * a satrec. Anything the build decides about an object rides alongside instead.
 */
export interface PackedRecord extends OmmElements {
  /** Voice family, decided at build time. See FAMILY, and scripts/catalog-sources.mjs. */
  FAMILY?: number;
}

type NumericField = Exclude<keyof OmmElements, 'OBJECT_NAME' | 'NORAD_CAT_ID' | 'EPOCH'>;

/** Field order is part of the format. Scale 0 means always float64. */
const FIELDS: readonly (readonly [NumericField, number])[] = [
  ['INCLINATION', 1e4],
  ['RA_OF_ASC_NODE', 1e4],
  ['ARG_OF_PERICENTER', 1e4],
  ['MEAN_ANOMALY', 1e4],
  ['ECCENTRICITY', 1e8],
  ['MEAN_MOTION', 1e8],
  ['BSTAR', 0],
  ['MEAN_MOTION_DOT', 0],
  ['MEAN_MOTION_DDOT', 0],
];

/**
 * Coarse object kind, from the name alone.
 *
 * GP data carries no object type; SATCAT does, but joining it is a second dataset
 * for one byte. CelesTrak's naming convention is consistent enough to read density
 * composition from - which is what the image needs - but this is a heuristic, not a
 * classification: an unnamed fragment reads as OTHER.
 */
export const KIND = { OTHER: 0, ROCKET_BODY: 1, DEBRIS: 2 } as const;

/**
 * Which family of birds an object sings with. **Nothing here is guessed at runtime** -
 * the byte is decided by the build and packed, so the browser only reads it.
 *
 * Unlike `kind`, this is *not* a name heuristic across the board. Most of it is a join
 * on NORAD catalog number against CelesTrak's own published group lists, which is
 * exact; only the megaconstellations are taken from the name, where the convention is
 * absolute and the group file would be the biggest download in the pipeline. The rules
 * live in scripts/catalog-sources.mjs, which is the only place that knows them.
 *
 * Adding a family is a row in that table and a voice in AUDIO.performer.voices.
 */
export const FAMILY = {
  NONE: 0,
  STARLINK: 1,
  IRIDIUM: 2,
  MILITARY: 3,
  GNSS: 4,
  WEATHER: 5,
  SCIENCE: 6,
} as const;
export type Family = (typeof FAMILY)[keyof typeof FAMILY];
export type Kind = (typeof KIND)[keyof typeof KIND];

export function kindFromName(name: string): Kind {
  if (/\bDEB\b/.test(name)) return KIND.DEBRIS;
  if (/R\/B/.test(name)) return KIND.ROCKET_BODY;
  return KIND.OTHER;
}

/**
 * The choir: objects in the geosynchronous belt, which from any observer never rise
 * and never set. They hang at a fixed point in the southern sky (from the northern
 * hemisphere) for the life of the page.
 *
 * They break the idea of a pass, which is what the readout is for, so they are kept
 * out of it and given their own treatment. This is why the test is on the elements
 * rather than on range: a Molniya or Tundra orbit reaches the same distance at
 * apogee and *does* pass, slowly - the eccentricity is what tells them apart. A
 * half-synchronous navigation satellite (two revolutions a day) rises and sets like
 * anything else and is not in here either.
 *
 * The band is generous - roughly +/- 1300 km around the geostationary radius - so it
 * takes in the graveyard a few hundred kilometres above the belt, where retired
 * satellites are boosted, and the inclined ones left drifting when station-keeping
 * stopped. An object at the edge of the band does creep along the belt, about ten
 * degrees a day; at the timescale of a sky it is standing still.
 *
 * Physics, not taste, so the numbers live here rather than in config.ts - which
 * carries how the choir is drawn.
 */
export const GEOSYNCHRONOUS = {
  /** Revolutions per day. A sidereal day is 1.00274. */
  minRevsPerDay: 0.95,
  maxRevsPerDay: 1.05,
  /** Near-circular. Tundra is ~0.27, Molniya ~0.7, a geostationary transfer orbit ~0.73. */
  maxEccentricity: 0.05,
};

export function isGeosynchronous(elements: { MEAN_MOTION: number; ECCENTRICITY: number }): boolean {
  return (
    elements.MEAN_MOTION >= GEOSYNCHRONOUS.minRevsPerDay &&
    elements.MEAN_MOTION <= GEOSYNCHRONOUS.maxRevsPerDay &&
    elements.ECCENTRICITY <= GEOSYNCHRONOUS.maxEccentricity
  );
}

export interface PackedCatalog {
  version: number;
  count: number;
  /** When the snapshot was fetched. */
  generatedAt: Date;
  catnr: Uint32Array;
  epochMs: Float64Array;
  kind: Uint8Array;
  /** Voice family per object, decided by the build. See FAMILY. */
  family: Uint8Array;
  names: string[];
  /** Rebuild the OMM object json2satrec wants for object i. */
  elementsAt(i: number): OmmElements;
}

const align8 = (n: number) => (n + 7) & ~7;

function assertLittleEndian() {
  if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
    throw new Error('catalog-format: typed-array views assume a little-endian platform');
  }
}

export function encodeCatalog(input: readonly PackedRecord[], generatedAt: Date): ArrayBuffer {
  assertLittleEndian();
  const records = input.slice().sort((a, b) => a.NORAD_CAT_ID - b.NORAD_CAT_ID);
  const n = records.length;

  for (let i = 1; i < n; i++) {
    if (records[i]!.NORAD_CAT_ID === records[i - 1]!.NORAD_CAT_ID) {
      throw new Error(`catalog-format: duplicate NORAD_CAT_ID ${records[i]!.NORAD_CAT_ID}`);
    }
  }

  // Scale a field to i32 only if every value survives the round trip exactly.
  let mask = 0;
  FIELDS.forEach(([key, scale], bit) => {
    if (!scale) return;
    const exact = records.every((r) => {
      const scaled = Math.round(r[key] * scale);
      return Math.abs(scaled) < 2 ** 31 && scaled / scale === r[key];
    });
    if (exact) mask |= 1 << bit;
  });

  const utf8 = new TextEncoder();
  const nameBytes = records.map((r) => utf8.encode(r.OBJECT_NAME));
  const namesSize = nameBytes.reduce((sum, b) => sum + b.length, 0);

  const sizes = [
    4 * n,
    8 * n,
    ...FIELDS.map((_, bit) => (mask & (1 << bit) ? 4 : 8) * n),
    n, // kind
    n, // family
    4 * (n + 1),
    namesSize,
  ];
  const total = align8(sizes.reduce((off, size) => align8(off) + size, HEADER_BYTES));

  const buf = new ArrayBuffer(total);
  const header = new DataView(buf);
  header.setUint32(0, MAGIC, true);
  header.setUint16(4, FORMAT_VERSION, true);
  header.setUint16(6, HEADER_BYTES, true);
  header.setUint32(8, n, true);
  header.setUint32(12, namesSize, true);
  header.setFloat64(16, generatedAt.getTime(), true);
  header.setUint16(24, mask, true);

  let offset = HEADER_BYTES;
  const section = <T extends { byteLength: number }>(make: (at: number) => T): T => {
    offset = align8(offset);
    const view = make(offset);
    offset += view.byteLength;
    return view;
  };

  const catnr = section((at) => new Uint32Array(buf, at, n));
  let previous = 0;
  records.forEach((r, i) => {
    catnr[i] = r.NORAD_CAT_ID - previous;
    previous = r.NORAD_CAT_ID;
  });

  const epoch = section((at) => new Float64Array(buf, at, n));
  records.forEach((r, i) => {
    const ms = Date.parse(r.EPOCH.endsWith('Z') ? r.EPOCH : `${r.EPOCH}Z`);
    if (Number.isNaN(ms)) throw new Error(`catalog-format: bad EPOCH for ${r.NORAD_CAT_ID}: ${r.EPOCH}`);
    epoch[i] = ms;
  });

  FIELDS.forEach(([key, scale], bit) => {
    if (mask & (1 << bit)) {
      const col = section((at) => new Int32Array(buf, at, n));
      records.forEach((r, i) => (col[i] = Math.round(r[key] * scale)));
    } else {
      const col = section((at) => new Float64Array(buf, at, n));
      records.forEach((r, i) => (col[i] = r[key]));
    }
  });

  const kind = section((at) => new Uint8Array(buf, at, n));
  records.forEach((r, i) => (kind[i] = kindFromName(r.OBJECT_NAME)));

  // Rides on the record rather than being derived here: most of it comes from a join
  // against CelesTrak's group lists, which this file cannot see and must not import.
  const family = section((at) => new Uint8Array(buf, at, n));
  records.forEach((r, i) => (family[i] = r.FAMILY ?? FAMILY.NONE));

  const offsets = section((at) => new Uint32Array(buf, at, n + 1));
  const names = section((at) => new Uint8Array(buf, at, namesSize));
  let cursor = 0;
  nameBytes.forEach((bytes, i) => {
    offsets[i] = cursor;
    names.set(bytes, cursor);
    cursor += bytes.length;
  });
  offsets[n] = cursor;

  return buf;
}

export interface CatalogHeader {
  version: number;
  count: number;
  /** When the snapshot was fetched. */
  generatedAt: Date;
  namesSize: number;
  fieldMask: number;
  headerBytes: number;
}

/**
 * Validate and read just the header - cheap, so the render thread can check it was
 * handed a real catalogue before passing the bytes to the sky worker to decode.
 */
export function readCatalogHeader(buf: ArrayBuffer): CatalogHeader {
  const header = new DataView(buf);
  if (buf.byteLength < HEADER_BYTES || header.getUint32(0, true) !== MAGIC) {
    throw new Error('catalog-format: not a packed catalogue (bad magic)');
  }
  const version = header.getUint16(4, true);
  if (version !== FORMAT_VERSION) {
    throw new Error(`catalog-format: format version ${version}, this build reads ${FORMAT_VERSION}`);
  }
  return {
    version,
    count: header.getUint32(8, true),
    namesSize: header.getUint32(12, true),
    generatedAt: new Date(header.getFloat64(16, true)),
    fieldMask: header.getUint16(24, true),
    headerBytes: header.getUint16(6, true),
  };
}

export function decodeCatalog(input: ArrayBuffer | Uint8Array): PackedCatalog {
  assertLittleEndian();

  // Typed-array views need their byte offset aligned to the element size. A fetch()
  // ArrayBuffer always starts at 0; a Node Buffer is often a slice of a shared pool.
  let buf: ArrayBuffer;
  if (input instanceof Uint8Array) {
    buf = input.byteOffset % 8 === 0 && input.byteLength === input.buffer.byteLength
      ? (input.buffer as ArrayBuffer)
      : (input.slice().buffer as ArrayBuffer);
  } else {
    buf = input;
  }

  const { version, count: n, namesSize, generatedAt, fieldMask: mask, headerBytes } = readCatalogHeader(buf);

  let offset = headerBytes;
  const section = <T extends { byteLength: number }>(make: (at: number) => T): T => {
    offset = align8(offset);
    const view = make(offset);
    offset += view.byteLength;
    return view;
  };

  const catnrDelta = section((at) => new Uint32Array(buf, at, n));
  const epochMs = section((at) => new Float64Array(buf, at, n));
  const columns = FIELDS.map(([key, scale], bit) => {
    const scaled = (mask & (1 << bit)) !== 0;
    const col = section((at) => (scaled ? new Int32Array(buf, at, n) : new Float64Array(buf, at, n)));
    return { key, divisor: scaled ? scale : 1, col };
  });
  const kind = section((at) => new Uint8Array(buf, at, n));
  const family = section((at) => new Uint8Array(buf, at, n));
  const offsets = section((at) => new Uint32Array(buf, at, n + 1));
  const nameBlob = section((at) => new Uint8Array(buf, at, namesSize));

  const catnr = new Uint32Array(n);
  let running = 0;
  for (let i = 0; i < n; i++) catnr[i] = running += catnrDelta[i]!;

  const utf8 = new TextDecoder();
  const names = new Array<string>(n);
  for (let i = 0; i < n; i++) names[i] = utf8.decode(nameBlob.subarray(offsets[i]!, offsets[i + 1]!));

  return {
    version,
    count: n,
    generatedAt,
    catnr,
    epochMs,
    kind,
    family,
    names,
    elementsAt(i) {
      const out = {
        OBJECT_NAME: names[i]!,
        NORAD_CAT_ID: catnr[i]!,
        EPOCH: new Date(epochMs[i]!).toISOString(),
      } as OmmElements;
      for (const { key, divisor, col } of columns) out[key] = col[i]! / divisor;
      return out;
    },
  };
}
