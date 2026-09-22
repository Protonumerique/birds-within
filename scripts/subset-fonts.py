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
re-cut is needed - `vendor/` is gitignored for exactly that. Satoshi's two static
faces live at api.fontshare.com; a cloud session needs `fontshare.com` and
`*.fontshare.com` on its environment's allowed-domains list to reach them.

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

# `tnum` is what stops a changing number shifting its own neighbours sideways - the
# panel's data line rewrites itself every frame, and in Satoshi's proportional figures
# a 1 is narrower than a 0, so without it the whole line dances. `case` lifts hyphens
# and parentheses to sit against capitals, which is most of what the panel is:
# `USA 245 (KH-11)`, `SL-16 R/B`. `kern` and `liga` are what any face is drawn
# expecting.
#
# Measured on Satoshi Regular, over this exact character set: kern+liga alone is
# 6,816 bytes, tnum costs 284 more, and case costs **nothing at all** - it reuses
# glyphs already in the subset. Everything else the face carries (fractions,
# ordinals, superiors, four stylistic sets) goes.
#
# Keeping a feature here only makes it *available*; applying it is the stylesheet's
# job, through font-variant-numeric and font-feature-settings.
FEATURES = "kern,liga,tnum,case"

# Weight -> the substring that picks that file out of the download. Two static
# weights beat one variable file here: measured 16.7 KB against 23.0, because two
# is all the design asks for.
WEIGHTS = {400: "regular", 700: "bold"}


def find(src: Path, want: str) -> Path:
    """
    The face in `src` that carries `want` in its name, searched recursively.

    A foundry download is a zip of the same family several times over - OTF, TTF, a
    variable file and ready-made webfonts, each in its own folder - so this has to
    choose rather than complain. Static beats variable (the design wants two weights,
    and two statics measured 16.7 KB against 23.0 for one variable file), outline
    beats an already-cut webfont, and a shallower path beats a deeper one.
    """
    order = {".otf": 0, ".ttf": 1, ".woff2": 2}
    hits = [
        p
        for p in sorted(src.rglob("*"))
        if p.suffix.lower() in order
        and want in p.stem.lower()
        and "italic" not in p.stem.lower()
        and "variable" not in str(p).lower()
    ]
    if not hits:
        raise SystemExit(
            f"no {want} face under {src} - looked for .otf, .ttf and .woff2 "
            f"with '{want}' in the name, skipping italics and variable files"
        )
    return min(hits, key=lambda p: (order[p.suffix.lower()], len(p.parts)))


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
