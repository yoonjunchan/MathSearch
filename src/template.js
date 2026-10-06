/**
 * template.js — Converts a rendered KaTeX canvas into a tight, binarized
 * template, and owns the single definition of binarization (shared with the
 * page index).
 *
 * `binarize` and `cropToInk` are pure (they take ImageData-shaped objects and
 * flat arrays) so the Node test bench can use them; only `buildTemplate`
 * touches a canvas.
 */

import { Config } from "./config.js";
import { Matching } from "./matching.js";

export const Template = {
  /**
   * Build a matching template from a rendered canvas.
   *
   * @param {HTMLCanvasElement} renderedCanvas  dark ink on light/transparent bg
   * @returns {import("./matching.js").Template|null}  null if there is no ink
   */
  buildTemplate(renderedCanvas) {
    const w = renderedCanvas.width;
    const h = renderedCanvas.height;
    if (w === 0 || h === 0) return null;
    const imageData = renderedCanvas.getContext("2d").getImageData(0, 0, w, h);
    return Template.fromImageData(imageData);
  },

  /** Same as buildTemplate but from ImageData (used by the test bench). */
  fromImageData(imageData) {
    const binary = binarize(imageData);
    const crop = cropToInk(binary, imageData.width, imageData.height);
    if (!crop) return null;
    return Matching.prepareTemplate(crop.binary, crop.w, crop.h);
  },

  /**
   * Template from a rectangle of an indexed page (search by snip). The
   * rectangle is cut out of the page's binarised raster, so the template is
   * exactly what the matcher sees on the pages, at scale ≈ 1.
   *
   * @param {{binary: Uint8Array, w: number, h: number}} pageData
   * @param {{x: number, y: number, w: number, h: number}} rect  normalised
   *        [0,1] page coordinates, like the matches' x_norm … h_norm
   * @returns {import("./matching.js").Template|null}  null if there is no ink
   */
  fromPageRegion(pageData, rect) {
    const x0 = Math.max(0, Math.floor(rect.x * pageData.w));
    const y0 = Math.max(0, Math.floor(rect.y * pageData.h));
    const x1 = Math.min(pageData.w, Math.ceil((rect.x + rect.w) * pageData.w));
    const y1 = Math.min(pageData.h, Math.ceil((rect.y + rect.h) * pageData.h));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) return null;
    const region = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const src = (y0 + y) * pageData.w + x0;
      region.set(pageData.binary.subarray(src, src + w), y * w);
    }
    const crop = cropToInk(region, w, h);
    if (!crop) return null;
    return Matching.prepareTemplate(crop.binary, crop.w, crop.h);
  },

  binarize,
  cropToInk,
};

/**
 * Binarize RGBA pixels into a flat Uint8Array of 0 (background) / 1 (ink).
 *
 * Transparent pixels (alpha ≈ 0) are background: KaTeX renders on a
 * transparent backdrop, and "no paint" must never read as ink.
 *
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} imageData
 * @returns {Uint8Array}
 */
function binarize(imageData) {
  const { data, width, height } = imageData;
  const out = new Uint8Array(width * height);
  const thr = Config.BINARIZE_THRESHOLD;
  const lr = Config.LUMA_R;
  const lg = Config.LUMA_G;
  const lb = Config.LUMA_B;
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    if (data[p + 3] < 16) continue; // transparent ⇒ background
    const lum = lr * data[p] + lg * data[p + 1] + lb * data[p + 2];
    if (lum < thr) out[i] = 1;
  }
  return out;
}

/**
 * Crop a binary image to the tight bounding box of its ink.
 * @returns {{binary: Uint8Array, w: number, h: number, x0: number, y0: number}|null}
 */
function cropToInk(binary, w, h) {
  let top = -1;
  let bottom = -1;
  let left = w;
  let right = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let any = false;
    for (let x = 0; x < w; x++) {
      if (binary[row + x]) {
        any = true;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
    if (any) {
      if (top === -1) top = y;
      bottom = y;
    }
  }
  if (top === -1) return null;
  const cw = right - left + 1;
  const ch = bottom - top + 1;
  const out = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    const src = (top + y) * w + left;
    out.set(binary.subarray(src, src + cw), y * cw);
  }
  return { binary: out, w: cw, h: ch, x0: left, y0: top };
}
