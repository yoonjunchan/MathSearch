/**
 * pageindex.js — Renders PDF pages offscreen at a fixed scale and caches the
 * binarised image plus its connected components, so that any page of the
 * document can be searched whether or not the viewer has rendered it, and
 * independently of the viewer's zoom level.
 *
 * Per page the index stores
 *   { w, h, scale, page, bytes, turns }
 * where `page` is the compact form of the binarised page and its components
 * (Segmentation.compact: horizontal runs and typed arrays, ≈ 0.3–0.4 MB for
 * a 1836×2376 text page at RENDER_SCALE 3, against ≈ 0.8–1.0 MB as packed
 * bits + component objects) and `bytes` its exact size. The matcher needs
 * the full image, the component objects and a distance transform; `get()`
 * expands the entry into such a PageData, and keeps the last few
 * (Config.DT_CACHE_PAGES) ready, since each costs ≈ 2 bytes per pixel.
 *
 * Pages larger than Config.MAX_INDEX_PIXELS at RENDER_SCALE (posters; or a
 * crafted PDF that would otherwise make us allocate gigabytes as soon as it
 * opens) are rendered at a lower scale that fits the cap (indexScale): poster
 * text is several times larger than a paper's, so its glyphs still get
 * enough pixels, and the matcher finds the scale from the glyph sizes anyway.
 * Pages with more than Config.MAX_PAGE_COMPONENTS components are dropped
 * after segmentation: ensure()/get() return null for them, as for a page
 * that has nothing to search, and isSkipped() lets the controller report
 * them. A page whose rendering or analysis throws is
 * likewise recorded (failure()) and returns null, so one broken page does
 * not stop pre-indexing or a search of the other pages.
 *
 * Rendering uses PDF.js's PDFPageProxy.render() on a throwaway canvas, so it
 * never touches the viewer's own canvases and works for pages the viewer has
 * not laid out yet. The page proxy is shared with the viewer (pdfDocument
 * caches it), which is fine: PDF.js supports concurrent render tasks on one
 * page as long as they use different canvases.
 *
 * One catch: after 30 s without rendering anything itself, the viewer calls
 * pdfDocument.cleanup(), which throws "startCleanup: Page n is currently
 * rendering" if one of OUR renders is in flight (the viewer only knows about
 * its own). setDocument() therefore wraps cleanup(): it is skipped while we
 * render (it is only memory housekeeping, and the viewer schedules another
 * after its next render), and that error is dropped if our render started
 * while the cleanup was already under way.
 */

import { Config } from "./config.js";
import { Template } from "./template.js";
import { Segmentation } from "./segmentation.js";
import { Matching } from "./matching.js";
import { textQuarterTurns } from "./bookindex.js";

let pdfDocument = null;
let generation = 0;          // bumped on every new document; cancels work
let entries = new Map();     // pageNumber → entry (see file comment)
let pending = new Map();     // pageNumber → Promise<entry> (in-flight renders)
let skipped = new Set();     // pageNumbers over MAX_PAGE_COMPONENTS
let failed = new Map();      // pageNumber → error message of a failed render/analysis
let dtCache = [];            // [{pageNumber, pageData}] most recent last
let preindexRunning = false;
let epoch = 0;               // bumped by release(): stops a running pre-index
let maxBytes = Config.INDEX_MAX_MB * 1e6; // memory cap (setLimits)
let bytes = 0;               // sum of the cached entries' sizes
let reservedBytes = 0;       // the part of `bytes` held by reserved pages
let reserved = [];           // index / notation pages, in order (setReservedPages)
let anchor = 1;              // the kept window is centred here (setAnchor)
let full = false;            // a page was turned away for lack of room
let listeners = new Set();
let activeRenders = 0;       // our offscreen page.render() calls in flight

