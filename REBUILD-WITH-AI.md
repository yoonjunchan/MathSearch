# Rebuilding MathSearch with your own AI

These are prompts for building MathSearch from scratch with an AI coding
assistant. You might want your own version: another browser, another PDF
viewer, a desktop app, different design choices. Ideally the assistant can
run code and tests in your project, as Claude Code, Cursor or Copilot agent
mode do. A chat-only assistant also works, but you then run each step's
checks yourself.

How to use this:

1. Start a new project and paste **Prompt 0** (the project brief) first.
   If your tool supports a standing instruction file, such as `CLAUDE.md`
   or a "rules" file, put the brief there instead.
2. Then give **Prompts 1–8** one at a time. Don't move on until the step's
   **Done when** checks pass. The order matters: the test bench comes
   before the matcher, because every design choice here was decided by
   measurement, not by guessing.
3. Paste **Lessons learned** with Prompt 4. It saves you weeks of
   rediscovering what doesn't work.

The numbers below are what worked in this project (10 pt Computer Modern
PDFs, rendered at 216 dpi). Treat them as starting points to re-measure.
`DESIGN.md` and `src/config.js` explain each one.

---

## Prompt 0: project brief

```text
We are building "MathSearch": a browser extension (Chromium, Manifest V3)
that searches a PDF for LaTeX math symbols by VISUAL APPEARANCE.

User flow: the user types LaTeX (e.g. \mathscr{F}_{\tau_{j+1}}), sees a live
KaTeX preview, presses Enter, and every place in the PDF that looks like the
preview is highlighted, with next/previous navigation and a result list.
The rendered preview IS the search template: what the user sees is what is
searched for.

Hard constraints:
- Everything runs in the browser. No server, no network calls, no
  extension permissions; nothing stored except two settings in the
  extension page's localStorage (needs no permission). CSP "script-src 'self'": no inline scripts, no
  eval, no remote code.
- Plain JavaScript ES modules, no build step for the extension.
- The image-processing and matching modules must be DOM-free (pure
  functions on typed arrays), so they run unchanged in Node for testing and
  could later move into a Web Worker.
- Every tunable constant lives in one config file, with a comment giving
  its reason and how it was measured. No magic numbers elsewhere.

Stack: PDF.js (its generic viewer, hosted inside the extension) renders the
PDF; KaTeX renders the preview; html2canvas rasterises the preview into a
template image. The test bench is Node with pdfjs-dist, @napi-rs/canvas and
pdflatex.

Pipeline:
1. Page index: render each page offscreen with PDF.js at scale 3, binarise,
   find 8-connected components and small clusters of them, cache per page.
2. Template: rasterise the KaTeX preview, binarise, crop to ink, find its
   components; its largest cluster/components become "anchors".
3. Candidates: every page component is tried as the location of each
   anchor. The scale comes from the height/width ratio.
4. Score: a truncated symmetric chamfer score in [0, 1] (details later).
5. Show: highlights drawn on canvases over the PDF.js page divs, in
   normalised [0,1] page coordinates.

Work in small steps. After each step, run the tests and report the numbers.
Never weaken a test to make it pass.
```

---

## Prompt 1: the ground-truth test bench (do this first)

```text
Before any matching code, build a Node test bench that gives exact ground
truth.

- Write a LaTeX fixture: one realistic page of mathematics that uses the
  symbols we will search for (\mathscr{F}, \mathfrak{F}, \mathbb{R},
  \mathrm{ID}, \mathcal{F}, x, y, \tau, and compounds like \mathbb{R}^d,
  \tau_j, \mathscr{F}_{\tau_{j+1}}). Include lookalikes: italic text r near
  \tau, the word IDEAL near \mathrm{ID}, symbols with sub/superscripts,
  hats and primes, and symbols followed by punctuation.
- Tag EVERY occurrence of a queried symbol with a macro \T{n}{...}. When
  the file is compiled with \def\gttag{n}, occurrence n is typeset in red,
  and nothing else changes. Rasterise both builds with pdfjs-dist exactly
  as the extension will. The red pixels give occurrence n's bounding box.
  Check that the ink mask is otherwise identical.
- A query list: for each query, which tags are "exact" (must be found) and
  which are partial / negative / text / small (reported, not graded).
  Anything untagged that scores above the threshold is a false positive.
- Templates for single glyphs: draw them from the KaTeX TTF fonts at 60 px
  (what html2canvas gives for an 18 px preview at 3x). For compounds,
  typeset them with LaTeX at a non-integer scale, so the matcher must
  rescale.
- Output: a table per query with min/max score of exact matches, of each
  other class, the best distractor and the margin. Exit code 1 on any
  missed exact match or any false positive.

Done when: the bench compiles the fixture, reads every tag's box, and prints
the table (with a placeholder scorer).
```

---

## Prompt 2: page index and segmentation

