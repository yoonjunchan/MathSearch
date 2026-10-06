/**
 * snip.js — Drag a rectangle over a PDF page to use it as the search
 * template ("search by screenshot").
 *
 * While snipping, the viewer container gets the class `ms-snipping`: a
 * crosshair cursor, and the text and annotation layers stop taking pointer
 * events, so a drag neither selects text nor follows a link. The pointer
 * listeners sit on the container in the capture phase; the wheel is left
 * alone, so the document still scrolls while snipping.
 *
 * The rectangle is returned in normalised [0,1] coordinates of the page it
 * was drawn on, the same convention as the matches (x_norm …), so it maps
 * onto any raster of that page: the page's own frame, turned back from the
 * viewer's rotation if there is one (see toPageRect).
 */

import { Config } from "./config.js";
import { rotateBox } from "./overlay.js";

let active = null; // {container, box, finish} while snipping

export const Snip = {
  /**
   * Let the user drag a rectangle over a page. Escape or a click without a
   * drag cancels.
   * @param {Object} pdfViewer  PDF.js PDFViewer (getPageView, pagesCount)
   * @returns {Promise<{pageNumber:number, rect:{x:number, y:number,
   *   w:number, h:number}}|null>}  null when cancelled or not on a page
   */
  start(pdfViewer) {
    Snip.cancel();
    const container = document.getElementById("viewerContainer") || document.body;
    injectStyles();
    container.classList.add("ms-snipping");

    const box = document.createElement("div");
    box.id = "ms-snip-box";
    box.hidden = true;
    document.body.appendChild(box);

    return new Promise((resolve) => {
      let drag = null; // {pointerId, x0, y0, x1, y1} in client coords

      const onDown = (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        drag = { pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
        container.setPointerCapture?.(e.pointerId);
        drawBox(box, drag);
      };
      const onMove = (e) => {
        if (!drag || e.pointerId !== drag.pointerId) return;
        e.preventDefault();
        drag.x1 = e.clientX;
        drag.y1 = e.clientY;
        drawBox(box, drag);
      };
      const onUp = (e) => {
        if (!drag || e.pointerId !== drag.pointerId) return;
        e.preventDefault();
        e.stopPropagation();
        drag.x1 = e.clientX;
        drag.y1 = e.clientY;
        container.releasePointerCapture?.(e.pointerId);
        finish(toPageRect(pdfViewer, drag));
      };
      // Swallow the click that ends the drag (links, PDF.js handlers).
      const onClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
      };
      const onKey = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          finish(null);
        }
      };

      const finish = (result) => {
        container.removeEventListener("pointerdown", onDown, true);
        container.removeEventListener("pointermove", onMove, true);
        container.removeEventListener("pointerup", onUp, true);
        container.removeEventListener("pointercancel", onCancel, true);
        document.removeEventListener("keydown", onKey, true);
        container.classList.remove("ms-snipping");
        box.remove();
        // The click fires after pointerup; drop the swallower once it has.
        setTimeout(() => container.removeEventListener("click", onClick, true), 0);
        active = null;
        resolve(result);
      };
      const onCancel = () => finish(null);

      container.addEventListener("pointerdown", onDown, true);
      container.addEventListener("pointermove", onMove, true);
      container.addEventListener("pointerup", onUp, true);
      container.addEventListener("pointercancel", onCancel, true);
      container.addEventListener("click", onClick, true);
      document.addEventListener("keydown", onKey, true);
      active = { finish };
    });
  },

  /** Abort a running snip (its promise resolves to null). */
  cancel() {
    if (active) active.finish(null);
  },

  isActive() {
    return active !== null;
  },
};

/** Position the dashed selection box (client coordinates). */
function drawBox(box, d) {
  box.hidden = false;
  Object.assign(box.style, {
    left: `${Math.min(d.x0, d.x1)}px`,
    top: `${Math.min(d.y0, d.y1)}px`,
    width: `${Math.abs(d.x1 - d.x0)}px`,
    height: `${Math.abs(d.y1 - d.y0)}px`,
  });
}

/**
 * The page under the centre of the dragged rectangle, and the rectangle
 * clipped to that page in its normalised coordinates.
 *
 * Measured against the page div's content box: PDF.js gives each page a 9px
 * transparent border (--page-border), which getBoundingClientRect includes
 * but the rendered page does not. Normalising against the border box shifted
 * the snip by up to ±9 CSS px, depending on where on the page it was drawn.
 * With the view rotated (pdfViewer.pagesRotation), the rectangle is turned
 * back into the page's own frame, where it is rendered and matched.
 */
function toPageRect(pdfViewer, d) {
  const left = Math.min(d.x0, d.x1);
  const right = Math.max(d.x0, d.x1);
  const top = Math.min(d.y0, d.y1);
  const bottom = Math.max(d.y0, d.y1);
  if (right - left < Config.SNIP_MIN_DRAG_PX || bottom - top < Config.SNIP_MIN_DRAG_PX) return null;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  for (let i = 0; i < pdfViewer.pagesCount; i++) {
    const view = pdfViewer.getPageView(i);
    if (!view || !view.div) continue;
    const div = view.div;
    const b = div.getBoundingClientRect();
    const pl = b.left + div.clientLeft;
    const pt = b.top + div.clientTop;
    const pw = div.clientWidth;
    const ph = div.clientHeight;
    if (!pw || !ph || cx < pl || cx > pl + pw || cy < pt || cy > pt + ph) continue;
    const x0 = Math.max(left, pl);
    const y0 = Math.max(top, pt);
    const x1 = Math.min(right, pl + pw);
    const y1 = Math.min(bottom, pt + ph);
    const shown = { x_norm: (x0 - pl) / pw, y_norm: (y0 - pt) / ph, w_norm: (x1 - x0) / pw, h_norm: (y1 - y0) / ph };
    const rotation = ((Number(pdfViewer.pagesRotation) || 0) % 360 + 360) % 360;
    return { pageNumber: i + 1, rect: rotateBox(shown, (360 - rotation) % 360) };
  }
  return null;
}

/** One-time injection of the snip styles. */
function injectStyles() {
  if (document.getElementById("ms-snip-style")) return;
  const style = document.createElement("style");
  style.id = "ms-snip-style";
  style.textContent = `
    .ms-snipping, .ms-snipping * { cursor: crosshair !important; }
    .ms-snipping .textLayer, .ms-snipping .annotationLayer { pointer-events: none !important; }
    .ms-snipping { user-select: none; }
    #ms-snip-box {
      position: fixed;
      z-index: 9999;
      border: 1.5px dashed #b58900;
      background: rgba(255, 213, 79, 0.18);
      pointer-events: none;
    }
    #ms-snip-box[hidden] { display: none; }
  `;
  document.head.appendChild(style);
}
