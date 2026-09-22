#!/usr/bin/env python3
"""
Cut the web fonts down to the characters this piece actually draws, and write the
committed woff2 files.

    pip install fonttools brotli
    python3 scripts/subset-fonts.py vendor/satoshi

`public/fonts/*.woff2` is **committed**, like `public/data/synthetic.bin` and for the
same reason: a fresh clone has to run, and there is no build step that could make a
font. So this script exists for exactly the reason `make-synthetic.mjs` does - a
binary in git needs the thing that made it in git beside it, or in six months nobody
knows how it was cut or how to cut it again.

The sources themselves are **not** committed. They are a few hundred KB of .otf per
weight and nothing reads them at runtime; download them from the foundry when a
re-cut is needed. `vendor/` is gitignored.

**The subset is ASCII, and that is not a gamble.** Every glyph the UI draws was
inventoried from the source strings - printable ASCII plus a handful of typographic
marks. The bulk of the panel's text is *catalogue names*, which are safe for a reason
about the format rather than about any particular snapshot: GP and OMM `OBJECT_NAME`
inherits the fixed-width ASCII field of TLE line 0, so `COSMOS 2553`, `USA 245
(KH-11)`, `SL-16 R/B` and `FENGYUN 1C DEB` are the shape of the whole catalogue.

And the failure mode is mild anyway. CSS falls through to the next family per
*codepoint*, so a character the subset lacks is drawn by the system font sitting
behind it in the stack - a glyph that does not match, never a tofu box.

Measured on the piece's own character set, per weight, woff2 (already Brotli, so
gzip adds nothing on the wire):

    ASCII + typographic marks     8.3 KB      <- this
    ASCII + all of Latin-1       12.4 KB      +4.1 KB a weight for names that
                                              the format cannot produce
"""

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "fonts"

# Printable ASCII, then the marks the UI draws that are not in it: degree (every
# elevation and azimuth in the panel), middle dot and em dash (separators), ellipsis
# (LOCATING..., building N orbits...), multiplication sign (the time rate) and the
# real minus (range rate). Everything else falls through to the system stack.
UNICODES = "U+0020-007E,U+00B0,U+00B7,U+2013,U+2014,U+2026,U+00D7,U+2212"

# `tnum` is what stops a changing number shifting its own neighbours sideways, and
# `kern`/`liga`/`calt` are what a face is drawn expecting. Everything else goes.
FEATURES = "kern,liga,tnum,calt"

# Weight -> the substring that picks that file out of the download. Two static
# weights beat one variable file here: measured 16.7 KB against 23.0, because two
# is all the design asks for.
WEIGHTS = {400: "regular", 700: "bold"}


def find(src: Path, want: str) -> Path:
    """The one file in `src` whose name carries `want`, ignoring case and italics."""
    hits = [
        p
        for p in sorted(src.iterdir())
        if p.suffix.lower() in {".otf", ".ttf", ".woff2"}
        and want in p.stem.lower()
        and "italic" not in p.stem.lower()
    ]
    if not hits:
        raise SystemExit(f"no {want} face in {src} (looked at .otf, .ttf, .woff2)")
    if len(hits) > 1:
        raise SystemExit(f"several {want} faces in {src}: {[p.name for p in hits]}")
    return hits[0]


def main() -> None:
    if not shutil.which("pyftsubset"):
        raise SystemExit("pyftsubset not found - pip install fonttools brotli")
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {sys.argv[0]} <directory of downloaded faces>")

    src = Path(sys.argv[1])
    if not src.is_dir():
        raise SystemExit(f"{src} is not a directory")

    OUT.mkdir(parents=True, exist_ok=True)
    for weight, want in WEIGHTS.items():
        face = find(src, want)
        out = OUT / f"satoshi-{weight}.woff2"
        subprocess.run(
            [
                "pyftsubset",
                str(face),
                f"--unicodes={UNICODES}",
                f"--layout-features={FEATURES}",
                "--flavor=woff2",
                f"--output-file={out}",
            ],
            check=True,
        )
        print(f"{face.name:>34}  ->  {out.name}  {out.stat().st_size:,} bytes")

    total = sum((OUT / f"satoshi-{w}.woff2").stat().st_size for w in WEIGHTS)
    print(f"{'':>34}      {'total':>16}  {total:,} bytes on the wire")


if __name__ == "__main__":
    main()