```text
Implement the DOM-free segmentation module and the browser page index.

- Binarise: luma = 0.299R + 0.587G + 0.114B; ink if luma < 160.
- Connected components, 8-connected, by run-length union-find (no per-pixel
  label array). Drop components under 4 pixels. Keep for each component
  its box, ink count and centre.
- Clusters: also offer groups of components whose boxes come within 2 px
  (edge to edge) as candidates, alongside the single components. This
  covers glyphs broken at thin joints and dotted letters.
- Browser side: render each page offscreen with PDF.js at scale 3, cache
  the page compactly: its horizontal ink runs (reuse the ones the labelling
  pass finds) and the components as typed arrays, ~0.16 MB per text page
  (packed bits + component objects were ~0.8 MB). Cap the cache's memory
  (a setting, 250 MB default); past the cap keep the book's index pages
  and the pages nearest where the last search started.
  Compute a distance transform on demand and keep it for the last few
  pages only. Pre-index pages in the background after load, cancellable
  when a new document opens. Render pages that would exceed ~40 Mpx at a
  lower scale that fits (posters), and skip pages with more than ~100 000
  components or that fail to render, without stopping the other pages.

Done when: on the bench page, segmentation takes well under 100 ms, and
every tagged occurrence's box contains whole components.
```

---

## Prompt 3: templates

```text
Build the template module.
- From an image (the html2canvas capture of the KaTeX preview at 3x, or a
  bench glyph): binarise, crop to ink, find components and clusters.
- Anchors (up to 3): the largest cluster, then the largest components by
  ink; a further component only if it has at least 35% of the largest
  one's ink (dots and primes anchor badly). A KaTeX \mathscr{F} is two
  components while the Computer Modern one is one, so the cluster anchor
  is essential.
- Keep a cache of the template rescaled to any scale (area averaging; an
  output pixel is ink if >= 40% of its source block is ink), with its own
  padded distance transform, cached per 1% of scale.
- Pass KaTeX maxSize and maxExpand limits, so a typo can't allocate
  gigabytes.

Done when: the bench builds templates for every query.
```

---

## Prompt 4: the matcher (paste "Lessons learned" with this)

```text
Implement the matcher, DOM-free.

Candidates: for each anchor and each page component/cluster, the scale is
candidate size / anchor size (height and width separately). Gate LOOSELY:
reject only if the scale is outside [0.12, 1.6], the two ratios differ by
more than 28%, the ink density differs by more than 50%, or the scaled
template would be under 6 px tall. Place the scaled template so the anchor
sits on the candidate. Try offsets of +-1 px in x and y, at the implied
scale and at +-3.5%. Keep the best placement.

Score of a placement (truncated symmetric chamfer):
  forward = mean over template ink pixels of w(distance to nearest page ink)
  reverse = mean over page ink in the window (plus attached ink, below)
            of w(distance to nearest template ink)
  score   = harmonic mean(forward, reverse)
  w(d)    = max(0, 1 - d / cap),  cap = max(2 px, 0.10 x template height)
Distances come from a 3-4 chamfer distance transform (1/3 px units, capped,
stored as bytes). Forward reads the PAGE's transform; reverse reads the
TEMPLATE's own padded transform. Never use a transform of a region crop,
which gives a score floor.

Attached ink: page components hanging off the window count as ink the
template does not explain (added to the reverse term), so a search for R
ranks R^d and R-hat below a bare R:
- scripts: to the right, within 0.4h of the window's right edge, height
  0.25h-1.15h, reaching at least 0.2h below or above the window, AND
  overlapping it vertically;
- accents/dots: above or below, height <= 0.4h, gap <= 0.25h, at least half
  within the window's width. Thin rules (fraction bars) are exempt;
- a comma or semicolon after a symbol is not a subscript: recognise it by
  shape (narrow, solid round head, thin tail).

Speed: the reverse term is the costly half. Since reverse <= 1 and the
score grows with it, combine(forward, 1) bounds the score. Skip the
reverse term when that bound can't beat the best placement so far or the
search floor. This is exact: results must stay byte-identical.

Then de-duplicate overlapping matches (IoU > 0.5, best wins) and sort them
into reading order.

Done when: npm test shows every exact match found with zero false positives
at a single threshold, and the margin table is printed.
```

---

## Prompt 5: calibration

```text
Add tools to choose numbers by measurement:
- a false-positive curve: distractor count per threshold, per query;
- a parameter sweep over any config keys, reporting the worst-case margin
  (min exact score minus best distractor) per setting;
- a timing script, per stage, per page;
- a match dump (every match as JSON), to prove that speed-only changes
  don't change any result.
Pick the default threshold as the lowest with zero false positives on the
bench. Document each chosen value in the config file with its measurement.

Done when: the threshold and tolerances are justified by the sweep output.
```