export const PageIndex = {
  /**
   * Bind to a newly loaded document. Clears everything from the previous
   * document and cancels its in-flight work.
   * @param {Object} doc  PDFViewerApplication.pdfDocument (may be null)
   */
  setDocument(doc) {
    generation++;
    pdfDocument = doc;
    if (doc) guardCleanup(doc);
    entries = new Map();
    pending = new Map();
    skipped = new Set();
    failed = new Map();
    dtCache = [];
    preindexRunning = false;
    bytes = reservedBytes = 0;
    reserved = [];
    anchor = 1;
    full = false;
    PageIndex._emit();
  },

  // ── Memory cap and which pages are kept ───────────────────────────────────
  // The cache is filled up to the cap and then kept ("fill, then keep"):
  // a newly rendered page replaces cached ones only if it ranks higher, and
  // otherwise is used once and dropped. Rank: the reserved pages (the
  // book's index and notation lists, up to INDEX_RESERVED_SHARE of the
  // cap), then the pages nearest the anchor, alternately before and after
  // it (so the kept window is half before, half after; at the start or end
  // of the book it extends to the other side). The controller moves the
  // anchor to where each search starts, so the window follows the part of
  // the book being worked on, without any work until a search runs.

  /** Set the memory cap; a lower cap drops the lowest-ranked pages at once. */
  setLimits({ maxBytes: cap } = {}) {
    if (!(cap > 0) || cap === maxBytes) return;
    const raised = cap > maxBytes;
    maxBytes = cap;
    markReserved(); // the reserved share is a share of the new cap
    const before = entries.size;
    while (bytes > maxBytes && evictWorst(-Infinity)) { /* until under the cap */ }
    if (raised) full = false;
    if (pdfDocument) {
      console.info(`[mathsearch] memory cap ${(maxBytes / 1e6).toFixed(1)} MB: ${entries.size} of ` +
        `${pdfDocument.numPages} pages kept (${(bytes / 1e6).toFixed(1)} MB)` +
        (entries.size < before ? `, ${before - entries.size} dropped` : ""));
    }
    PageIndex._emit();
  },

  /** Centre the kept window on this page (see above). */
  setAnchor(pageNumber) {
    if (Number.isInteger(pageNumber) && pageNumber >= 1) anchor = pageNumber;
  },

  /** The book's index / notation pages, kept before all others. */
  setReservedPages(pages) {
    reserved = [...pages];
    markReserved();
  },

  /** Memory held by the cache, its cap (bytes), and whether a page was turned away. */
  get memory() {
    return { bytes, maxBytes, full };
  },

  /**
   * Drop the expanded pages and distance transforms kept for re-use
   * (DT_CACHE_PAGES, ≈ 9 MB each). Cheap to rebuild; called when the tab
   * is hidden.
   */
  dropWorkingCache() {
    dtCache = [];
  },

  /**
   * Drop the whole index of this document (after the tab was hidden for a
   * while). Too-dense and failed pages stay known; preindexAll() rebuilds.
   */
  release() {
    epoch++;
    entries = new Map();
    dtCache = [];
    bytes = reservedBytes = 0;
    full = false;
    preindexRunning = false;
    PageIndex._emit();
  },

  get numPages() {
    return pdfDocument ? pdfDocument.numPages : 0;
  },

  /** Number of pages whose index entry exists. */
  get indexedCount() {
    return entries.size;
  },

  isIndexed(pageNumber) {
    return entries.has(pageNumber);
  },

  /**
   * True if the page is too dense to index (over MAX_PAGE_COMPONENTS).
   */
  isSkipped(pageNumber) {
    return skipped.has(pageNumber);
  },

  /** Error message if rendering or analysing the page failed, else undefined. */
  failure(pageNumber) {
    return failed.get(pageNumber);
  },

  /**
   * Index entry for a page, rendering and analysing it on first access.
   * Resolves to null if the document changed meanwhile, or if the page is
   * skipped or failed (see the file comment).
   */
  async ensure(pageNumber) {
    if (!pdfDocument || skipped.has(pageNumber) || failed.has(pageNumber)) return null;
    const hit = entries.get(pageNumber);
    if (hit) return hit;
    let p = pending.get(pageNumber);
    if (!p) {
      const gen = generation;
      // setDocument replaces `pending`: a render of the previous document
      // must delete from its own map, not from the new document's.
      const map = pending;
      p = buildEntry(pageNumber, gen)
        .catch((err) => {
          if (gen !== generation) return null;
          console.error(`[mathsearch] page ${pageNumber} could not be indexed`, err);
          failed.set(pageNumber, err?.message || String(err));
          PageIndex._emit();
          return null;
        })
        .finally(() => map.delete(pageNumber));
      map.set(pageNumber, p);
    }
    return p;
  },

  /**
   * PageData ready for Matching.findMatchesOnPage: the unpacked binary image,
   * its components and a distance transform. Small LRU of recent pages.
   * @returns {Promise<import("./matching.js").PageData|null>}
   */
  async get(pageNumber) {
    for (let i = dtCache.length - 1; i >= 0; i--) {
      if (dtCache[i].pageNumber === pageNumber) {
        const [item] = dtCache.splice(i, 1);
        dtCache.push(item); // most recently used
        return item.pageData;
      }
    }
    const entry = await PageIndex.ensure(pageNumber);
    if (!entry) return null;
    const { binary, ccs, clusters, byX0 } = Segmentation.expand(entry.page);
    const pageData = {
      binary,
      w: entry.w,
      h: entry.h,
      ccs,
      clusters,
      byX0,
      dt: Matching.distanceTransform(binary, entry.w, entry.h, Config.DT_MAX),
      scale: entry.scale,
      turns: entry.turns || [],
    };
    dtCache.push({ pageNumber, pageData });
    while (dtCache.length > Config.DT_CACHE_PAGES) dtCache.shift();
    return pageData;
  },

  /**
   * Index pages in the background, one at a time, with pauses so the viewer
   * stays responsive: always the highest-ranked page not yet tried (reserved
   * pages, then outward from the anchor), until every page is done or a
   * page is turned away by the memory cap (all later ones rank lower).
   * Safe to call repeatedly; a document change or release() stops the run.
   * @param {{anchor?: () => number}} [opts]  read after the start delay to
   *   centre the window (the viewer may restore a reading position on load)
   */
  async preindexAll({ anchor: anchorNow } = {}) {
    if (!pdfDocument || preindexRunning) return;
    preindexRunning = true;
    const gen = generation;
    const ep = epoch;
    const tried = new Set();
    let built = 0;
    const t0 = Date.now();
    try {
      await sleep(Config.PREINDEX_START_DELAY_MS);
      if (gen !== generation || ep !== epoch) return;
      if (anchorNow) PageIndex.setAnchor(anchorNow());
      for (;;) {
        if (gen !== generation || ep !== epoch) return;
        const n = bestUntried(tried);
        if (n === null) break;
        tried.add(n);
        if (entries.has(n)) continue;
        await PageIndex.ensure(n);
        if (gen !== generation || ep !== epoch) return;
        if (!entries.has(n) && !skipped.has(n) && !failed.has(n)) break; // turned away: cap reached
        built++;
        await sleep(Config.PREINDEX_PAGE_PAUSE_MS);
      }
      if (built) {
        console.info(`[mathsearch] index: ${entries.size} of ${pdfDocument.numPages} pages, ` +
          `${(bytes / 1e6).toFixed(1)} MB of ${(maxBytes / 1e6).toFixed(1)} MB, ` +
          `${Math.round((Date.now() - t0) / built)} ms/page${full ? " (memory cap reached)" : ""}`);
      }
    } finally {
      if (gen === generation && ep === epoch) preindexRunning = false;
    }
  },

  /**
   * Render one rectangle of a page at SNIP_RENDER_FACTOR × the page's index
   * scale (RENDER_SCALE, lower for oversized pages; for a snip template), so
   * the template has the same size relative to the indexed glyphs. Only the rectangle is rasterised, on its own canvas.
   * @param {number} pageNumber
   * @param {{x:number, y:number, w:number, h:number}} rect  normalised [0,1]
   * @returns {Promise<ImageData|null>}  null if the document changed
   * @throws if the rectangle is over MAX_SNIP_PIXELS (message for the user)
   */
  async renderRegion(pageNumber, rect) {
    if (!pdfDocument) return null;
    const gen = generation;
    const page = await pdfDocument.getPage(pageNumber);
    if (gen !== generation) return null;
    const viewport = page.getViewport({ scale: indexScale(page) * Config.SNIP_RENDER_FACTOR });
    const x0 = Math.max(0, Math.floor(rect.x * viewport.width));
    const y0 = Math.max(0, Math.floor(rect.y * viewport.height));
    const w = Math.min(Math.ceil(viewport.width), Math.ceil((rect.x + rect.w) * viewport.width)) - x0;
    const h = Math.min(Math.ceil(viewport.height), Math.ceil((rect.y + rect.h) * viewport.height)) - y0;
    if (w <= 0 || h <= 0) return null;
    if (w * h > Config.MAX_SNIP_PIXELS) {
      throw new Error("The snipped rectangle is too large. Drag a smaller rectangle around one symbol.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    await renderOffscreen(page, {
      canvasContext: ctx,
      viewport,
      transform: [1, 0, 0, 1, -x0, -y0], // shift the rectangle to the origin
      annotationMode: 0,
    });
    if (gen !== generation) return null;
    const imageData = ctx.getImageData(0, 0, w, h);
    canvas.width = canvas.height = 0;
    return imageData;
  },

  /** Subscribe to progress: fn({indexed, total}) after each page. */
  onProgress(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  _emit() {
    // Skipped and failed pages count as done, so the progress line reaches
    // "ready"; `full`: the memory cap is reached, the rest stays unindexed.
    const info = {
      indexed: entries.size + skipped.size + failed.size,
      total: PageIndex.numPages,
      full,
      kept: entries.size,
      maxMB: maxBytes / 1e6,
    };
    for (const fn of listeners) {
      try {
        fn(info);
      } catch (e) {
        console.error("[mathsearch] progress listener failed", e);
      }
    }
  },
};

/** Render, binarise and analyse one page. */
async function buildEntry(pageNumber, gen) {
  const page = await pdfDocument.getPage(pageNumber);
  if (gen !== generation) return null;

  const scale = indexScale(page);
  const viewport = page.getViewport({ scale });
  const w = Math.ceil(viewport.width);
  const h = Math.ceil(viewport.height);
  if (scale < Config.RENDER_SCALE) {
    console.info(`[mathsearch] page ${pageNumber} is large: indexed at scale ${scale.toFixed(2)} (${w}×${h} px)`);
  }

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);

  // annotationMode 0: skip form fields / annotation widgets, which are not
  // part of the typeset content.
  await renderOffscreen(page, { canvasContext: ctx, viewport, annotationMode: 0 });
  if (gen !== generation) return null;

  let imageData;
  try {
    imageData = ctx.getImageData(0, 0, w, h);
  } catch (err) {
    throw new Error(
      "Cannot read the rendered page: the canvas is tainted. This happens for " +
        "PDFs loaded from another origin without CORS headers; open the file " +
        "locally instead.",
      { cause: err }
    );
  }
  // Release the canvas backing store promptly (the ImageData is what we keep).
  canvas.width = canvas.height = 0;

  const binary = Template.binarize(imageData);
  const seg = Segmentation.analyze(binary, w, h);
  if (gen !== generation) return null;
  if (seg.ccs.length > Config.MAX_PAGE_COMPONENTS) {
    console.warn(`[mathsearch] page ${pageNumber} has ${seg.ccs.length} components: too dense to index, skipped`);
    skipped.add(pageNumber);
    PageIndex._emit();
    return null;
  }
  const compactPage = Segmentation.compact(binary, w, h, seg);
  const turns = await sidewaysTurns(page, viewport);
  if (gen !== generation) return null;
  const entry = { w, h, scale, page: compactPage, bytes: Segmentation.compactBytes(compactPage), turns };
  if (gen !== generation) return null;
  admit(pageNumber, entry);
  PageIndex._emit();
  return entry;
}

