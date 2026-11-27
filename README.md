[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/encoderrrr/png-squeeze-27nov/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/encoderrrr/png-squeeze-27nov/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

# png-squeeze-27nov

Lossless PNG re-encoder for [make.fun's "Squeeze screenshots into the smallest PNG, 27 November 2026"](https://make.fun/bounty/png-squeeze-01-run-20261127) bounty (`png-squeeze-01-run-20261127`).

One program, `main.ts`, reads 8 screenshots of 1280x720 RGBA from `/input/<id>/image.png` and writes each one back as the smallest valid PNG it can, losslessly, in `/output/<id>/image.png` — inside one 60-second run, deterministically (two runs write the same bytes).

## How it squeezes

Per image:

1. **Decode** the stored RGBA PNG with its own decoder.
2. **Analyse** the pixels — opaque? grey? at most 256 distinct colours? — and build every lossless form the image can take:
   - palette (colour type 3) when it has at most 256 colours, in two entry orders (most frequent first, darkest first), transparent entries first so `tRNS` stays short;
   - grey (type 0) or grey+alpha (type 4) when every pixel is grey;
   - RGB (type 2) or RGBA (type 6) otherwise, with a `tRNS` key instead of an alpha channel when there is exactly one transparent value.
3. **Screen** every form: one pass filters each row five ways and scores three strategies at once (every row unfiltered, minimum signed sum, Laplace-entropy cost); the form whose best strategy deflates smallest at zlib level 6 wins.
4. **Refine** the winning form at level 6, and for one-byte-per-pixel forms also try brute force — each row's five filters weighed by actually deflating the row against the 32 KiB already written, so cross-row LZ77 matches count.
5. **Deflate** the winning filtered data and keep the smallest stream. The level follows the data: level 9 where its long match chains are fast and buy up to a tenth, level 7 where the filtered data holds few long matches and level 9 would crawl (the level-6 ratio shows which). Smaller memLevels and the filtered strategy are tried too.

Node 22 built-ins only (`node:fs`, `node:path`, `node:zlib`) — nothing installed, no network, no clock, no randomness.

## Results (kit scorer, practice set)

| | this entry | house baseline (fixed-paeth 1.0.0) |
| --- | --- | --- |
| total bytes, 8 images | 559,348 | 683,151 |
| score (of 1,000,000) | 707,896 | 420,399 |
| runtime | ~13 s | — |

On two freshly generated sets it scored 697,257 and 708,530 against baselines of 441,797 and 357,680, in 18–23 s per set — comfortably inside the 60-second wall.

## Run it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Licence

MIT — see [LICENSE](LICENSE).