Our results, for comparison: exact matches 0.91–0.98, the worst distractor
0.900 (italic *r* for τ), default threshold 0.90. Sweeps of the tolerance,
weight shape, score combination and render scale moved the worst-case
margin by only about ±0.01.

---

## Prompt 6: the extension

```text
Wire it into a Manifest V3 extension:
- background service worker: the toolbar icon opens the bundled PDF.js
  viewer (lib/pdfjs/web/viewer.html) in a tab. No permissions.
- Patch the viewer by pasting one snippet before </body>: it loads KaTeX,
  html2canvas and our controller as an ES module. Make sure PDF.js's
  isEvalSupported and enableScripting are false before the viewer reads
  them (enableScripting has to be patched in viewer.mjs's defaults), so a
  PDF's own JavaScript never runs. Set defaultUrl to our guide PDF.
- A floating panel (draggable, collapsible, hideable, Alt+M to focus):
  LaTeX input with a live preview, scope (document / this page), a
  min-score field, Search/Cancel, prev/next, a progress line and a
  clickable result list. Build DOM with textContent; never put user or PDF
  text into innerHTML.
- Controller: scan from the current page backward to page 1, then forward
  to the end. Jump to the first match. Stream the rest in. Store every
  match >= 0.5 and filter by the panel threshold at display time, so
  lowering it doesn't rescan. Yield between pages so the UI stays live.
- Overlay: per-page canvases in normalised coordinates, current match in a
  different colour, score labels, scroll the match into view.

Done when: a jsdom smoke test drives the panel against a real PDF through
pdfjs-dist, and the extension loads unpacked in Chrome and finds
\mathbb{R} in the guide PDF at two zoom levels.
```

---

## Prompt 7: extras

```text
1. Search by snip: a button (Alt+S) turns the cursor into a crosshair.
   Drag a rectangle on a page; re-render just that rectangle with PDF.js at
   2x the index scale (snips cut from the index raster were too small to
   match reliably); binarise and crop it, and use it as the template until
   the user types again. Warn that any neighbouring ink in the rectangle
   becomes part of the template.
2. Look up in index: find the book's index pages (from the PDF outline,
   else a heading near the end, else the last ~20 pages), search the symbol
   there, read the page numbers next to each hit from the PDF text layer,
   map printed page labels to PDF pages (page labels, else printed folios
   in the margins), and jump there.

Done when: snip queries are added to the bench and pass; a fixture book
with an index of notation passes a smoke test.
```

---

## Prompt 8: hardening and packaging

```text
Review the whole extension for security, treating the PDF file, the typed
LaTeX and the snip rectangle as untrusted input. Check for: network calls,
eval, innerHTML with external text, PDF JavaScript, unbounded memory or
CPU (page/snip pixel caps, KaTeX limits, index memory cap). Explain each
finding in plain language before fixing it. Then write a build script
that produces a zip of only the runtime files. Record the version and
SHA-256 of every bundled library, and add the license notices of PDF.js
(Apache-2.0), KaTeX and html2canvas (MIT).
```

---

## Lessons learned

Give these to your assistant. Each one cost real time to find.

- **Don't segment the page into word or symbol boxes.** Projection
  profiles (cutting at blank rows and columns) merged symbols with
  neighbouring punctuation depending on kerning. Connected components are
  intrinsic to the glyph, so they give scale and position for free.
- **Gate loosely and let the scorer decide.** Every regression in this
  project came from over-tight candidate gating.
- **IoU of binary masks is a weak score for small glyphs.** A two-sided
  chamfer score with a small tolerance separates much better.
- **Both score directions are needed.** Forward alone matches `l` inside
  `b`; reverse alone matches `b` over `l`.
- **The script rule needs vertical overlap with the base.** Without it,
  glyphs from the next line count as subscripts.
- **Cap accent height at about 0.4h.** At 0.5h, a subscript's descender
  from the line above counted as an accent on the symbol below it.
- **A comma after a symbol looks like a subscript to simple geometry.** Use
  its shape (round head, thin tail), not its position.
- **Higher resolution didn't help.** Render scale 4 made a lookalike
  distractor score higher. Finer distance metrics changed nothing.
- **A neighbour penalty can't reject "ID" inside "IDEAL".** Gaps between
  text letters (0–2 px) and between a symbol and math delimiters (2–5 px)
  overlap at this size.
- **The remaining errors are 12–14 px lookalikes** (italic r vs τ, "io" vs
  ID). No local geometric rule separates them. A small learned comparator
  might; tuning won't.
- **Speed:** the matcher's hot loop is plain typed-array code that the
  JavaScript JIT already compiles well. Exact pruning (skip work that can't
  change the result) and Web Workers (one page per core) beat
  WebAssembly here.
- **Keep the test PDFs your own.** Don't ship third-party papers as
  samples: write a fabricated guide document instead.
