/**
 * bookindex.js — Search order and the book's own index.
 *
 * "Look up in index": find the book's index of notation / list of symbols /
 * index, let the visual matcher find the symbol there (the controller does
 * that), read the printed page numbers next to each hit from the PDF text
 * layer, and map printed page labels to PDF page numbers (they differ by
 * the front matter).
 *
 * DOM-free: only the PDF.js document API (getOutline, getDestination,
 * getPageIndex, getPageLabels, getPage → getTextContent / getViewport), so
 * the Node bench can drive it with pdfjs-dist. Text boxes use the same
 * normalised [0,1] top-left page frame as the controller's matches: the
 * page as PDF.js renders it with its own /Rotate, before any view rotation.
 * Text that runs sideways in that frame is left out of the index reading;
 * textQuarterTurns reports it, so the controller can search such pages with
 * a rotated template.
 */

import { Config } from "./config.js";

/**
 * Per-document caches: text boxes per page, page labels, the estimated
 * offset (PDF page − printed page), printed numbers per page.
 * @type {WeakMap<Object, {text: Map, labels: any, offset: any, printed: Map}>}
 */
const caches = new WeakMap();

function cacheFor(doc) {
  let c = caches.get(doc);
  if (!c) {
    c = { text: new Map(), labels: undefined, offset: undefined, printed: new Map() };
    caches.set(doc, c);
  }
  return c;
}

/**
 * Pages to search, in order: `first` (deduplicated), then from `start`
 * backward to page 1, then forward from start + 1 to the end. Definitions
 * come before use, so the nearest earlier occurrence is found first.
 */
