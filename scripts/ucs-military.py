#!/usr/bin/env python3
"""
Derive the military catalog numbers from the UCS Satellite Database, and write the
committed list `scripts/ucs-military.json` that `catalog-sources.mjs` joins against.

    pip install openpyxl
    python3 scripts/ucs-military.py "UCS-Satellite-Database-Officialname 5-1-2023.xlsx"

**Why this exists at all.** CelesTrak publishes no military group worth the name. What
`GROUP=military` actually is, checked on 2026-09-22, is a leftover bucket of 24 - 22
Praetorian SDA, SAR-Lupe 2, Sapphire, Victus Haze Puma - so the family was carried by
two name rules of our own invention. Those work, but they are our editorial judgement
rather than anyone's classification, which is the one thing the rest of `FAMILIES`
exists to avoid. The UCS database is a published, sourced classification, and it
carries a **NORAD Number** column, which is what makes it joinable the way everything
else here is joined.

**The rule is `Users` mentioning Military**, which is 613 of 7,560 rows. UCS writes
that column as one or more of Civil / Commercial / Government / Military, so the 458
plain "Military" rows are joined by 82 "Military/Commercial" (Amos, Cosmos 2520), 56
"Military/Government" (the Beidou navigation series) and a handful of other pairings.
Those are genuinely military-used spacecraft under UCS's own reading, and taking only
the pure rows would be us second-guessing the source again.

**Every number is kept, not just the ones still on orbit.** Filtering against today's
catalogue here would bake one afternoon's fetch into a committed file; the join at pack
time does that filtering for free, every deploy, and stays right as objects decay.

**The spreadsheet itself is not committed**, on the same arrangement as `vendor/` and
the typeface: it is someone else's data under its own terms, and what this project
needs from it is a list of integers. A list of catalog numbers is a join key rather
than a copy of the database. `public/data/SOURCES.md` carries the credit.

**It is a frozen snapshot, and that is the one real cost.** UCS stopped at 1 May 2023.
Measured on the catalogue of 2026-09-22: 57.9% of the 20,992 objects up there launched
in 2023 or later, and 56 of our 164 YAOGAN postdate the snapshot. So this **supplements**
the name rules and must never replace them - the list gives breadth, the name rules give
currency. `snapshot` is written into the output so the staleness is visible rather than
inferred.
"""

import json
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "scripts" / "ucs-military.json"

# The 1 May 2023 edition, which is the last one UCS published.
SNAPSHOT = "2023-05-01"

NAME_COL = "Current Official Name of Satellite"
USERS_COL = "Users"
CATNR_COL = "NORAD Number"


def catnr(value):
    """The NORAD number as an int, or None if the cell cannot give one."""
    text = ("" if value is None else str(value)).strip()
    if text.endswith(".0"):  # openpyxl hands back floats for integer cells
        text = text[:-2]
    return int(text) if re.fullmatch(r"\d+", text) else None


def main() -> None:
    try:
        import openpyxl
    except ImportError:
        raise SystemExit("openpyxl not found - pip install openpyxl")
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {sys.argv[0]} <UCS database .xlsx>")

    book = openpyxl.load_workbook(sys.argv[1], read_only=True, data_only=True)
    rows = book["Sheet1"].iter_rows(values_only=True)
    header = [("" if c is None else str(c)).strip() for c in next(rows)]
    try:
        at = {name: header.index(name) for name in (NAME_COL, USERS_COL, CATNR_COL)}
    except ValueError as missing:
        raise SystemExit(f"not the UCS database - {missing}")

    total = military = unusable = 0
    catnrs = set()
    for row in rows:
        if row is None or row[at[NAME_COL]] is None:
            continue
        total += 1
        users = ("" if row[at[USERS_COL]] is None else str(row[at[USERS_COL]])).lower()
        if "military" not in users:
            continue
        military += 1
        number = catnr(row[at[CATNR_COL]])
        if number is None:
            unusable += 1
            continue
        catnrs.add(number)

    if not catnrs:
        raise SystemExit("no military rows found - is this the right workbook?")

    OUT.write_text(
        json.dumps(
            {
                "source": "UCS Satellite Database",
                "url": "https://www.ucsusa.org/resources/satellite-database",
                "snapshot": SNAPSHOT,
                "derived": date.today().isoformat(),
                "rule": f"{USERS_COL} mentions Military",
                "rows": total,
                "matched": military,
                "catnrs": sorted(catnrs),
            },
            indent=1,
        )
        + "\n"
    )
    print(f"{total:,} rows, {military:,} military, {len(catnrs):,} catalog numbers")
    if unusable:
        print(f"  {unusable} matched rows had no usable NORAD number and were dropped")
    print(f"  -> {OUT.relative_to(ROOT)}  {OUT.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
