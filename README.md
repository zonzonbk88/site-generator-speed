# site-generator-speed — a faster makefun-site

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/zonzonbk88/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/zonzonbk88/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A dependency-free reimplementation of make.fun's **makefun-site 1.0.0** static
site generator that returns the reference build's output tree — every page's
`index.html`, the index and tag pages, `build-report.txt` and each static
file, byte for byte — in a fraction of the CPU time.

Entry for the make.fun bounty
[site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122).

## Layout

- `main.ts` — the driver the harness runs: reads every case from
  `/input/cases.json`, answers each with `run()` from `solve.js`, and writes
  `/output/answers.json`. Outside a container, `MAKEFUN_INPUT_DIR` and
  `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`. It turns V8's
  incremental marking off before `solve.js` is imported, as the house
  baseline does.
- `solve.js` — the whole generator in one ES module: front matter, permalinks
  and slug rules, the Markdown subset, collections and tags, the template
  dialect, layouts and the build report. No dependencies, no state between
  calls: each `run(input)` answers one case alone.
- `package.json` — `{ "type": "module" }`.

## Run it

```sh
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output node main.ts
```

`input/cases.json` is a JSON array of `{ "id", "input" }`, each input a site:
`{ site: { title, base_url, per_page, recent }, templates: { name: source },
files: [{ path, content }] }`. The output is a JSON array of answers, one per
case in order, each an object of output path → file text.

## How it is faster

Same dialect, same answers; the speed comes from doing less work per byte:

- **Line scanners, not regex batteries.** The Markdown lexer dispatches on a
  line's first character and hand-checks headings, breaks, fences and list
  markers, where the reference runs several regular expressions per line.
- **One-pass inline rendering.** Plain text is scanned once, with HTML
  escaping fused into the scan, instead of a character-at-a-time loop plus a
  separate escape pass.
- **Includes spliced at parse time.** Each template's `{% include %}`s are
  expanded once per build, with the same depth-8 cut-off the renderer
  applies, so rendering a page walks one flat node list; adjacent text nodes
  are merged while parsing.
- **Per-build caches.** Slugs, long dates and link resolutions repeat across
  a site's pages and are memoised for the duration of one `run()` — never
  across cases.
- **Leaner bookkeeping.** Front matter is scanned without splitting the
  whole file, cards are built once per page, word counts use a tight scan,
  and files without `\r` skip line-ending normalisation.

## Verification

Checked locally against the kit's own generator and oracle: the 3 practice
cases and 48 further generated cases (16 fresh seeds × 3) all come out
byte-identical to makefun-site 1.0.0's answers. On the practice set the
`run()` CPU time measures about **2.2–2.4× faster** than the vendored
reference build on the same machine (whole-process runs of the driver
included: ~0.85 s vs ~1.25 s user CPU for the 3 practice cases).
