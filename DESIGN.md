# MathSearch — design and development

The detailed companion to [README.md](README.md), which is only the
introduction and quick start. This document covers the folder layout, the
full setup, every panel feature, how the search works, configuration and known limitations.

## Contents

- [Folder layout](#folder-layout)
- [Setup from source](#setup-from-source)
- [Using it (full reference)](#using-it-full-reference)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Known limitations](#known-limitations)

---

## Folder layout

```
mathsearch/
├── manifest.json            MV3 manifest — empty permissions list
├── background.js            Opens the bundled viewer when the toolbar icon is clicked
├── viewer-snippet.html      The script tags added to PDF.js's viewer.html
├── src/
│   ├── config.js            Every tunable constant, with the calibration notes
│   ├── controller.js        Orchestrator + bootstrap (entry point, ES module)
│   ├── panel.js             Floating UI: input, KaTeX preview, scope, threshold, results
│   ├── snip.js              Drag a rectangle over a page to search for what is in it
│   ├── template.js          Rendered canvas or page region → binarised template; shared binarize()
│   ├── pageindex.js         Offscreen page rendering + per-page cache (compact runs + components)
│   ├── segmentation.js      Connected components + clusters of a binary page
│   ├── matching.js          Component-anchored chamfer matcher (pure; runs in Node too)
│   ├── bookindex.js         Search order, the book's index, text direction (DOM-free)
│   └── overlay.js           Highlight canvases on PDF.js page divs, scroll-to-match
├── icons/                   Toolbar and store icons (16, 32, 48, 128 px)
├── guide/                   The user guide that opens by default (LaTeX source + PDF)
├── scripts/
│   ├── build.mjs            npm run setup / npm run build (see below)
│   ├── vendor.json          PDF.js, KaTeX, html2canvas: pinned versions and SHA-256
│   └── check-viewer.mjs     npm run check-viewer: are the viewer edits in place?
├── lib/                     made by npm run setup: pdfjs/, katex/, html2canvas/
├── LICENSE                  MIT (our code)
├── THIRD_PARTY_NOTICES.md   Licenses of the bundled code and fonts
├── PRIVACY.md               No data collected, no network access
├── CHANGELOG.md
└── package.json             npm scripts; the build and test tools are dev dependencies
```

`src/segmentation.js`, `src/matching.js` and the pure parts of
`src/template.js` never touch the DOM, so they run unchanged inside the test
bench and could move into a Web Worker later.

---

## Setup from source

The extension itself has no build step: Chrome loads `src/` as it is. What
has to be put in place is the third-party code in `lib/`, and MathSearch's
three edits to the PDF.js viewer. A script does both:

```bash
npm install        # the build tools (dev dependencies; nothing is bundled from here)
npm run setup      # lib/ for development: load this folder unpacked
npm run build      # dist/mathsearch/ and dist/mathsearch-<version>.zip
```

Then `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select the folder (`npm run setup`) or `dist/mathsearch/` (`npm run build`).
Click the toolbar icon: the viewer opens with the **MathSearch guide**
(`guide/mathsearch-guide.pdf`; source `guide/mathsearch-guide.tex`, rebuilt
with `npm run guide`, which needs pdfLaTeX). After editing a file in
`src/`, reload the extension on the extensions page.

What `scripts/build.mjs` does:

1. **Downloads the pinned releases** listed in `scripts/vendor.json` (PDF.js
   4.10.38's `pdfjs-4.10.38-dist.zip` from GitHub, the KaTeX 0.17.0 and
   html2canvas 1.4.1 tarballs from npm) into `vendor-cache/`, and refuses any
   whose SHA-256 differs from the pinned one.
2. **Copies only what the extension needs**, each with its license: the
   generic viewer (`web/`, `build/`) without PDF.js's demo paper; KaTeX's
   minified script, stylesheet and fonts; html2canvas's minified script.
   `npm run build` also leaves out the source maps.
3. **Applies the three viewer edits.** Each must match exactly once, or the
   build stops instead of shipping an unpatched viewer:
   - `viewer.html`: the contents of `viewer-snippet.html` go just before
     `</body>`. They load, in order, the KaTeX stylesheet, `katex.min.js`,
     `html2canvas.min.js` and `src/controller.js` as an ES module (which
     imports the other modules itself).
   - `viewer.mjs`: the `defaultUrl` option becomes `"mathsearch-guide.pdf"`,
     and the guide is copied next to it.
   - `viewer.mjs`: both `enableScripting` defaults become `false` (the
     `enableScripting` entry of the default options, and `enableScripting`
     in the default-preferences object). MathSearch never runs a PDF's own
     JavaScript, and the viewer reads this setting before
     `src/controller.js` loads, so the controller cannot switch it off
     itself. In the browser, the console line
     `[mathsearch] PDF.js isEvalSupported=false enableScripting=false (viewer: false)`
     confirms it.

   Both files get a comment at the top saying MathSearch changed them, as
   the Apache License requires.
4. **Checks the result** with `scripts/check-viewer.mjs` (also
   `npm run check-viewer`), which fails if any edit is missing.

PDF.js is used unmodified apart from these edits. Before 2026-10-06 the
viewer was an unreleased build of the same code (4.10.46, upstream commit
`4d4e1befe` of 2025-01-04, three days after v4.10.38), built by hand and
patched by hand.

### Updating PDF.js (or KaTeX, html2canvas)

1. **Pick the release.** Take the newest one at
   <https://github.com/mozilla/pdf.js/releases> and check
   <https://github.com/mozilla/pdf.js/security/advisories> for anything
   affecting it. For example, CVE-2026-16633 (XSS through
   `enableScripting`) affects 5.6.83 up to 6.2.108, so stay out of that
   range. Take the plain `pdfjs-<version>-dist.zip`, not `-legacy-dist`,
   which targets old browsers.
2. **Pin it** in `scripts/vendor.json`: the version, the URL, and the
   SHA-256 of the downloaded file (`sha256sum` or
   `certutil -hashfile FILE SHA256`). For an npm package, check the
   tarball against `npm view <package>@<version> dist.integrity`.
3. **Run `npm run setup`.** If a viewer edit no longer applies, the build
   names it; adapt the replacement in `patchViewer` (`scripts/build.mjs`).
   It prints the PDF.js version and the SHA-256 of `pdf.mjs` and
   `pdf.worker.mjs`.
4. **Test in the browser:** the console line
   `[mathsearch] PDF.js … (viewer: false)` must say `false`, and there must
   be no new errors or deprecation warnings. Then search a symbol, snip one,
   use Look up in index, and change the zoom. MathSearch relies on these
   viewer interfaces, which a major version can change:
   `PDFViewerApplication.initializedPromise`, the `eventBus` events
   `pagerendered` and `documentloaded`, `pdfViewer.getPageView(i).div` and
   `.pdfPage.view`, `pdfViewer.scrollPageIntoView`, and
   `pdfDocument.getPage(n).render(…)`.

---

## Using it (full reference)

The panel is a floating window that opens at the top right of the viewer.
Drag it by its header to move it; it can't be dragged so far that the header
leaves the viewport. Double-click the header to put it back at the top right.
▾ collapses the panel and × hides it. The **Σ** button in the PDF.js toolbar
shows or hides it, and **Alt+M** reopens it and focuses the input. Its position
and visibility last for the session only. The two memory settings (below) are
the only thing stored: one JSON value in the extension page's localStorage,
which needs no permission and never leaves the browser.

- Type LaTeX. The preview renders as you type; the rendered preview *is* the
  search template, so what you see is what is searched for.
- **✂ Snip** (or **Alt+S**) searches by screenshot, for a symbol whose LaTeX
  you don't know. The cursor becomes a crosshair; drag a rectangle around the
  symbol on a page (**Escape** or Alt+S cancels; the wheel still scrolls).
  The rectangle is re-rendered by PDF.js at 2× the index scale
  (`SNIP_RENDER_FACTOR`), binarised and cropped to its ink. That image
  replaces the preview and is searched for at once. It stays the query,
  also for **Look up in index** and after opening another PDF, until you type
  in the box again. Snip only the symbol: any other ink inside the rectangle
  (a subscript, a fraction bar, the edge of a neighbouring letter) is part of
  the template, and clean occurrences then score lower. A line under the
  preview says so.
- **Scope**: *whole document* (default) or *this page*.
- **Min score**: matches below this are hidden. Default 0.90. Changing it after a search
  re-filters instantly without re-scanning — lower it to surface weaker
  candidates such as scriptsize occurrences of compound symbols.
- **Penalise scripts and accents next to the match** (on by default,
  `ATTACHED_INK`): sub/superscripts, accents and dots attached to a match
  count against it, so `\mathbb{R}^d` ranks below a bare `\mathbb{R}`.
  Untick it to find the symbol with or without such marks. Unlike Min
  score, it changes the scores themselves, so changing it searches again.
  The box is read once at the start of each search and passed to the
  matcher (`findMatchesOnPage(…, { attachedInk })`); `Config` itself is not
  changed. Session only, like the panel's other settings.
- **Enter** searches. The scan starts at the current page and works
  backward to page 1, then goes forward from the current page to the end.
  On p. 130 that means 130, 129, …, 1, then 131, …, the last page, so the
  nearest earlier occurrence (usually the definition) is found first. The
  panel jumps to the first match as soon as one is found. Results then fill
  in live while the rest of the document is scanned, and **Cancel** stops the
  scan and keeps what was found. The result list is always in document
  order. **Enter** / **Shift+Enter** step to the next / previous match, even
  while the scan is running; ‹ › do the same, and clicking an entry in the
  list jumps to it.
- **Look up in index** (or **Ctrl+Enter**) first searches the book's index
  for the symbol. That can be an index of notation, a list of symbols, or a
  subject index. The index pages are found from the PDF bookmarks, or else
  from headings: a notation list among the first 40 pages (its title the
  topmost line of the page, e.g. a "List of Symbols" after the contents,
  continuing while the running head says so) and an index heading on one
  of the last 60 pages, both if both exist. Failing all, those of the last
  20 pages that look like an index are searched: at least 3 lines, and 30 %
  of the lines, ending in a page number. The page numbers printed next to
  the hits are read from the PDF's text layer and converted to PDF pages.
  The numbers read are the last run of numbers of the entry, so a number in
  the description ("Euclidean 3-space") is passed over, also when a wide
  gap separates the page column, as in a tabular notation list. The conversion uses the PDF's
  page labels if it has them; otherwise it reads the printed page numbers
  in the page margins. The panel then jumps to the first referenced page and
  scans from there. The line "Index → p. 23 · p. 45" links to each page the
  index names. "≈" means the PDF page could not be confirmed and is an
  estimate. If the index doesn't list the symbol, or has no readable page
  numbers (a scanned book), the panel says so and searches from the current
  page instead. The *Scope* setting doesn't apply to this button.
- Highlights are yellow, the current one orange, each stamped with its score
  (`Config.SHOW_SCORE_LABELS`).
- After a PDF loads, pages are indexed in the background ("Indexing pages
  3/24 …"). A whole-document search over indexed pages costs ≈ 35–80 ms
  per page in the browser, growing with the template's size and number of
  pieces: on a 1115-page textbook (2026-10-06, maintainer's laptop) ≈ 39 s
  for `\mathscr{X}`, ≈ 91 s for a snip of `L(H)`, and ≈ 67 s for
  `\mathscr{X}` with a 50 MB cap (pages outside the cap are rendered
  again). Pages not yet indexed are rendered on demand (≈ 40–50 ms of
  render + analysis each at scale 3, plus matching). The index is
  independent of the viewer's zoom.
- **Settings** (collapsed, at the bottom of the panel; saved in this
  browser):
  - *Memory for the page index* (default 250 MB, at least 50). A text page
    takes ≈ 0.16 MB, so 250 MB holds a ~1500-page book. When a document
    needs more, the index keeps the book's index and notation pages (at most
    a quarter of the limit) and the pages nearest to where the last search
    started, half before and half after; other pages are rendered again
    when a search reaches them. The progress line then reads "Index ready:
    N of M pages kept (memory cap …)", and "In use: … MB" under the setting
    shows the current size. MathSearch computes these figures itself (the
    exact byte size of the stored arrays, `Segmentation.compactBytes`); the
    browser does not report them. They leave out the working cache below and
    PDF.js's own memory, so Chrome's Task Manager (Shift+Esc) shows a larger
    total for the tab. Pre-indexing starts from the page being read.
  - *Release it when the tab is hidden for* 10 min / 30 min (default) /
    1 hour / 2 hours / never. A hidden viewer tab drops its working cache
    (the last six expanded pages, ≈ 50 MB) at once and the whole page index
    after this delay (not while a search runs); it is rebuilt in the
    background when the tab is shown again. *never* keeps the index.

Compound symbols (`\mathbb{R}^d`, `\mathrm{ID}_2`, `\mathscr{F}_{\tau_{j+1}}`)
work: the template's largest component anchors the search and the rest must
line up. Conversely, searching for `\mathbb{R}` ranks `\mathbb{R}^d` and
`\hat{R}` *below* a bare `\mathbb{R}`, because attached scripts and accents on
the page count as ink the template does not explain.

---

## How it works

Four stages, all on binary (ink / background) images.

**1. Page index** (`pageindex.js`). Each page is rendered offscreen by PDF.js
at `RENDER_SCALE` 3 (216 dpi: a 10 pt body font has an em of 30 px and a cap
height of ≈ 20 px), binarised, and reduced to its 8-connected **components**
(run-length union-find, no per-pixel label array) plus **clusters** of
components whose boxes touch (a glyph that rasterised as two pieces, an *i*
with its dot). The page is cached in a compact form (`Segmentation.compact`:
its horizontal ink runs plus the components as typed arrays, ≈ 0.16 MB for a
text page, against ≈ 0.8 MB as packed bits + component objects) up to a
memory cap with the retention rule under *Settings* above; `get()` expands
it, and the expanded page with its distance transform is kept for the last
six pages. Nothing is cut into word boxes: a component's bounding box is
intrinsic to its glyph, which is what made the earlier projection-profile
segmentation unreliable.

**2. Template** (`template.js`, `matching.js: prepareTemplate`). The KaTeX
preview is rasterised by html2canvas at 3× (`TEMPLATE_RENDER_SCALE`),
binarised, cropped to its ink, and analysed the same way. A snip instead
renders its rectangle of the page with PDF.js at `RENDER_SCALE ×
SNIP_RENDER_FACTOR` (6), so it's the same size as the KaTeX templates the
scorer was calibrated on. Its largest cluster
and largest components (up to `MAX_ANCHORS`) become **anchors**.

**3. Candidates** (`matching.js: findMatchesOnPage`). Every page component
and cluster is tried as the location of each anchor. The height and width
ratios candidate/anchor give the template→page scale for free; the pair is
rejected only if the two ratios disagree by more than `SCALE_ASYMMETRY_MAX`,
the ink density differs by more than `DENSITY_TOLERANCE`, or the template
would end up under `MIN_SCALED_HEIGHT_PX`. The gate is deliberately loose —
every past regression in this project came from over-tight gating. For each
survivor the whole template is rescaled (area-averaged, cached per 1 % of
scale), placed so the anchor sits on the candidate, and scored at every
offset within `JITTER_PX` and at the anchor scale × (1 ± `SCALE_REFINE`).
Only the best of those placements is kept, so the reverse term (the costlier
half) is skipped when even a perfect reverse could not lift a placement above
the best so far or the threshold, i.e. when combine(forward, 1) is below
both. This is exact: `test/match-dump.mjs` gives byte-identical output with
and without it, and it skips about a third of the reverse terms at the
controller's 0.5 floor.

**4. Score** — truncated symmetric chamfer, in [0, 1]:

    forward = mean over template ink of   w(distance to nearest page ink)
    reverse = mean over page ink in the window, plus attached scripts/accents,
              of                          w(distance to nearest template ink)
    score   = harmonic mean(forward, reverse),   w(d) = max(0, 1 − d / cap)

with `cap = max(TOLERANCE_MIN_PX, TOLERANCE_RATIO × template height)` (2 px at
the sizes that matter). Distances come from a 3-4 chamfer transform (1/3 px
resolution, `DT_MAX` cap, stored as bytes): the forward term reads the page's
transform, the reverse term reads the template's own padded transform, so
neither has a score floor from surrounding ink. Page components that hang off
the window as a **sub/superscript** (to the right, overlapping vertically and
reaching beyond it — `SCRIPT_*`) or as a **dot / accent** (above or below,
mostly within the window's width — `ACCENT_*`; thin rules such as fraction
bars are exempt) are added to the reverse term as unexplained ink. Overlapping
windows are de-duplicated (`DEDUPE_IOU`, best score wins) and sorted into
reading order.

The controller keeps every match down to a score of 0.5 and applies the
panel's threshold at display time.

**Rotated pages.** Pages are indexed as PDF.js renders them with their own
`/Rotate`, so landscape pages and `pdflscape` pages work as they are. The
viewer's own rotation (Rotate clockwise) is applied to the highlights, the
scroll target and snips (`rotateBox` in `overlay.js`). Content typeset
sideways on the page (`lscape`, `\rotatebox`, a turned table) is found
through the text layer: while a page is indexed, the share of its text
running in each quarter turn is read (`textQuarterTurns` in
`bookindex.js`, ≈ 5–12 ms a page), and a turn with at least
`ROTATED_TEXT_MIN_CHARS` characters and `ROTATED_TEXT_MIN_SHARE` of the
page is also searched with the template turned that way
(`Matching.rotateTemplate`; a quarter turn of a binary image is exact, so
the scores are those of upright matches). A scanned page has no text layer
and is searched upright only.

---

## Configuration

All knobs are in `src/config.js`, each with its rationale. The ones you are
most likely to touch:

| Constant | Default | Effect |
|---|---|---|
| `SIMILARITY_THRESHOLD` | 0.90 | Default *Min score* in the panel. |
| `RENDER_SCALE` | 3 | Index resolution (px per PDF point). 4 costs ~80 % more memory and time and did **not** improve separation on the bench. |
| `TOLERANCE_MIN_PX`, `TOLERANCE_RATIO` | 2, 0.10 | Chamfer tolerance cap. Both swept (1–3 px, 0.08–0.16); 2 / 0.10 has the best worst-case margin. |
| `SCALE_ASYMMETRY_MAX`, `DENSITY_TOLERANCE` | 0.28, 0.50 | Candidate gate. Loosen rather than tighten. |
| `MIN_SCALED_HEIGHT_PX` | 6 | Skip candidates that would shrink the template below this. |
| `ATTACHED_INK` | true | Default of the *Penalise scripts and accents* checkbox. |
| `SCRIPT_*`, `ACCENT_*` | — | Geometry of attached scripts / accents (see comments). |
| `PREINDEX_ON_LOAD` | true | Index every page in the background after load. |
| `INDEX_MAX_MB`, `INDEX_RESERVED_SHARE` | 250, 0.25 | Default memory cap of the page index (panel setting) and the share kept for index/notation pages. |
| `RELEASE_HIDDEN_AFTER_MIN` | 30 | Default delay before a hidden tab releases the page index (panel setting; 0 = never). |
| `SHOW_SCORE_LABELS` | true | Stamp scores on highlights. |

`WEIGHT_SHAPE` (linear / quadratic / smooth), `SCORE_COMBINE` (harmonic / min /
geometric) and `SCALE_REFINE` are exposed for experiments; the defaults won
the sweep.

---

## Known limitations

- **Visual search finds visual matches.** `\mathrm{ID}` matches "ID" inside
  the word IDEAL (0.977); math-italic *x* matches the italic *x* of a theorem
  statement (0.918). Same glyphs, so this is by design; the result list and
  score labels make such hits easy to skip. A same-baseline-neighbour penalty
  was measured and rejected: math delimiters (`(`, `[`, `|`) sit at 2–5 px
  from a symbol, text letters at 0–2 px — both ≈ 0.1 h, not separable.
- **Prefix matches.** `\tau_j` matches the `\tau_j` inside `\tau_{j+1}`
  (0.947): a trailing `+1` at script level is not penalised. Same cause.
- **Small glyphs.** Below ≈ 14 px on the page (scriptsize at 10 pt) scores
  compress towards 0.87 for both true and false matches; expect to lower the
  threshold and tolerate lookalikes there.
- **Compound templates across styles.** A textstyle template does not
  exactly match its scriptstyle occurrence (script placement differs).
- Cross-origin PDFs without CORS headers taint the canvas and cannot be read
  (browser security); local files always work.
- Black ink on white pages only; scanned documents are out of scope.
- Pages over `MAX_INDEX_PIXELS` (40 Mpx at scale 3, ≈ 29 × 29 in; A0
  posters are over it) are indexed at a lower scale that fits (an A0 poster
  at ≈ 2.2; poster text is large, so its symbols are still found, see the
  poster check in `test/smoke-pageindex.mjs`). Pages with more than
  `MAX_PAGE_COMPONENTS` (100 000) ink components are not searched, and the
  summary line says how many were skipped. A page that fails to render is skipped too, and the summary
  names it with the error; the other pages are still searched. Snips over
  `MAX_SNIP_PIXELS` are refused, and the preview
  clamps sizes and macro expansion (`KATEX_MAX_SIZE`, `KATEX_MAX_EXPAND`), so
  a crafted PDF or a typo cannot make the tab allocate gigabytes.
- Multi-line display math (fractions, stacked operators) is matched only as
  far as its pieces are single components; a fraction bar over a searched
  letter is deliberately ignored, a stacked limit is not.
- The search runs on the main thread: a 30-page document takes ≈ 5–8 s on
  an indexed document, with the progress line updating between pages. A Web
  Worker port is straightforward (the matcher is DOM-free) but not done.