/**
 * The quarter turns in which the page's text runs sideways (textQuarterTurns),
 * so that a search also tries the template turned that way. Reading the text
 * layer costs ≈ 5–12 ms against ≈ 130 ms for the page itself. [] if the page
 * has no text layer or it cannot be read.
 */
async function sidewaysTurns(page, viewport) {
  try {
    const content = await page.getTextContent();
    return textQuarterTurns(content.items, viewport);
  } catch {
    return [];
  }
}

/**
 * Rank of a page for keeping it: lower is better. Reserved pages first,
 * then by distance from the anchor, the page before ahead of the page after
 * (anchor, anchor−1, anchor+1, anchor−2, …).
 */
function rank(pageNumber, isReserved) {
  if (isReserved) return -1;
  const d = pageNumber - anchor;
  return d === 0 ? 0 : d < 0 ? -2 * d - 1 : 2 * d;
}

/**
 * Cache an entry if it fits, evicting lower-ranked pages to make room;
 * otherwise leave it uncached (the caller still uses it once).
 */
function admit(pageNumber, entry) {
  if (entries.has(pageNumber)) return; // built twice (a stale render); keep the cached one
  entry.reserved = reserved.includes(pageNumber) &&
    reservedBytes + entry.bytes <= Config.INDEX_RESERVED_SHARE * maxBytes;
  const r = rank(pageNumber, entry.reserved);
  while (bytes + entry.bytes > maxBytes) {
    if (!evictWorst(r)) {
      full = true;
      return;
    }
  }
  entries.set(pageNumber, entry);
  bytes += entry.bytes;
  if (entry.reserved) reservedBytes += entry.bytes;
}

