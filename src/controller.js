/**
 * controller.js — The only module that imports all others.
 *
 * Wires the PDF.js event lifecycle, holds the search state (matches +
 * current index) and runs the pipeline:
 *
 *   panel preview → html2canvas → Template.buildTemplate
 *     (or a snip: Snip rectangle → PageIndex.renderRegion → Template.fromImageData)
 *     → for each page in search order: PageIndex.get (render/analyse on demand)
 *        → Matching.findMatchesOnPage → normalise → merge into the results
 *        → Overlay.drawMatches + Panel.showResults (live, after every page)
 *     → the first match found is jumped to at once; the scan continues
 *
 * Search order (BookIndex.pageOrder): from the current page backward to
 * page 1, then forward to the end — the nearest earlier occurrence (the
 * definition, usually) comes first. "Look up in index" first searches the
 * book's index pages, reads the page numbers next to the hits, and starts
 * from the page the index names instead.
 *
 * Matches are computed once per search at a low floor (Config.SEARCH_FLOOR) and
 * filtered by the panel's threshold for display, so lowering the threshold
 * after a search only re-filters instead of re-scanning the document. The
 * result list is always in document order, whatever order pages are scanned.
 */

import { Config } from "./config.js";
import { Panel } from "./panel.js";
import { Template } from "./template.js";
import { PageIndex } from "./pageindex.js";
import { Matching } from "./matching.js";
import { Overlay } from "./overlay.js";
import { BookIndex } from "./bookindex.js";
import { Snip } from "./snip.js";

let app = null;              // PDFViewerApplication
let allMatches = [];         // every match ≥ Config.SEARCH_FLOOR, document order
let shownMatches = [];       // allMatches filtered by the panel threshold
let currentIndex = -1;
let searchToken = null;      // {cancelled, jumped, navigated, attachedInk} of the running search
let snipTemplate = null;     // template of the last snip (the query while Panel.hasSnip())
let indexOwnsProgress = true; // the progress line is free for pre-indexing messages
let releaseAfterMin = Config.RELEASE_HIDDEN_AFTER_MIN; // panel setting (0 = never)
let hiddenTimer = null;      // releases the page index while the tab is hidden
let indexReleased = false;   // released while hidden: rebuild when shown