export function pageOrder(start, total, first = []) {
  const seen = new Set();
  const out = [];
  const add = (n) => {
    if (n >= 1 && n <= total && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  };
  first.forEach(add);
  for (let n = start; n >= 1; n--) add(n);
  for (let n = start + 1; n <= total; n++) add(n);
  return out;
}

/**
 * The upright text items of a page as normalised boxes {str, x, y, w, h};
 * the box spans roughly from ascender to descender of the item's font size.
 * The box is built along the item's own baseline, so it is right on pages
 * with /Rotate 90 or 270 too; items whose text runs sideways on the
 * rendered page are left out (index lines are read left to right).
 */
export async function pageText(doc, pageNumber) {
  const cache = cacheFor(doc).text;
  if (cache.has(pageNumber)) return cache.get(pageNumber);
  const page = await doc.getPage(pageNumber);
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items = [];
  for (const it of content.items) {
    if (typeof it.str !== "string" || !it.str.trim()) continue;
    if (quarterTurns(it.transform, vp) !== 0) continue;
    const [a, b, c, d, e, f] = it.transform;
    const size = Math.hypot(c, d) || it.height || 0;
    const along = Math.hypot(a, b) || 1;
    const ux = a / along, uy = b / along;                  // baseline direction
    const up = Math.hypot(c, d) || 1;
    const vx = c / up, vy = d / up;                        // "up" direction
    const len = it.width || 0;
    const xs = [], ys = [];
    for (const [s, t] of [[0, 0.8], [0, -0.2], [len, 0.8], [len, -0.2]]) {
      const [px, py] = vp.convertToViewportPoint(e + ux * s + vx * t * size, f + uy * s + vy * t * size);
      xs.push(px);
      ys.push(py);
    }
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    items.push({
      str: it.str,
      x: x0 / vp.width,
      y: y0 / vp.height,
      w: (Math.max(...xs) - x0) / vp.width,
      h: (Math.max(...ys) - y0) / vp.height,
    });
  }
  cache.set(pageNumber, items);
  return items;
}

/**
 * How far a text item's baseline is turned on the rendered page, in
 * quarter turns counterclockwise (0 = upright, 1 = reads bottom to top,
 * 2 = upside down, 3 = reads top to bottom).
 * @param {number[]} transform  the item's text matrix
 * @param {Object} vp  a PDF.js viewport of the page (its own rotation)
 */
export function quarterTurns(transform, vp) {
  const [a, b] = transform;
  const [x0, y0] = vp.convertToViewportPoint(0, 0);
  const [x1, y1] = vp.convertToViewportPoint(a, b);
  const angle = Math.atan2(-(y1 - y0), x1 - x0); // counterclockwise, y down
  return ((Math.round(angle / (Math.PI / 2)) % 4) + 4) % 4;
}

/**
 * The sideways orientations of a page's text worth searching with a
 * rotated template: quarter turns (1–3) that carry at least
 * ROTATED_TEXT_MIN_CHARS characters and ROTATED_TEXT_MIN_SHARE of the
 * page's text (a landscape table typeset sideways, e.g. with lscape).
 * @param {Array} items  getTextContent().items
 * @param {Object} vp  a PDF.js viewport of the page (its own rotation)
 * @returns {number[]}
 */
export function textQuarterTurns(items, vp) {
  const chars = [0, 0, 0, 0];
  for (const it of items) {
    if (typeof it.str !== "string" || !Array.isArray(it.transform)) continue;
    const n = it.str.replace(/\s+/g, "").length;
    if (n) chars[quarterTurns(it.transform, vp)] += n;
  }
  const total = chars[0] + chars[1] + chars[2] + chars[3];
  const out = [];
  for (let k = 1; k < 4; k++) {
    if (chars[k] >= Config.ROTATED_TEXT_MIN_CHARS && chars[k] >= Config.ROTATED_TEXT_MIN_SHARE * total) out.push(k);
  }
  return out;
}

/**
 * Locate the index pages.
 *   1. the outline (bookmarks): entries whose title matches
 *      INDEX_TITLE_PATTERN, notation / symbol lists before a subject index;
 *   2. headings: a notation list among the first pages (its heading the
 *      topmost line of the page) and an index heading on one of the last
 *      pages; both blocks if both are found, the notation list first;
 *   3. those of the last INDEX_FALLBACK_PAGES pages that look like an
 *      index (many lines ending in a page number, see looksLikeIndex); none
 *      if no page does, so ordinary closing chapters are not searched.
 * @returns {Promise<{pages: number[], source: "outline"|"heading"|"fallback"}>}
 */
export async function findIndexPages(doc) {
  const total = doc.numPages;
  const cap = (from, to) => {
    const out = [];
    for (let n = from; n <= Math.min(to, total, from + Config.INDEX_MAX_PAGES - 1); n++) out.push(n);
    return out;
  };

  // 1. Outline.
  const entries = await outlineEntries(doc);
  const hits = entries.filter((e) => Config.INDEX_TITLE_PATTERN.test(e.title));
  hits.sort((a, b) => notationFirst(a.title) - notationFirst(b.title));
  const fromOutline = [];
  for (const hit of hits) {
    const next = entries.find((e) => e.pageNumber > hit.pageNumber);
    for (const n of cap(hit.pageNumber, next ? next.pageNumber - 1 : total)) {
      if (!fromOutline.includes(n)) fromOutline.push(n);
    }
  }
  if (fromOutline.length) return { pages: fromOutline, source: "outline" };

  // 2a. A notation list among the first pages, e.g. after the contents. It
  // continues on the following pages as long as their topmost line is
  // still a notation title (the running head "List of Symbols  xiv").
  const isNotationHead = (items) => {
    const top = topLine(items).replace(/^(?:\d+|[ivxlc]+)\s+/i, "").replace(/\s+(?:\d+|[ivxlc]+)$/i, "");
    return top.length <= Config.INDEX_HEADING_MAX_CHARS && Config.NOTATION_TITLE_PATTERN.test(top);
  };
  const front = [];
  for (let n = 1; n <= Math.min(Config.INDEX_FRONT_SCAN_PAGES, total); n++) {
    if (!isNotationHead(await pageText(doc, n))) continue;
    front.push(n);
    while (front.length < Config.INDEX_FRONT_MAX_PAGES && n < total && isNotationHead(await pageText(doc, n + 1))) {
      front.push(++n);
    }
    break;
  }

  // 2b. A heading near the top of one of the last pages (after the front list).
  const from = Math.max(front.length ? front[front.length - 1] + 1 : 1, total - Config.INDEX_HEADING_SCAN_PAGES + 1);
  let back = [];
  for (let n = from; n <= total; n++) {
    const items = await pageText(doc, n);
    const heading = items.some((it) =>
      it.y < Config.INDEX_HEADING_BAND &&
      it.str.trim().length <= Config.INDEX_HEADING_MAX_CHARS &&
      Config.INDEX_TITLE_PATTERN.test(it.str));
    if (heading) {
      back = cap(n, total);
      break;
    }
  }
  if (front.length || back.length) return { pages: [...front, ...back], source: "heading" };

  // 3. Fallback: the index-like pages among the last ones.
  const pages = [];
  for (const n of cap(Math.max(1, total - Config.INDEX_FALLBACK_PAGES + 1), total)) {
    if (looksLikeIndex(await pageText(doc, n))) pages.push(n);
  }
  return { pages, source: "fallback" };
}

/**
 * Does a page look like an index? At least INDEX_FALLBACK_MIN_LINES of its
 * text lines, and INDEX_FALLBACK_MIN_SHARE of them, end in a page number
 * ("filtration, 23", "45–47", "102f"). Running text rarely does: equation
 * numbers end in ")". Running heads and folios (the PAGE_NUMBER_MARGIN
 * bands) are left out.
 */
export function looksLikeIndex(items) {
  const m = Config.PAGE_NUMBER_MARGIN;
  items = items.filter((it) => it.y >= m && it.y + it.h <= 1 - m);
  if (!items.length) return false;
  const tol = 0.5 * (median(items.map((it) => it.h)) || 0.01);
  const lines = [];
  for (const it of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(it.y - line.y) <= tol) line.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  let withRef = 0;
  for (const line of lines) {
    const text = line.items.sort((a, b) => a.x - b.x).map((it) => it.str).join(" ");
    if (/\d+(?:\s*[–—-]\s*\d+)?(?:f|ff|n)?\s*$/.test(text)) withRef++;
  }
  return withRef >= Config.INDEX_FALLBACK_MIN_LINES && withRef >= Config.INDEX_FALLBACK_MIN_SHARE * lines.length;
}

/** The topmost line of a page: its items within a small band, left to right. */
function topLine(items) {
  if (!items.length) return "";
  const y0 = Math.min(...items.map((it) => it.y));
  return items
    .filter((it) => it.y - y0 < Config.INDEX_TOP_LINE_TOLERANCE)
    .sort((a, b) => a.x - b.x)
    .map((it) => it.str.trim())
    .join(" ");
}

/** 0 for a notation / symbol list, 1 for anything else (subject index). */
function notationFirst(title) {
  return /notation|symbol/i.test(title) ? 0 : 1;
}

/** Flattened outline as [{title, pageNumber}] sorted by page; [] if none. */
async function outlineEntries(doc) {
  let outline;
  try {
    outline = await doc.getOutline();
  } catch {
    return [];
  }
  // Pre-order walk with an explicit stack: a deliberately deep outline must
  // not overflow the call stack, and a huge one is cut off.
  const flat = [];
  const stack = [...(outline || [])].reverse();
  while (stack.length && flat.length < Config.INDEX_OUTLINE_MAX_ENTRIES) {
    const item = stack.pop();
    flat.push(item);
    const kids = item.items || [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  const out = [];
  for (const item of flat) {
    try {
      let dest = item.dest;
      if (typeof dest === "string") dest = await doc.getDestination(dest);
      if (!Array.isArray(dest) || dest[0] == null) continue;
      const ref = dest[0];
      const index = typeof ref === "number" ? ref : await doc.getPageIndex(ref);
      out.push({ title: item.title || "", pageNumber: index + 1 });
    } catch {
      // Broken destination: skip the entry.
    }
  }
  return out.sort((a, b) => a.pageNumber - b.pageNumber);
}

/**
 * Read the page references of the index entry a match belongs to.
 *
 * The text items on the match's line, right of it, are read left to right
 * as tokens. Page references are the LAST run of numbers of the entry: a
 * run followed closely by a word was part of the description ("L^2 space")
 * and is replaced by any later run; a run followed by a gap wider than
 * INDEX_MAX_GAP ends the entry (the next column begins). A wide gap after
 * description numbers ends it only if no number follows: in a tabular
 * notation list ("R^3 | Euclidean 3-space | 12") the page column comes
 * after the gap. Arabic numbers and ranges ("45–47" → 45)
 * always count; a lone lowercase roman numeral only after a comma or inside
 * a run. "23f", "23ff", "23n" keep 23. If the line has no numbers (a wrapped
 * entry), the next line is read the same way.
 *
 * @param {Array<{str,x,y,w,h}>} items  pageText() of the index page
 * @param {{x:number,y:number,w:number,h:number}} box  the match, normalised
 * @returns {string[]} printed page labels, at most INDEX_MAX_REFS
 */
export function readPageRefs(items, box) {
  const tol = Config.INDEX_LINE_TOLERANCE * box.h;
  const center = (it) => it.y + it.h / 2;
  const onLine = (top, bottom, xMin) => items
    .filter((it) => center(it) >= top && center(it) <= bottom && it.x >= xMin)
    .sort((a, b) => a.x - b.x);

  const line = onLine(box.y - tol, box.y + box.h + tol, box.x + box.w - tol);
  let refs = refsInLine(line);
  if (!refs.length) {
    // Wrapped entry: the next line down, from the match's left edge on.
    const lineH = median(line.map((it) => it.h)) || box.h / 0.7;
    const c = box.y + box.h / 2;
    refs = refsInLine(onLine(c + 0.6 * lineH, c + 1.6 * lineH, box.x));
  }
  return [...new Set(refs)].slice(0, Config.INDEX_MAX_REFS);
}

const TOKEN = /\d+(?:\s*[–—-]\s*\d+)?|[A-Za-z]+|[^\sA-Za-z\d]/g;
const SUFFIX = /^(f|ff|n|nn)$/;
const ROMAN = /^[ivxlc]+$/;

function refsInLine(line) {
  let run = [];        // the current run of numbers
  let last = [];       // the last complete run
  let prev = null;     // previous token
  let right = null;    // right edge of the previous item
  for (const it of line) {
    if (right !== null && it.x - right > Config.INDEX_MAX_GAP) {
      if (run.length) break; // after the page numbers: the next column
      if (last.length && !/^\s*\d/.test(it.str)) break; // no page column follows
    }
    for (const tok of it.str.match(TOKEN) || []) {
      if (/^\d/.test(tok)) {
        const n = tok.match(/^\d+/)[0];
        if (!/^0/.test(n)) run.push(n); // "0", "007": not a page
      } else if (ROMAN.test(tok) && (run.length || prev === ",")) {
        run.push(tok);
      } else if (/^[A-Za-z]/.test(tok)) {
        if (run.length && SUFFIX.test(tok)) continue;
        if (run.length) last = run; // numbers inside the description
        run = [];
      }
      prev = tok;
    }
    right = it.x + it.w;
  }
  // A run cut short by a trailing remark ("23 (definition)") is still the
  // best guess if nothing follows it.
  return run.length ? run : last;
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * The integers printed alone in the top or bottom PAGE_NUMBER_MARGIN band of
 * a page (folio candidates).
 * @returns {Promise<Set<number>>}
 */
export async function printedNumbers(doc, pageNumber) {
  const cache = cacheFor(doc).printed;
  if (cache.has(pageNumber)) return cache.get(pageNumber);
  const m = Config.PAGE_NUMBER_MARGIN;
  const out = new Set();
  for (const it of await pageText(doc, pageNumber)) {
    const s = it.str.trim();
    if (/^\d{1,4}$/.test(s) && (it.y < m || it.y + it.h > 1 - m)) out.add(Number(s));
  }
  cache.set(pageNumber, out);
  return out;
}

/**
 * Most common (PDF page − printed page) over OFFSET_SAMPLE_PAGES pages
 * spread over the document; null if no page shows a printed number.
 */
async function estimateOffset(doc) {
  const c = cacheFor(doc);
  if (c.offset !== undefined) return c.offset;
  const total = doc.numPages;
  const k = Math.min(Config.OFFSET_SAMPLE_PAGES, total);
  const votes = new Map();
  for (let i = 0; i < k; i++) {
    const n = Math.min(total, Math.max(1, Math.round(((i + 0.5) * total) / k)));
    for (const p of await printedNumbers(doc, n)) {
      if (p > n + Config.OFFSET_SEARCH_RADIUS) continue; // a year, a count …
      votes.set(n - p, (votes.get(n - p) || 0) + 1);
    }
  }
  let best = null;
  let bestVotes = 0;
  for (const [offset, count] of votes) {
    if (count > bestVotes) {
      best = offset;
      bestVotes = count;
    }
  }
  c.offset = best;
  return best;
}

/**
 * Map a printed page label to a PDF page number.
 *   1. the PDF's own page labels, if it has them;
 *   2. for an arabic label: the estimated offset, then the printed number
 *      on the predicted page and up to OFFSET_SEARCH_RADIUS pages around it;
 *   3. otherwise the offset guess (or the label itself), marked inexact.
 * @returns {Promise<{pageNumber:number, exact:boolean}|null>} null for a
 *          roman label that the PDF's page labels do not know, or a number
 *          larger than the document's page count.
 */
export async function resolveLabel(doc, label) {
  const c = cacheFor(doc);
  if (c.labels === undefined) {
    try {
      c.labels = await doc.getPageLabels();
    } catch {
      c.labels = null;
    }
  }
  if (c.labels) {
    const i = c.labels.indexOf(label);
    if (i >= 0) return { pageNumber: i + 1, exact: true };
  }
  if (!/^\d+$/.test(label)) return null;

  const total = doc.numPages;
  const printed = Number(label);
  if (printed > total) return null; // not a page of this document
  const offset = await estimateOffset(doc);
  const guess = Math.min(total, Math.max(1, printed + (offset ?? 0)));
  if (offset !== null) {
    for (let d = 0; d <= Config.OFFSET_SEARCH_RADIUS; d++) {
      for (const n of d ? [guess - d, guess + d] : [guess]) {
        if (n >= 1 && n <= total && (await printedNumbers(doc, n)).has(printed)) {
          return { pageNumber: n, exact: true };
        }
      }
    }
  }
  return { pageNumber: guess, exact: false };
}

export const BookIndex = {
  pageOrder,
  pageText,
  quarterTurns,
  textQuarterTurns,
  findIndexPages,
  readPageRefs,
  printedNumbers,
  resolveLabel,
};
