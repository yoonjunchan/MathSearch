/**
 * config.js — Central home for every tunable constant.
 *
 * Changing a value here affects the entire pipeline.
 * No magic numbers anywhere else in the codebase.
 *
 * Values marked [bench] were calibrated on the Node test bench
 * (test/run-tests.mjs: real pdflatex pages rasterised by PDF.js, templates
 * drawn from the KaTeX fonts). Re-run `npm test` after changing them.
 */

export const Config = {
  // ── Binarization ──────────────────────────────────────────────────────────
  // Luminance weights (ITU-R BT.601). For black ink on white paper
  // R ≈ G ≈ B, so the exact values matter little.
  LUMA_R: 0.299,
  LUMA_G: 0.587,
  LUMA_B: 0.114,

  // Pixels with luminance below this value (0–255) are treated as ink.
  // Applied identically to the page raster and the KaTeX template, so the
  // anti-aliased edge fringe is handled the same way on both sides.
  BINARIZE_THRESHOLD: 160,

  // ── Page index (offscreen rendering) ─────────────────────────────────────
  // Every page is rendered offscreen by PDF.js at this scale (PDF points →
  // pixels; 3 = 216 dpi) for searching. Independent of the viewer's zoom.
  // At 3, 10 pt body text has an em of 30 px and a cap height of ≈ 20 px,
  // which is enough to tell E from F but keeps a page at ≈ 4.4 Mpx. [bench]
  RENDER_SCALE: 3,

  // Index the whole document in the background after it loads, so the
  // first full-document search does not have to render every page first.
  PREINDEX_ON_LOAD: true,
  PREINDEX_START_DELAY_MS: 2000,   // let the viewer paint its first pages
  PREINDEX_PAGE_PAUSE_MS: 60,      // breathing room between pages
  // Memory cap of the page index (MB), the default of the panel setting.
  // A compact page entry is ≈ 0.15–0.4 MB (text pages measured at 0.16 MB,
  // 2026-10-05), so 250 MB holds a ~1000-page textbook in most cases; past
  // the cap the index keeps the book's index pages and the pages nearest
  // the last search (pageindex.js), and renders the rest when searched.
  INDEX_MAX_MB: 250,
  // At most this share of the cap is reserved for the book's index and
  // notation pages (they are kept before any other page).
  INDEX_RESERVED_SHARE: 0.25,
  // Smallest cap the panel setting accepts (MB): below it even a paper
  // would be re-rendered on every search.
  INDEX_MIN_MB: 50,
  // When the viewer tab is hidden, the working cache (DT_CACHE_PAGES) is
  // dropped at once, and the whole page index after this many minutes
  // (rebuilt in the background when the tab is shown again). Default of the
  // panel setting; 0 = never (keep the index while hidden).
  RELEASE_HIDDEN_AFTER_MIN: 30,
  // Unpacked pages + distance transforms kept ready for re-use (PageIndex.get):
  // ≈ 2 bytes per pixel each, ≈ 9 MB for a normal page at scale 3, while
  // re-creating one costs ≈ 80 ms (DT). Covers stepping back and forth
  // between a few neighbouring pages.
  DT_CACHE_PAGES: 6,

  // ── Template rendering ────────────────────────────────────────────────────
  // Oversampling factor when rasterising the KaTeX preview (html2canvas).
  // With the panel's 18 px preview font this gives 54 px per em, so the
  // template is always *down*scaled to page glyphs (area-averaged), never
  // upscaled.
  TEMPLATE_RENDER_SCALE: 3,

  // A snip (search by screenshot) is re-rendered by PDF.js at this multiple
  // of RENDER_SCALE rather than cut from the index raster. At ×1 a 10 pt
  // letter is only ≈ 15–20 px and the pixel phase of the source occurrence
  // is baked in, so other exact occurrences of R and x fell below the
  // threshold (0.88–0.89). ×2 makes snips the size of the KaTeX templates
  // the scorer was calibrated on (exact 0.905–0.945 on the bench's crop
  // queries); ×3 was no better. [bench]
  SNIP_RENDER_FACTOR: 2,

  // ── Size limits (robustness against huge or crafted input) ───────────────
  // A PDF page may legally be 200 in square: 43200² px at RENDER_SCALE 3,
  // gigabytes of RGBA, and pages are pre-indexed as soon as a file opens.
  // Pages over this many pixels at RENDER_SCALE are indexed at a lower scale
  // that fits, instead of crashing the tab. 40 Mpx still covers A1 (≈ 36 Mpx
  // at 3) at full scale; an A0 poster (≈ 72 Mpx) is indexed at ≈ 2.2, which
  // is plenty for poster text (several times a paper's size). A normal page
  // is ≈ 4.5 Mpx.
  MAX_INDEX_PIXELS: 40e6,
  // A snip is rendered at SNIP_RENDER_FACTOR × the page's index scale (6×
  // on a normal page), so a full-page rectangle is ≈ 17 Mpx, and on a
  // poster up to ≈ 160 Mpx. One symbol needs well under 0.1 Mpx; a quarter page (≈ 4.4 Mpx,
  // the large snip `smoke-pageindex --long` times) is still allowed, anything
  // over this is refused with a request to drag a smaller rectangle.
  MAX_SNIP_PIXELS: 8e6,
  // The pixel cap does not bound the number of components: a fine dot
  // pattern in a tiny crafted PDF gave 272 646 components on a normal-size
  // page (≈ 40 MB kept, 0.4 s), against 1439 on the dense bench page
  // (security review, finding S1). Pages with more components than this are
  // skipped and reported like oversized ones. 100 000 is ≈ 70× the bench
  // page, so no real page should come near it.
  MAX_PAGE_COMPONENTS: 100000,
  // KaTeX options for the preview. maxSize clamps every user-given dimension
  // (\rule, \kern, …) to this many em; past maxExpand macro expansions the
  // render throws and the preview shows "…". Without them a typo such as
  // \rule{9999em}{9999em} makes html2canvas allocate hundreds of Mpx. Both
  // are far above any real symbol.
  KATEX_MAX_SIZE: 10,
  KATEX_MAX_EXPAND: 100,

  // ── Segmentation (connected components) ──────────────────────────────────
  // Components with fewer ink pixels than this are discarded as noise.
  MIN_CC_PIXELS: 4,

  // Components whose bounding boxes come within this many px are ALSO
  // offered as merged "cluster" candidates (glyphs broken at thin joins,
  // dotted letters). Singles are always candidates on their own.
  // Counted edge to edge: 1 joins only touching boxes, 2 also bridges one
  // empty column. At RENDER_SCALE 3 binarisation splits the math-italic
  // u, w, v and h at their thin joints with exactly one empty column between
  // the halves, so at 1 they were never candidates at all (letters bench:
  // 46 → 54/54 separated, 40 → 46/54 passing; npm test and punct unchanged).
  // [bench]
  CLUSTER_GAP_PX: 2,

  // ── Candidate gating (deliberately loose) ─────────────────────────────────
  // Every gate here is cheap arithmetic on cached geometry. Past regressions
  // in this project all came from over-tight gating, so these only reject
  // candidates that cannot possibly be the anchor; the scorer decides.
  //
  // A page component is a candidate anchor for a template component when:
  //   s_h = cand.h / anchor.h  and  s_w = cand.w / anchor.w  are both within
  //   [SCALE_MIN, SCALE_MAX] (template px → page px), agree with each other
  //   to within SCALE_ASYMMETRY_MAX, and the ink density (ink / bbox area)
  //   agrees to within DENSITY_TOLERANCE (relative).
  SCALE_MIN: 0.12,
  SCALE_MAX: 1.60,
  SCALE_ASYMMETRY_MAX: 0.28,   // |s_w / s_h − 1|
  DENSITY_TOLERANCE: 0.50,     // relative

  // Up to this many template pieces are used as anchors: the largest cluster
  // of touching components (if any), then the largest components by ink.
  // Several anchors make the search robust to a glyph rasterising as a
  // different number of pieces on the page than in the KaTeX preview.
  MAX_ANCHORS: 3,
  // A further anchor is only used if it has at least this fraction of the
  // largest anchor's ink (tiny components — dots, primes — anchor badly).
  ANCHOR_MIN_INK_RATIO: 0.35,
  // Candidates that would shrink the whole template below this height (px)
  // are skipped: at that size every shape looks like every other shape.
  MIN_SCALED_HEIGHT_PX: 6,

  // ── Scoring ───────────────────────────────────────────────────────────────
  // The scaled template is placed at the alignment implied by the anchor and
  // also at every integer offset within ±JITTER_PX (x and y); the best
  // position wins. Absorbs rasterisation jitter and bbox rounding.
  JITTER_PX: 1,

  // Besides the scale implied by the anchor bbox, also try scale × (1 ± ε)
  // for each ε in SCALE_REFINE — bbox rounding makes the implied scale
  // uncertain by ± half a pixel over the anchor's size, which matters for
  // the far end of wide compound templates.
  SCALE_REFINE: [0.035],

  // Distance transforms are capped at this many px (3-4 chamfer metric,
  // stored in 1/3 px units as Uint8). Must be ≥ the largest tolerance cap
  // in practice.
  DT_MAX: 6,

  // Chamfer tolerance cap as a fraction of the scaled template height,
  // floored at TOLERANCE_MIN_PX. A pixel at distance d from the nearest
  // ink of the other image contributes weight max(0, 1 − d / cap).
  // 0.10 × 20 px = 2 px: a 1-px stroke offset costs half a point,
  // 2 px costs everything. [bench]
  TOLERANCE_RATIO: 0.10,
  TOLERANCE_MIN_PX: 2,
  // Height-relative quantities (the tolerance cap above) use at least this
  // reference height, in PDF points (× RENDER_SCALE → page px): roughly the
  // cap height of 10 pt text. An x-height letter (a, c, e, o, …) is only
  // ≈ 0.65 of that tall, so without the floor it gets a tighter tolerance
  // than a capital of the same font. 0 disables the floor. Off: at
  // RENDER_SCALE 4 a 6.8 pt floor lifted exact x-height letters by only
  // 0.01–0.02 but upright-text lookalikes by 0.03–0.05 (letters-report.md).
  REFERENCE_HEIGHT_PT: 0,
  // Shape of w(d): "linear" | "step" | "quadratic" | "smooth".
  WEIGHT_SHAPE: "linear",

  // Score attached ink at all (the scripts and the accents below): when
  // false, a match is scored on its window only, so "R" finds "R^d" as well
  // as R and a letter is no longer lowered by a mark that happens to sit
  // next to it. The panel's "Penalise scripts and accents" checkbox sets
  // this for the session (no storage: the extension has no permissions).
  ATTACHED_INK: true,

  // Attached sub/superscripts on the page count against a query that does
  // not have them (so a search for "R" ranks "R^d" below a bare "R").
  // A page component to the RIGHT of the aligned template window is treated
  // as an attached script when, with h = window height:
  //   its left edge lies within SCRIPT_MAX_GAP × h of the window's right
  //   edge, its height is in [SCRIPT_MIN_HEIGHT, SCRIPT_MAX_HEIGHT] × h, and
  //   it reaches at least SCRIPT_MIN_OFFSET × h below the window's bottom
  //   (subscript) or above its top (superscript).
  SCRIPT_MAX_GAP: 0.40,
  SCRIPT_MIN_HEIGHT: 0.25,
  SCRIPT_MAX_HEIGHT: 1.15,
  SCRIPT_MIN_OFFSET: 0.20,
  // ...and it must also overlap the window vertically by at least this × h
  // (a subscript starts this far above the window's bottom, a superscript
  // ends this far below its top). This is what keeps glyphs of the next or
  // previous text line out. The long-standing value, not swept.
  SCRIPT_MIN_OVERLAP: 0.10,
  // A comma right after a math symbol (`$x$,`, or a semicolon's lower half)
  // passes the subscript test above whenever the window is only x-height
  // tall (and at RENDER_SCALE 4 for capitals too), costing the symbol up to
  // 0.13 (test/punct.mjs). Such a component is not counted as a subscript
  // when it is shaped like a comma: width ≤ PUNCT_MAX_ASPECT × its height;
  // its widest row within the top PUNCT_HEAD_FRACTION of its rows (the round
  // head) and at least PUNCT_HEAD_MIN_WIDTH × its width (not the full width:
  // at RENDER_SCALE 4 the tail can curl 1 px past the head); the head rows
  // solid (ink ≥ PUNCT_HEAD_SOLIDITY × their summed row spans: a comma's
  // head is a filled disc, while the top of a subscript j whose hook broke
  // off at RENDER_SCALE 4 is a hollow serif, ≈ 0.6); and no row in
  // its lower half wider than PUNCT_TAIL_MAX_WIDTH × its width (the tail).
  // test/debug-punct.mjs checks this against two dozen real subscripts. Geometry alone (how far the
  // top sits above the baseline) separates a comma from a subscript letter by
  // only ≈ 0.4 pt, and needs a baseline estimate; the shape does not.
  PUNCT_MAX_ASPECT: 0.55,
  PUNCT_HEAD_FRACTION: 0.35,
  PUNCT_HEAD_MIN_WIDTH: 0.75,
  PUNCT_HEAD_SOLIDITY: 0.85,
  PUNCT_TAIL_MAX_WIDTH: 0.67,

  // Likewise, small marks directly ABOVE or BELOW the window — the dot of an
  // "i", a hat, a tilde, a dot accent — count against a query without them
  // (so "x" ranks x̂ below a bare x, and "ID" ranks "io" in running text
  // below a real ID). A page component qualifies when, with h and w the
  // window's height and width:
  //   its height ≤ ACCENT_MAX_HEIGHT × h, its width ≤ ACCENT_MAX_WIDTH × w,
  //   at least ACCENT_MIN_OVERLAP of its width lies within the window's
  //   horizontal extent, and its vertical gap to the window is at most
  //   ACCENT_MAX_GAP × h.
  // Thin rules spanning the window (fraction bars, underlines) are exempt so
  // that a letter inside a fraction still matches the bare letter.
  ACCENT_MAX_HEIGHT: 0.4,
  ACCENT_MAX_WIDTH: 1.5,
  ACCENT_MIN_OVERLAP: 0.5,
  ACCENT_MAX_GAP: 0.25,
  RULE_MAX_THICKNESS_PX: 3,
  RULE_MIN_WIDTH: 0.7,

  // When the template is downscaled (area averaging), an output pixel is
  // ink when at least this fraction of the source block it covers is ink.
  RESCALE_INK_FRACTION: 0.4,

  // Final score = harmonic mean of
  //   forward : how much of the template's ink is found on the page
  //   reverse : how much of the page ink in the window (+ attached scripts)
  //             is explained by the template
  // How the two terms are combined: "harmonic" | "geometric" | "min".
  SCORE_COMBINE: "harmonic",
  // Matches below this score are dropped. On the bench (10 pt Computer
  // Modern page at RENDER_SCALE 3, KaTeX templates): exact same-symbol
  // matches score 0.91–0.98; the same symbol with an extra script or accent
  // 0.76–0.95; a scriptsize occurrence of a compound (τ_j in script style)
  // ≈ 0.86; the worst wrong-glyph hit on the page 0.90 (an italic "r" for τ,
  // "io" in running text for ID). 0.90 is the lowest value with no false
  // positive on the bench page; lower it from the panel to find scriptsize
  // compounds, at the cost of some 12–14 px lookalikes. [bench]
  SIMILARITY_THRESHOLD: 0.90,

  // Overlapping reported windows (IoU above this) are merged, keeping the
  // best score — the same symbol can be reached through two anchors or
  // through a component and its cluster.
  DEDUPE_IOU: 0.5,

  // ── Book index lookup (bookindex.js) ──────────────────────────────────────
  // Starting values chosen by hand, not calibrated on the bench.
  //
  // Outline entries and page headings that START with these words mark the
  // book's index of notation / list of symbols / subject index. Anchored at
  // the start, so that chapter titles merely containing the word ("The
  // Atiyah–Singer index theorem", "Looking a symbol up in the index") do
  // not count ("Index theorem/theory" is excluded explicitly). A leading
  // "Chapter n", "Appendix B", "7." or "B." is allowed.
  INDEX_TITLE_PATTERN:
    /^\s*(?:(?:chapter|appendix)\s+\w{1,3}[.:]?\s+|\d{1,3}(?:\.\d+)?[.:]?\s+|[a-z][.:]\s+)?(?:(?:subject|author|name|general|notation|symbol)\s+)?(?:index\b(?!\s+theor)|list of (?:symbols|notations?)\b|(?:table of )?notations?\b|symbols\b|glossary\b)/i,
  // At most this many pages are searched as "the index" (a notation index is
  // a few pages; a subject index rarely more than 30).
  INDEX_MAX_PAGES: 40,
  // Without an outline, the last this-many pages are checked for a heading:
  // a short text item (≤ INDEX_HEADING_MAX_CHARS) matching the pattern in
  // the top INDEX_HEADING_BAND of the page (chapter title or running head).
  INDEX_HEADING_SCAN_PAGES: 60,
  INDEX_HEADING_BAND: 0.25,
  INDEX_HEADING_MAX_CHARS: 40,
  // Notation lists also come right after the table of contents. The first
  // this-many pages are checked for a notation-list heading as the topmost
  // line of a page (a contents page's topmost line is "Contents", so its
  // entries never count), matching NOTATION_TITLE_PATTERN (not a bare
  // "Index": a contents line "Index ... 987" must not count). The list
  // continues while the next page's topmost line is a notation title too
  // (its running head), for at most INDEX_FRONT_MAX_PAGES pages.
  INDEX_FRONT_SCAN_PAGES: 40,
  INDEX_FRONT_MAX_PAGES: 8,
  // Text items whose top lies within this fraction of the page height of
  // the topmost one form the "topmost line".
  INDEX_TOP_LINE_TOLERANCE: 0.01,
  NOTATION_TITLE_PATTERN:
    /^\s*(?:(?:chapter|appendix)\s+\w{1,3}[.:]?\s+|\d{1,3}(?:\.\d+)?[.:]?\s+|[a-z][.:]\s+)?(?:list of (?:symbols|notations?)|(?:index|table) of (?:symbols|notations?)|notations?|symbols|glossary)\b/i,
  // Neither outline nor heading found: search those of the last this-many
  // pages that look like an index: at least INDEX_FALLBACK_MIN_LINES text
  // lines, and INDEX_FALLBACK_MIN_SHARE of all lines, end in a page number.
  // Hand-picked: an index page has 30–60 such lines (two columns merge into
  // one line, still ending in a number), a page of running text a few at
  // most ("… in Section 4"; equation numbers end in ")"), far below the
  // share. The minimum is low so that a short last index page still counts.
  INDEX_FALLBACK_PAGES: 20,
  INDEX_FALLBACK_MIN_LINES: 3,
  INDEX_FALLBACK_MIN_SHARE: 0.3,
  // At most this many outline (bookmark) entries are read when looking for
  // the index. A long book has a few hundred to a few thousand; a crafted
  // outline could have far more, each costing a destination lookup
  // (security review, finding S2).
  INDEX_OUTLINE_MAX_ENTRIES: 10000,
  // A text item is on the same index line as a match when its vertical
  // centre lies within the match's box extended by this fraction of the
  // match height above and below (sub/superscripts shift the match box).
  INDEX_LINE_TOLERANCE: 0.35,
  // After a run of page numbers, a horizontal gap wider than this (fraction
  // of the page width) ends the entry: the next column begins. Word spaces
  // are ≈ 0.005–0.01; a two-column gutter plus indent is ≳ 0.04. Gaps
  // BEFORE the numbers (dot leaders, tabular notation lists) do not count.
  INDEX_MAX_GAP: 0.04,
  // At most this many page references are read per index entry.
  INDEX_MAX_REFS: 5,
  // Sideways text (DESIGN.md, "How it works", rotated pages): a page is also searched with the
  // template turned by a quarter turn when its text layer has at least this
  // many characters, and this share of its characters, turned that way (a
  // landscape table typeset sideways). Hand-picked: rotated axis labels of
  // a figure (≈ 10–20 characters) stay below; a sideways table is far above.
  // Pages without a text layer (scans) are searched upright only.
  ROTATED_TEXT_MIN_CHARS: 40,
  ROTATED_TEXT_MIN_SHARE: 0.1,
  // A printed page number is a lone integer in the top or bottom band of
  // this height (fraction of the page) — running heads and folios.
  PAGE_NUMBER_MARGIN: 0.08,
  // Pages sampled (spread over the document) to estimate the offset
  // PDF page − printed page when the PDF has no page labels.
  OFFSET_SAMPLE_PAGES: 9,
  // The offset can change within a book (plates, blank pages): the page it
  // predicts is checked, then up to this many pages either side of it.
  OFFSET_SEARCH_RADIUS: 4,

  // ── UI ────────────────────────────────────────────────────────────────────
  // Stamp each highlight with its score (useful while calibrating).
  SHOW_SCORE_LABELS: true,
  // Maximum entries shown in the panel's result list.
  RESULT_LIST_MAX: 300,
  // Matches are stored down to this score, so the panel's min score can
  // be lowered after a search without searching again (and the panel's
  // threshold field cannot go below it).
  SEARCH_FLOOR: 0.5,
  // A snip drag smaller than this (CSS px, either side) is a click, and
  // cancels the snip.
  SNIP_MIN_DRAG_PX: 4,
  // Room left above a match scrolled into view, as a share of the page
  // height, so that it does not sit at the very top edge of the window.
  SCROLL_HEADROOM: 0.12,
  // Keyboard shortcuts. `key` is the character typed, `code` the physical
  // key (US position). Either matches: `key` serves layouts that type the
  // letter elsewhere (AZERTY's M), `code` serves macOS, where Option+M types
  // "µ", and non-Latin layouts (review finding C6).
  // Keyboard shortcut that focuses the search box.
  FOCUS_SHORTCUT: { altKey: true, key: "m", code: "KeyM" },
  // Keyboard shortcut that starts (or cancels) a snip.
  SNIP_SHORTCUT: { altKey: true, key: "s", code: "KeyS" },
};