export const Controller = {
  /**
   * Initialise once the PDF.js viewer application exists.
   * Safe to call from a `webviewerloaded` listener.
   */
  async init(pdfViewerApplication) {
    app = pdfViewerApplication;
    await app.initializedPromise;

    Overlay.init(app.pdfViewer);
    Panel.createPanel({
      onSearch: () => Controller.startSearch(),
      onLookup: () => Controller.startSearch({ mode: "index" }),
      onCancel: () => Controller.cancelSearch(),
      // Navigating by hand during a scan stops the automatic jump.
      onPrev: () => { userNavigated(); Controller.step(-1); },
      onNext: () => { userNavigated(); Controller.step(+1); },
      onSelect: (i) => { userNavigated(); Controller.goTo(i); },
      onJumpPage: (n) => { userNavigated(); app.pdfViewer.currentPageNumber = n; },
      onSnip: () => Controller.toggleSnip(),
      onSettings: (s) => Controller.applySettings(s),
    });
    Controller.applySettings(Panel.getSettings());

    // Keep overlays sized to the page divs across zoom changes.
    app.eventBus.on("pagerendered", (evt) => {
      const view = app.pdfViewer.getPageView(evt.pageNumber - 1);
      if (view && view.div) Overlay.attachOverlayToPage(evt.pageNumber, view.div);
    });

    app.eventBus.on("documentloaded", () => Controller.onDocumentLoaded());
    if (app.pdfDocument) Controller.onDocumentLoaded();

    PageIndex.onProgress(({ indexed, total, full, kept, maxMB }) => {
      Panel.setMemoryUse(PageIndex.memory);
      // The search reports its own progress, and any other message (snip
      // instructions, a result summary) stays until it is cleared.
      if (searchToken || !indexOwnsProgress) return;
      if (total === 0) Panel.setProgress("");
      else if (full) {
        Panel.setProgress(`Index ready: ${kept} of ${total} pages kept (memory cap ${Math.round(maxMB)} MB); ` +
          "the others are rendered when searched");
      } else if (indexed < total) Panel.setProgress(`Indexing pages ${indexed}/${total} …`);
      else Panel.setProgress(`Index ready (${total} page${total === 1 ? "" : "s"})`);
    });

    // Threshold edits re-filter the last result set without re-searching.
    document.getElementById("ms-threshold").addEventListener("change", () => {
      if (allMatches.length) Controller.applyThreshold({ scroll: false });
    });
    // The attached-ink switch changes the scores themselves: the stored
    // matches were scored under the old setting, so search again.
    document.getElementById("ms-attached").addEventListener("change", () => {
      if (allMatches.length || searchToken) Controller.startSearch();
    });

    // A hidden tab gives memory back: the working cache at once, the page
    // index after the set delay (rebuilt in the background when shown).
    document.addEventListener("visibilitychange", () => Controller.onVisibilityChange(document.hidden));

    // Keyboard shortcuts: jump into the search box; start / cancel a snip.
    document.addEventListener("keydown", (e) => {
      if (matchesShortcut(e, Config.FOCUS_SHORTCUT)) {
        e.preventDefault();
        Panel.focusInput();
      } else if (matchesShortcut(e, Config.SNIP_SHORTCUT)) {
        e.preventDefault();
        Controller.toggleSnip();
      }
    });
  },

  /**
   * A new document invalidates everything except the query: a snip from the
   * previous document can be searched for in this one.
   */
  onDocumentLoaded() {
    Controller.cancelSearch();
    Snip.cancel();
    PageIndex.setDocument(app.pdfDocument);
    Overlay.reset();
    allMatches = [];
    shownMatches = [];
    currentIndex = -1;
    Panel.showResults([], -1);
    Panel.showIndexRefs([]);
    Panel.hideError();
    setProgress("");
    // The book's index and notation pages are kept in the page index before
    // any other page (once the memory cap is reached); found in the
    // background. The last-pages fallback is only a guess, so not reserved.
    const doc = app.pdfDocument;
    BookIndex.findIndexPages(doc).then(({ pages, source }) => {
      if (app.pdfDocument === doc && source !== "fallback") PageIndex.setReservedPages(pages);
    }).catch((err) => console.warn("[mathsearch] index pages not found", err));
    indexReleased = false;
    if (Config.PREINDEX_ON_LOAD) Controller.preindex();
  },

  /**
   * Apply the panel's settings: the page index's memory cap (a raised cap
   * lets pre-indexing continue) and the release delay for a hidden tab.
   * Passed to PageIndex, not written into Config (as for attachedInk).
   */
  applySettings({ indexMaxMB, releaseAfterMin: minutes }) {
    PageIndex.setLimits({ maxBytes: indexMaxMB * 1e6 });
    releaseAfterMin = minutes;
    Panel.setMemoryUse(PageIndex.memory);
    if (app?.pdfDocument && Config.PREINDEX_ON_LOAD) Controller.preindex();
  },

  /** Pre-index in the background, centred on the page being read. */
  preindex() {
    PageIndex.preindexAll({ anchor: () => app.pdfViewer.currentPageNumber }).catch((err) => {
      console.error("[mathsearch] pre-indexing failed", err);
      Panel.setProgress("");
    });
  },

  /**
   * The tab was hidden or shown. Hidden: drop the working cache now, and
   * the page index after `releaseAfterMin` minutes (not during a search: it
   * waits for the next period). Shown: cancel the pending release, or
   * rebuild the index if it was released.
   */
  onVisibilityChange(hidden) {
    clearTimeout(hiddenTimer);
    hiddenTimer = null;
    if (hidden) {
      PageIndex.dropWorkingCache();
      if (releaseAfterMin > 0) {
        const release = () => {
          if (searchToken) {
            hiddenTimer = setTimeout(release, releaseAfterMin * 60000);
            return;
          }
          PageIndex.release();
          indexReleased = true;
          console.info(`[mathsearch] tab hidden for ${releaseAfterMin} min: page index released`);
        };
        hiddenTimer = setTimeout(release, releaseAfterMin * 60000);
      }
    } else if (indexReleased) {
      indexReleased = false;
      if (app?.pdfDocument && Config.PREINDEX_ON_LOAD) Controller.preindex();
    }
  },

  /**
   * Run the search pipeline.
   * @param {{mode?: "normal"|"index"}} opts  "normal": the panel's scope,
   *   from the current page backward then forward; "index": look the symbol
   *   up in the book's index first and start from the page it names.
   */
  async startSearch({ mode = "normal" } = {}) {
    Controller.cancelSearch();
    Snip.cancel();
    Panel.hideError();
    Panel.showIndexRefs([]);
    if (!app.pdfDocument) {
      Panel.showError("Open a PDF first.");
      return;
    }
    // The checkbox is read once: the whole scan uses the same scoring.
    const token = { cancelled: false, jumped: false, navigated: false, attachedInk: Panel.getAttachedInk() };
    searchToken = token;
    Panel.setBusy(true, mode === "index" ? "lookup" : "search");
    allMatches = [];
    shownMatches = [];
    currentIndex = -1;
    Overlay.drawMatches([], -1);
    Panel.showResults([], -1);
    try {
      // 1. Template: the snip, or the live preview.
      let template = snipTemplate;
      if (Panel.hasSnip()) {
        Panel.markSearched();
      } else {
        const canvas = await Panel.getRenderedCanvas();
        if (token.cancelled) return;
        if (!canvas) {
          Panel.showError("Type some LaTeX first (or snip a symbol with ✂): the preview is empty or does not parse.");
          return;
        }
        template = Template.buildTemplate(canvas);
        if (!template) {
          Panel.showError("The rendered LaTeX contains no visible ink.");
          return;
        }
      }

      // 2. Search order.
      const t0 = performance.now();
      const total = app.pdfDocument.numPages;
      const current = app.pdfViewer.currentPageNumber;
      const scanned = new Set(); // pages already searched (the index pages)
      let order;
      let from = `from p. ${current} backward`;
      if (mode === "index") {
        const lookup = await Controller.lookUpIndex(template, token, scanned);
        if (!lookup) return; // cancelled
        if (lookup.refs.length) {
          const refPages = [...new Set(lookup.refs.map((r) => r.pageNumber))];
          Panel.showIndexRefs(lookup.refs);
          if (!token.navigated) app.pdfViewer.currentPageNumber = refPages[0];
          order = BookIndex.pageOrder(refPages[0], total, refPages);
          from = `from index → p. ${lookup.refs[0].label}`;
        } else {
          Panel.showIndexRefs([], lookup.message);
          order = BookIndex.pageOrder(current, total);
        }
      } else if (Panel.getScope() === "page") {
        order = [current];
        from = null;
      } else {
        order = BookIndex.pageOrder(current, total);
      }
      order = order.filter((n) => !scanned.has(n));
      // The page index keeps the pages nearest to where this search starts
      // (once its memory cap is reached; see pageindex.js).
      PageIndex.setAnchor(order[0] ?? current);

      // 3. Scan; results appear and the first one is jumped to as they come.
      for (let i = 0; i < order.length; i++) {
        const pageNumber = order[i];
        const needsRender = !PageIndex.isIndexed(pageNumber);
        const n = shownMatches.length;
        setProgress(
          `${needsRender ? "Rendering and searching" : "Searching"} page ${pageNumber}` +
          (order.length > 1 ? ` (${i + 1}/${order.length})` : "") +
          ` — ${n} match${n === 1 ? "" : "es"} so far`
        );
        await yieldToBrowser();
        const pageData = await PageIndex.get(pageNumber);
        if (token.cancelled) return;
        if (!pageData) continue;
        Controller.addPageMatches(pageNumber, pageData, template, token);
      }
      const secs = ((performance.now() - t0) / 1000).toFixed(1);

      // Only the index pages had matches (they never jump on their own):
      // make the first one current now.
      if (!token.jumped && !token.navigated && shownMatches.length) {
        token.jumped = true;
        Controller.goTo(0);
      }

      // 4. Summary.
      const n = shownMatches.length;
      const pages = scanned.size + order.length;
      const searched = [...scanned, ...order];
      const tooDense = searched.filter((p) => PageIndex.isSkipped(p)).length;
      const failedPages = searched.filter((p) => PageIndex.failure(p) !== undefined);
      const failedNote = failedPages.length
        ? ` — ${failedPages.length} page${failedPages.length === 1 ? "" : "s"} could not be rendered ` +
          `(p. ${failedPages[0]}: ${PageIndex.failure(failedPages[0])})`
        : "";
      setProgress(
        (n === 0
          ? `No matches ≥ ${Panel.getThreshold().toFixed(2)} on ${pages} page${pages === 1 ? "" : "s"} (${secs} s)` +
            (allMatches.length ? ` — ${allMatches.length} weaker candidate${allMatches.length === 1 ? "" : "s"}; lower the min score to see them` : "")
          : `${n} match${n === 1 ? "" : "es"} on ${new Set(shownMatches.map((m) => m.pageNumber)).size} page(s) (${secs} s` +
            (from ? `, ${from}` : "") + ")") +
        (tooDense ? ` — ${tooDense} page${tooDense === 1 ? "" : "s"} too dense to search skipped` : "") +
        failedNote
      );
    } catch (err) {
      console.error("[mathsearch]", err);
      Panel.showError(err.message || "Search failed — see the console for details.");
    } finally {
      if (searchToken === token) {
        searchToken = null;
        Panel.setBusy(false);
      }
    }
  },

  /**
   * Search the book's index pages for the template and read the page
   * references next to the hits. Matches on the index pages go into the
   * results like any others (without the automatic jump); the pages are
   * added to `scanned` so they are not searched twice.
   * @returns {Promise<{refs: Array<{label:string, pageNumber:number,
   *   exact:boolean}>, message: string|null}|null>} null if cancelled;
   *   refs sorted by PDF page.
   */
  async lookUpIndex(template, token, scanned) {
    const doc = app.pdfDocument;
    const { pages, source } = await BookIndex.findIndexPages(doc);
    if (token.cancelled) return null;
    const thr = Panel.getThreshold();
    const refs = [];
    let hits = 0;
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      setProgress(`Searching the index: page ${p} (${i + 1}/${pages.length})`);
      await yieldToBrowser();
      const pageData = await PageIndex.get(p);
      if (token.cancelled) return null;
      if (!pageData) continue;
      scanned.add(p);
      const found = Controller.addPageMatches(p, pageData, template, token, { autoJump: false });
      const good = found.filter((m) => m.score >= thr);
      if (!good.length) continue;
      hits += good.length;
      const items = await BookIndex.pageText(doc, p);
      for (const m of good) {
        const box = { x: m.x_norm, y: m.y_norm, w: m.w_norm, h: m.h_norm };
        for (const label of BookIndex.readPageRefs(items, box)) {
          if (refs.some((r) => r.label === label)) continue;
          const resolved = await BookIndex.resolveLabel(doc, label);
          if (token.cancelled) return null;
          if (resolved) refs.push({ label, ...resolved });
        }
      }
    }
    refs.sort((a, b) => a.pageNumber - b.pageNumber);
    const then = "Searching from the current page instead.";
    if (!pages.length) {
      return {
        refs,
        message: "No index found (no bookmark or heading for one, and the last pages do not look like an index). " + then,
      };
    }
    const range = pages.length > 1 ? `PDF pp. ${pages[0]}–${pages[pages.length - 1]}` : `PDF p. ${pages[0]}`;
    let message = null;
    if (!refs.length && source === "fallback") {
      message = `No index found (no bookmark or heading for one), so the last pages (${range}) were tried` +
        (hits ? `: the symbol is there, but no page number could be read next to it. ` : `: no page reference found. `) + then;
    } else if (!refs.length) {
      const where = source === "outline" ? "found via the bookmarks" : "found by its heading";
      message = hits
        ? `Found in the index (${range}, ${where}), but no page number could be read next to it. ${then}`
        : `Not in the index (${range}, ${where}). ${then}`;
    }
    return { refs, message };
  },

  /**
   * Match one page, merge its matches into the results (kept in document
   * order) and redraw without moving the current match. The first match a
   * search shows is jumped to, unless the user has navigated meanwhile.
   * @returns {Array} this page's matches (all ≥ Config.SEARCH_FLOOR)
   */
  addPageMatches(pageNumber, pageData, template, token, { autoJump = true } = {}) {
    const opts = { threshold: Config.SEARCH_FLOOR, attachedInk: token.attachedInk };
    let raw = Matching.findMatchesOnPage(template, pageData, opts);
    // Text running sideways on this page (a rotated table): search it with
    // the template turned the same way too.
    for (const k of pageData.turns || []) {
      const turned = Matching.rotateTemplate(template, k);
      if (turned) raw = Matching.dedupe(raw.concat(Matching.findMatchesOnPage(turned, pageData, opts)));
    }
    const found = Matching.sortReadingOrder(raw).map((m) => ({
      pageNumber,
      x_norm: m.x / pageData.w,
      y_norm: m.y / pageData.h,
      w_norm: m.w / pageData.w,
      h_norm: m.h / pageData.h,
      score: m.score,
    }));
    if (!found.length) return found;
    const at = allMatches.findIndex((m) => m.pageNumber > pageNumber);
    allMatches.splice(at < 0 ? allMatches.length : at, 0, ...found);
    Controller.applyThreshold({ scroll: false, keepCurrent: true, quiet: true, page: pageNumber });
    if (autoJump && !token.jumped && !token.navigated) {
      const first = shownMatches.findIndex((m) => m.pageNumber === pageNumber);
      if (first >= 0) {
        token.jumped = true;
        Controller.goTo(first);
      }
    }
    return found;
  },

  /** Start a snip, or cancel the one being drawn. */
  toggleSnip() {
    if (Snip.isActive()) Snip.cancel();
    else Controller.snip();
  },

  /**
   * Let the user drag a rectangle over a page, make its ink the query and
   * search for it right away. The rectangle is re-rendered by PDF.js at
   * SNIP_RENDER_FACTOR × the index scale (see config.js).
   */
  async snip() {
    if (!app.pdfDocument) {
      Panel.showError("Open a PDF first.");
      return;
    }
    Controller.cancelSearch();
    Panel.hideError();
    Panel.setSnipping(true);
    setProgress("Drag a rectangle around the symbol (Escape cancels)");
    let sel;
    try {
      sel = await Snip.start(app.pdfViewer);
    } finally {
      Panel.setSnipping(false);
      setProgress("");
    }
    if (!sel) return;
    try {
      const imageData = await PageIndex.renderRegion(sel.pageNumber, sel.rect);
      if (!imageData) return; // the document changed meanwhile
      const template = Template.fromImageData(imageData);
      if (!template) {
        Panel.showError("The snipped rectangle contains no ink. Drag it around a symbol.");
        return;
      }
      snipTemplate = template;
      Panel.showSnip(template);
    } catch (err) {
      console.error("[mathsearch]", err);
      Panel.showError(err.message || "Snip failed — see the console for details.");
      return;
    }
    await Controller.startSearch();
  },

  cancelSearch() {
    if (searchToken) {
      searchToken.cancelled = true;
      searchToken = null;
      Panel.setBusy(false);
      const n = shownMatches.length;
      setProgress(`Search cancelled${n ? ` — ${n} match${n === 1 ? "" : "es"} so far` : ""}`);
    }
  },

  /**
   * Filter the stored matches by the panel threshold and redraw.
   * keepCurrent: stay on the same match if it is still shown (else none is
   * current), instead of resetting to the first; quiet: leave the progress
   * line alone (the running search owns it); page: only this page's matches
   * changed, so repaint just its overlay and keep the list's scroll position.
   */
  applyThreshold({ scroll = true, keepCurrent = false, quiet = false, page = 0 } = {}) {
    const thr = Panel.getThreshold();
    const cur = keepCurrent ? shownMatches[currentIndex] : undefined;
    shownMatches = allMatches.filter((m) => m.score >= thr);
    if (keepCurrent) currentIndex = cur ? shownMatches.indexOf(cur) : -1;
    else currentIndex = shownMatches.length ? 0 : -1;
    if (page) Overlay.updatePage(shownMatches, currentIndex, page);
    else Overlay.drawMatches(shownMatches, currentIndex);
    Panel.showResults(shownMatches, currentIndex, { keepScroll: !!page });
    const n = shownMatches.length;
    if (!quiet) setProgress(n ? `${n} match${n === 1 ? "" : "es"} ≥ ${thr.toFixed(2)}` : `No matches ≥ ${thr.toFixed(2)}`);
    if (scroll && currentIndex >= 0) Overlay.scrollTo(shownMatches[currentIndex]);
  },

  /** Move to the next/previous match (wraps around). */
  step(direction) {
    const n = shownMatches.length;
    if (n === 0) return;
    Controller.goTo((currentIndex + direction + n) % n);
  },

  /** Make match #index current, highlight it and scroll it into view. */
  goTo(index) {
    if (index < 0 || index >= shownMatches.length) return;
    currentIndex = index;
    Overlay.setCurrent(index);
    Panel.setCurrent(index);
    Overlay.scrollTo(shownMatches[index]);
  },
};