/**
 * Evict the lowest-ranked cached page if it ranks below (worse than) `than`.
 * @returns {boolean} whether a page was evicted
 */
function evictWorst(than) {
  let worst = null;
  let worstRank = -Infinity;
  for (const [p, e] of entries) {
    const r = rank(p, e.reserved);
    if (r > worstRank) { worst = p; worstRank = r; }
  }
  if (worst === null || worstRank <= than) return false;
  const e = entries.get(worst);
  entries.delete(worst);
  bytes -= e.bytes;
  if (e.reserved) reservedBytes -= e.bytes;
  full = true;
  return true;
}

/**
 * Flag the cached reserved pages, in their given order, as long as they fit
 * in INDEX_RESERVED_SHARE of the cap; the others rank like any page.
 */
function markReserved() {
  reservedBytes = 0;
  for (const e of entries.values()) e.reserved = false;
  for (const p of reserved) {
    const e = entries.get(p);
    if (e && reservedBytes + e.bytes <= Config.INDEX_RESERVED_SHARE * maxBytes) {
      e.reserved = true;
      reservedBytes += e.bytes;
    }
  }
}

/** The best-ranked page not in `tried`, skipped or failed (reserved first), or null. */
function bestUntried(tried) {
  let best = null;
  let bestRank = Infinity;
  for (let n = 1; n <= pdfDocument.numPages; n++) {
    if (tried.has(n) || skipped.has(n) || failed.has(n)) continue;
    const r = rank(n, reserved.includes(n));
    if (r < bestRank) { best = n; bestRank = r; }
  }
  return best;
}

