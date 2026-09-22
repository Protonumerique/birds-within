# The typeface

**Satoshi**, by the **Indian Type Foundry**. Copyright 2017–2021 Indian Type Foundry,
all rights reserved. Satoshi is a trademark of the Indian Type Foundry.

Licensed under the ITF Free Font Licence — <https://fontshare.com/terms>. That licence
asks that the fonts be identified by name and the foundry's ownership credited in any
design or production credits, which is what this file is for.

**Not covered by the repository's AGPL**, the same way `public/data/SOURCES.md` carves
out the element sets. The code is ours to license; the typeface is not.

## What is here

`satoshi-400.woff2` and `satoshi-700.woff2`, cut from the two static faces down to the
characters this piece actually draws — 7.1 and 7.0 KB, **14.1 KB for the pair**. The
originals are 73 KB each and are **not** committed; `vendor/` is gitignored.

Regenerate with `npm run subset:fonts` after putting the downloaded faces in
`vendor/satoshi/`. `scripts/subset-fonts.py` documents every choice in it: why the
subset is ASCII, why two static weights rather than one variable file, and what each
retained OpenType feature costs in bytes.

Source: <https://www.fontshare.com/fonts/satoshi>. A cloud session needs
`fontshare.com` and `*.fontshare.com` on its environment's allowed-domains list to
reach it — the default **Trusted** level does not include them.