/**
 * Set the progress line from the controller. A message keeps the line until
 * it is cleared (""), so background pre-indexing cannot overwrite it; an
 * empty line is handed back to pre-indexing.
 */
function setProgress(text) {
  indexOwnsProgress = !text;
  Panel.setProgress(text);
}

/** The user moved between matches or pages: no automatic jump any more. */
function userNavigated() {
  if (searchToken) searchToken.navigated = true;
}

/**
 * Does a keydown event match a {key, code, altKey, ctrlKey, shiftKey}
 * shortcut? The typed character or the physical key may match (config.js).
 */
function matchesShortcut(e, s) {
  const keyOk = (e.key || "").toLowerCase() === s.key || (!!s.code && e.code === s.code);
  return keyOk && !!e.altKey === !!s.altKey &&
    !!e.ctrlKey === !!s.ctrlKey && !!e.shiftKey === !!s.shiftKey;
}

/** Let the browser paint (progress text, overlays) between pages. */
function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Turn off the two PDF.js features that run code taken from a PDF: font
 * programs compiled with `new Function` (isEvalSupported, the CVE-2024-4367
 * path) and the PDF's own JavaScript (enableScripting). The extension's CSP
 * (`script-src 'self'`, no 'wasm-unsafe-eval') already blocks both; this is
 * a second line of defence. isEvalSupported is read on every getDocument(),
 * so it applies to each file the user opens. enableScripting is read when
 * the viewer starts, before this module runs, so setting it here is too late
 * (the browser showed "viewer: true"); it is therefore also patched to false
 * in lib/pdfjs/web/viewer.mjs (DESIGN.md, setup step 2). The console line shows
 * what the viewer actually uses.
 */
function hardenPdfJs() {
  const opts = window.PDFViewerApplicationOptions;
  if (!opts) return;
  opts.set("isEvalSupported", false);
  opts.set("enableScripting", false);
  const app = window.PDFViewerApplication;
  console.info(
    "[mathsearch] PDF.js isEvalSupported=%s enableScripting=%s (viewer: %s)",
    opts.get("isEvalSupported"), opts.get("enableScripting"),
    app?.pdfViewer ? app.pdfViewer.enableScripting : "not built yet"
  );
}

// ── Bootstrapping ────────────────────────────────────────────────────────────
// PDF.js dispatches `webviewerloaded` on the document once
// window.PDFViewerApplication exists (but before it is initialised). If this
// module is evaluated after that event already fired (it is loaded at the end
// of viewer.html), fall back to checking for the global directly.
function bootstrap() {
  hardenPdfJs();
  if (window.PDFViewerApplication) {
    Controller.init(window.PDFViewerApplication);
  } else {
    document.addEventListener(
      "webviewerloaded",
      () => Controller.init(window.PDFViewerApplication),
      { once: true }
    );
  }
}

bootstrap();
