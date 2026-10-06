/**
 * overlay.js — Draws highlight rectangles on top of PDF.js pages.
 *
 * One overlay <canvas> per page div, absolutely positioned over the page, so
 * it scrolls with the page. Matches are stored in normalised page
 * coordinates ([0,1]² relative to the page's own size) and converted to
 * canvas pixels at draw time, so highlights are correct at any zoom level.
 * The controller calls attachOverlayToPage on every `pagerendered` event
 * (PDF.js re-renders on zoom and on rotation), which resizes the canvas and
 * repaints.
 *
 * Matches are found on the page as PDF.js renders it with its own /Rotate.
 * The viewer's "Rotate clockwise" turns the displayed page further
 * (pdfViewer.pagesRotation); rotateBox maps a match into that displayed
 * frame, for drawing and for scrolling.
 */

import { Config } from "./config.js";

const MATCH_COLOR = "rgba(255, 213, 79, 0.45)";   // semi-transparent yellow
const CURRENT_COLOR = "rgba(255, 145, 0, 0.55)";  // semi-transparent orange

/** Map<pageNumber, HTMLCanvasElement> */
const overlayCanvases = new Map();

let currentMatches = [];
let currentIndex = -1;
/** Map<pageNumber, number[]>: indices into currentMatches, per page. */
let byPage = new Map();

/** The PDF.js PDFViewer instance (for page divs and scrolling). */
let pdfViewer = null;

export const Overlay = {
  init(viewer) {
    pdfViewer = viewer;
  },

  /**
   * Attach (or resize) the overlay canvas for one page div. Idempotent.
   * @param {number} pageNumber   1-based
   * @param {HTMLElement} pdfPageDiv  the PDF.js .page div
   */
  attachOverlayToPage(pageNumber, pdfPageDiv) {
    let overlay = overlayCanvases.get(pageNumber);

    if (!overlay || !pdfPageDiv.contains(overlay)) {
      overlay = document.createElement("canvas");
      overlay.className = "mathsearch-overlay";
      Object.assign(overlay.style, {
        position: "absolute",
        top: "0",
        left: "0",
        width: "100%",
        height: "100%",
        pointerEvents: "none", // clicks pass through to PDF.js
        zIndex: "5",
      });
      pdfPageDiv.appendChild(overlay);
      overlayCanvases.set(pageNumber, overlay);
    }

    // 1 canvas unit == 1 CSS pixel of the page div.
    const w = pdfPageDiv.clientWidth;
    const h = pdfPageDiv.clientHeight;
    if (w && h && (overlay.width !== w || overlay.height !== h)) {
      overlay.width = w;
      overlay.height = h;
      Overlay.redrawPage(pageNumber);
    } else if (currentMatches.length) {
      Overlay.redrawPage(pageNumber);
    }
  },

  /**
   * Show a new set of matches (any pages). Attaches overlays to every page
   * div that already exists; pages laid out later are attached on
   * `pagerendered`.
   *
   * @param {Array<{pageNumber:number, x_norm:number, y_norm:number,
   *                w_norm:number, h_norm:number, score:number}>} matches
   * @param {number} current  index of the current match (−1 for none)
   */
  drawMatches(matches, current = -1) {
    setMatches(matches, current);
    Overlay.clearAll();
    if (!pdfViewer) return;
    const pages = new Set(matches.map((m) => m.pageNumber));
    for (const pageNumber of pages) {
      const view = pdfViewer.getPageView(pageNumber - 1);
      if (view && view.div) Overlay.attachOverlayToPage(pageNumber, view.div);
    }
    Overlay.redrawAll();
  },

  /**
   * Like drawMatches, after a search added matches on one page only: the
   * other pages' highlights are unchanged, so only that page is repainted
   * (review finding C8: repainting every page after every page was
   * O(pages x matches) in a long book).
   */
  updatePage(matches, current, pageNumber) {
    setMatches(matches, current);
    if (!pdfViewer) return;
    const view = pdfViewer.getPageView(pageNumber - 1);
    if (view && view.div) Overlay.attachOverlayToPage(pageNumber, view.div);
    Overlay.redrawPage(pageNumber);
  },

  /** Change which match is highlighted as current and repaint. */
  setCurrent(index) {
    const prev = currentIndex;
    currentIndex = index;
    const pages = new Set();
    if (prev >= 0 && currentMatches[prev]) pages.add(currentMatches[prev].pageNumber);
    if (index >= 0 && currentMatches[index]) pages.add(currentMatches[index].pageNumber);
    for (const p of pages) Overlay.redrawPage(p);
  },

  redrawAll() {
    for (const pageNumber of overlayCanvases.keys()) Overlay.redrawPage(pageNumber);
  },

  /** Repaint the highlights of one page (current match in orange). */
  redrawPage(pageNumber) {
    const canvas = overlayCanvases.get(pageNumber);
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const i of byPage.get(pageNumber) || []) {
      if (i !== currentIndex) drawRect(ctx, canvas, currentMatches[i], MATCH_COLOR);
    }
    const cur = currentMatches[currentIndex];
    if (cur && cur.pageNumber === pageNumber) drawRect(ctx, canvas, cur, CURRENT_COLOR);
  },

  /** Clear every highlight (keeps the canvases). */
  clearAll() {
    for (const canvas of overlayCanvases.values()) {
      canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    }
  },

  /** Forget everything (new document: the old page divs are gone). */
  reset() {
    Overlay.clearAll();
    for (const canvas of overlayCanvases.values()) canvas.remove();
    overlayCanvases.clear();
    setMatches([], -1);
  },

  /**
   * Scroll a match into view using the PDF.js viewer API. The destination is
   * given in PDF user-space points (origin bottom-left), which is
   * independent of the zoom level. A little headroom is left above the
   * match so it does not sit at the very top edge of the viewport.
   *
   * Horizontally the match is centred in the viewport. The x of an XYZ
   * destination cannot be left out: PDF.js turns a null x into 0, which
   * scrolled to the page's left edge and hid matches on the right of a page
   * zoomed wider than the window. When the page fits the window, PDF.js
   * cannot scroll sideways and the x has no effect.
   */
  scrollTo(match) {
    if (!pdfViewer) return;
    const view = pdfViewer.getPageView(match.pageNumber - 1);
    if (!view || !view.pdfPage) {
      pdfViewer.currentPageNumber = match.pageNumber;
      return;
    }
    // Work in the displayed page (its viewport includes /Rotate and the view
    // rotation): the point that should come to the top left of the window,
    // converted back to PDF points, which PDF.js maps through the same
    // viewport. So /Rotate 90/270 pages and a rotated view scroll right too.
    const rotation = viewRotation();
    const vp = view.viewport ||
      view.pdfPage.getViewport({ scale: 1, rotation: ((view.pdfPage.rotate || 0) + rotation) % 360 });
    const box = rotateBox(match, rotation);
    const visibleW = pdfViewer.container?.clientWidth || 0;
    const left = Math.max(0, (box.x + box.w / 2) * vp.width - visibleW / 2);
    const top = Math.max(0, (box.y - Config.SCROLL_HEADROOM) * vp.height);
    const [destX, destY] = vp.convertToPdfPoint(left, top);
    pdfViewer.scrollPageIntoView({
      pageNumber: match.pageNumber,
      destArray: [null, { name: "XYZ" }, destX, destY, null],
    });
  },
};