/**
 * The scale a page is indexed at: RENDER_SCALE, or lower so that the raster
 * stays within MAX_INDEX_PIXELS. The width and height are rounded up, so the
 * area-proportional guess is shrunk a little until it really fits.
 */
function indexScale(page) {
  const pixels = (s) => {
    const v = page.getViewport({ scale: s });
    return Math.ceil(v.width) * Math.ceil(v.height);
  };
  let scale = Config.RENDER_SCALE;
  const px = pixels(scale);
  if (px <= Config.MAX_INDEX_PIXELS) return scale;
  scale *= Math.sqrt(Config.MAX_INDEX_PIXELS / px);
  while (scale > 0 && pixels(scale) > Config.MAX_INDEX_PIXELS) scale *= 0.99;
  return scale;
}

/** page.render() on our own canvas, counted so that cleanup() can wait. */
async function renderOffscreen(page, params) {
  activeRenders++;
  try {
    await page.render(params).promise;
  } finally {
    activeRenders--;
  }
}

/** Make doc.cleanup() safe against our in-flight renders (file comment). */
function guardCleanup(doc) {
  if (doc._mathsearchCleanupGuarded) return;
  doc._mathsearchCleanupGuarded = true;
  const cleanup = doc.cleanup.bind(doc);
  doc.cleanup = async (...args) => {
    if (activeRenders > 0) return;
    try {
      await cleanup(...args);
    } catch (err) {
      // Our render began after the check above: skip this round. A render
      // conflict with no render of ours in flight is the viewer's, rethrown.
      if (activeRenders === 0 || !/is currently rendering/.test(err?.message)) throw err;
    }
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
