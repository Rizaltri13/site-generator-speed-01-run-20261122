[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Rizaltri13/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Rizaltri13/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

# site-generator-speed-01 — a faster drop-in for makefun-site 1.0.0

Entry for the [make.fun bounty **site-generator-speed-01-run-20261122**](https://make.fun/bounty/site-generator-speed-01-run-20261122) — "Build a static site faster": write a faster drop-in for make.fun's own `makefun-site 1.0.0` that answers exactly as it does on every case.

`solve.js` is a dependency-free ES module whose `run(input)` returns the output tree
`makefun-site 1.0.0`'s `build` returns for one site — every page's `index.html`, the index
and tag pages, `build-report.txt` and each static file, byte for byte. `main.ts` is the
program the harness runs: it reads every case from `/input/cases.json`, answers each with
`run`, and writes `/output/answers.json`.

## How it is faster

The reference pipeline is kept (sources, front matter, permalinks, Markdown, collections,
tags, layouts, report) but its hot paths are rewritten:

- **Inline Markdown** is scanned for its next special character with one native regex search
  instead of being escaped one character at a time (the reference calls a regex escape per
  character — where most of its time goes).
- **The Markdown lexer and renderer are a single pass** over the lines: no token objects, no
  re-splitting the body, and paragraph continuation is decided from the line's first character
  instead of four regex tests per line.
- **Slugs and long dates are memoised per case** (titles and tag names repeat constantly),
  and word counting runs over the body lines with no allocation.
- **The template renderer reuses one scope frame per loop** instead of one per element, and
  renders straight into a shared string array.
- **Code blocks are escaped in one pass** over the joined body.

Nothing is cached from one case to the next: every per-case memo lives inside one `run()`
call.

## Local check

```sh
# practice set, through the same driver the harness uses:
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
# then score it with the kit's sealed scorer:
MAKEFUN_OUTPUT_DIR=/tmp/out MAKEFUN_REFERENCE_DIR=<kit>/practice/reference \
  MAKEFUN_SCORES_DIR=/tmp/scores node <kit>/program/scorer/main.ts
```

## License

MIT — see [LICENSE](LICENSE).