/** Store the matches shown and index them by page. */
function setMatches(matches, current) {
  currentMatches = matches;
  currentIndex = current;
  byPage = new Map();
  matches.forEach((m, i) => {
    const list = byPage.get(m.pageNumber);
    if (list) list.push(i);
    else byPage.set(m.pageNumber, [i]);
  });
}

/** The viewer's own rotation of the pages (0, 90, 180, 270; clockwise). */
function viewRotation() {
  const r = Number(pdfViewer?.pagesRotation) || 0;
  return ((r % 360) + 360) % 360;
}

/**
 * A match's normalised box, turned clockwise by `rotation` degrees with
 * the page: its box on the displayed page, also normalised.
 * @returns {{x:number, y:number, w:number, h:number}}
 */
export function rotateBox(m, rotation) {
  const { x_norm: x, y_norm: y, w_norm: w, h_norm: h } = m;
  switch (rotation) {
    case 90: return { x: 1 - y - h, y: x, w: h, h: w };
    case 180: return { x: 1 - x - w, y: 1 - y - h, w, h };
    case 270: return { x: y, y: 1 - x - w, w: h, h: w };
    default: return { x, y, w, h };
  }
}

/** Draw one highlight; normalised coords → canvas pixels at draw time. */
function drawRect(ctx, canvas, match, color) {
  const box = rotateBox(match, viewRotation());
  const x = box.x * canvas.width;
  const y = box.y * canvas.height;
  const w = box.w * canvas.width;
  const h = box.h * canvas.height;
  const padX = Math.max(1, 0.08 * h);
  const padY = Math.max(1, 0.08 * h);
  ctx.fillStyle = color;
  ctx.fillRect(x - padX, y - padY, w + 2 * padX, h + 2 * padY);
  if (Config.SHOW_SCORE_LABELS && typeof match.score === "number") {
    drawScoreLabel(ctx, match.score, x, y - padY);
  }
}

/** Stamp a small "0.xx" label just above a box (inside it at the page top). */
function drawScoreLabel(ctx, score, boxX, boxY) {
  const text = score.toFixed(2);
  const labelH = 13;
  const padding = 2;
  ctx.font = "10px ui-monospace, monospace";
  const textWidth = ctx.measureText(text).width;
  const labelY = boxY - labelH >= 0 ? boxY - labelH : boxY;
  ctx.fillStyle = "rgba(0, 0, 0, 0.78)";
  ctx.fillRect(boxX, labelY, textWidth + padding * 2, labelH);
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.fillText(text, boxX + padding, labelY + labelH / 2);
}
