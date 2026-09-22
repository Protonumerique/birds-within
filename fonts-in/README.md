# Drop the downloaded font here

Temporary, and **not** where fonts live. This folder is a hand-off: unzip the family
from the foundry, drop the whole folder in here, commit, and push.

    fonts-in/Satoshi_Complete/Fonts/OTF/Satoshi-Regular.otf
    fonts-in/Satoshi_Complete/Fonts/OTF/Satoshi-Bold.otf
    ...and whatever else the download contains - the rest is ignored

Then:

    pip install fonttools brotli
    npm run subset:fonts        # or: python3 scripts/subset-fonts.py fonts-in

`scripts/subset-fonts.py` finds Regular and Bold by name, skips the italics, cuts
them to the characters this piece actually draws, and writes
`public/fonts/satoshi-{400,700}.woff2` - about 8 KB each.

**This folder goes away once that has run.** The committed woff2 is what ships; the
few-hundred-KB sources are not worth carrying in git, and nothing reads them at
runtime. See the header of `scripts/subset-fonts.py` for why the subset is what it
is, and `vendor/` in `.gitignore` for where the originals belong on a machine that
can reach the foundry.
