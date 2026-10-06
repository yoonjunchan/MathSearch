/**
 * matching.js — Component-anchored template matching.
 *
 * Pure module: no DOM, no PDF.js. Runs in Node (test bench) and in the
 * browser. All images are flat Uint8Array binaries (1 = ink).
 *
 * Pipeline per page
 * ─────────────────
 *   1. The template (rendered KaTeX, binarized, tightly cropped) is analysed
 *      once: its connected components are found and the largest one or two
 *      (by ink) become *anchors*.
 *   2. Every page component (and every cluster of touching components) is
 *      tested as a possible location of each anchor, using cheap geometry
 *      only: the height and width ratios give the template → page scale for
 *      free, and are rejected only when they disagree with each other or the
 *      ink density is far off. This gate is deliberately loose.
 *   3. For each surviving candidate the whole template is rescaled to the
 *      implied scale (cached per scale), aligned so that its anchor sits on
 *      the candidate, and scored at every integer offset within ±JITTER_PX
 *      and at a couple of refined scales. The best position is kept.
 *   4. Scoring is a truncated symmetric chamfer score in [0, 1]:
 *        forward = mean over template ink of  w(dist to nearest page ink)
 *        reverse = mean over page ink in the window (plus any attached
 *                  sub/superscript, dot or accent components) of
 *                  w(dist to nearest template ink)
 *        score   = harmonic mean(forward, reverse)
 *      with w(d) = max(0, 1 − d / cap). The forward term reads a page-level
 *      distance transform (computed once per page); the reverse term reads
 *      the template's own padded distance transform, so it is window-local
 *      and has no score floor from surrounding ink.
 *   5. Overlapping reports are de-duplicated (best score wins) and sorted
 *      into reading order.
 *
 * Why anchors instead of segmentation boxes: a component's bounding box is
 * intrinsic to the glyph, so scale and position come from the glyph itself
 * rather than from a box whose extent was set by kerning or by a taller
 * neighbour. There is no aspect-ratio filter, no width gate, and no
 * HEIGHT_SCALES list to maintain.
 */

import { Config } from "./config.js";
import { Segmentation } from "./segmentation.js";

export const Matching = {
  prepareTemplate,
  findMatchesOnPage,
  distanceTransform: chamferDT,
  rescaleBinary,
  sortReadingOrder,
  rotateTemplate,
  dedupe,
  /** Internals exposed for the test bench only. */
  _internals: { getScaled: (t, s) => getScaled(t, s), scoreAt: (...a) => scoreAt(...a),
                findAttachedInk: (...a) => findAttachedInk(...a),
                isPunctuationShape: (...a) => isPunctuationShape(...a) },
};

/* ═══════════════════════════════════════════════════════════════════════════
 * Template preparation
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * @typedef {Object} Template
 * @property {Uint8Array} binary   tight-cropped binary image (1 = ink)
 * @property {number} w
 * @property {number} h
 * @property {number} ink          total ink pixels
 * @property {Array}  ccs          components of the template
 * @property {Array}  anchors      components used for alignment (largest first)
 * @property {Map}    scaled       cache: quantised scale → ScaledTemplate
 */

/**
 * Analyse a binarized, tightly cropped template image.
 *
 * @param {Uint8Array} binary
 * @param {number} w
 * @param {number} h
 * @returns {Template|null}  null when the image has no usable ink
 */
function prepareTemplate(binary, w, h) {
  if (!w || !h) return null;
  let ink = 0;
  for (let i = 0; i < binary.length; i++) ink += binary[i];
  if (ink === 0) return null;

  const ccs = Segmentation.labelComponents(binary, w, h, 1);
  if (ccs.length === 0) return null;
  const clusters = Segmentation.clusterComponents(ccs, Config.CLUSTER_GAP_PX);

  // Anchor choice.
  //  1. The largest cluster of touching components, if any. A glyph that is
  //     one piece on the page may be two pieces in the KaTeX rendering (or
  //     vice versa: page clusters are candidates too); the cluster bbox is
  //     what a single-piece page glyph will line up with.
  //  2. The largest components by ink. A very small further component (a
  //     dot, a prime) is a poor anchor because its bbox is dominated by
  //     rasterisation noise, so it is only used above ANCHOR_MIN_INK_RATIO.
  const byInk = ccs.slice().sort((a, b) => b.ink - a.ink);
  const anchors = [];
  if (clusters.length) {
    anchors.push(clusters.slice().sort((a, b) => b.ink - a.ink)[0]);
  }
  anchors.push(byInk[0]);
  for (let i = 1; i < byInk.length && anchors.length < Config.MAX_ANCHORS; i++) {
    if (byInk[i].ink >= Config.ANCHOR_MIN_INK_RATIO * byInk[0].ink) {
      anchors.push(byInk[i]);
    }
  }
  for (const a of anchors) a.density = a.ink / (a.w * a.h);

  return { binary, w, h, ink, ccs, clusters, anchors, scaled: new Map() };
}

/**
 * The template turned by `quarterTurns` × 90° counterclockwise, for pages
 * whose text runs sideways (DESIGN.md, "How it works", rotated pages). A quarter turn of a
 * binary image is exact, so the scores are those of an upright match.
 * Cached on the template.
 * @param {Template} template
 * @param {number} quarterTurns  0–3
 * @returns {Template}
 */
function rotateTemplate(template, quarterTurns) {
  const k = ((quarterTurns % 4) + 4) % 4;
  if (k === 0) return template;
  if (!template.rotated) template.rotated = new Map();
  if (template.rotated.has(k)) return template.rotated.get(k);
  const { binary, w, h } = template;
  const rw = k === 2 ? w : h;
  const rh = k === 2 ? h : w;
  const out = new Uint8Array(rw * rh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!binary[y * w + x]) continue;
      // Counterclockwise on screen (y down): 1 turn (x, y) → (y, w−1−x).
      const [nx, ny] = k === 1 ? [y, w - 1 - x] : k === 2 ? [w - 1 - x, h - 1 - y] : [h - 1 - y, x];
      out[ny * rw + nx] = 1;
    }
  }
  const rotated = prepareTemplate(out, rw, rh);
  template.rotated.set(k, rotated);
  return rotated;
}

/**
 * @typedef {Object} ScaledTemplate
 * @property {number} scale
 * @property {number} w
 * @property {number} h
 * @property {number} ink
 * @property {Int32Array} inkX   x of every ink pixel (template coords)
 * @property {Int32Array} inkY
 * @property {Uint8Array} dt     padded chamfer (3-4) DT of the template
 * @property {number} pad        padding around dt (= DT_MAX)
 * @property {number} dtW        width of the padded dt
 * @property {Array<{cx:number, cy:number}>} anchors  scaled anchor centres
 * @property {Float32Array} weights  weight per DT value (1/3 px units)
 */

/** Scales are quantised to 1 % so that nearby candidates share a rescale. */
function scaleKey(scale) {
  return Math.round(scale * 100);
}

/**
 * Rescale the template to `scale` (cached by quantised scale).
 * @param {Template} template
 * @param {number} scale
 * @returns {ScaledTemplate}
 */
function getScaled(template, scale) {
  const key = scaleKey(scale);
  let st = template.scaled.get(key);
  if (st) return st;

  const s = key / 100;
  const w = Math.max(1, Math.round(template.w * s));
  const h = Math.max(1, Math.round(template.h * s));
  const binary = rescaleBinary(template.binary, template.w, template.h, w, h);

  let ink = 0;
  for (let i = 0; i < binary.length; i++) ink += binary[i];
  const inkX = new Int32Array(ink);
  const inkY = new Int32Array(ink);
  for (let y = 0, k = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (binary[y * w + x]) {
        inkX[k] = x;
        inkY[k] = y;
        k++;
      }
    }
  }

  // Padded DT so that page ink just outside the window still gets a
  // meaningful (large) distance instead of falling off the array.
  const pad = Config.DT_MAX;
  const dtW = w + 2 * pad;
  const dtH = h + 2 * pad;
  const padded = new Uint8Array(dtW * dtH);
  for (let y = 0; y < h; y++) {
    padded.set(binary.subarray(y * w, y * w + w), (y + pad) * dtW + pad);
  }
  const dt = chamferDT(padded, dtW, dtH, Config.DT_MAX);

  // Anchor centres in scaled coordinates. Scaling the bbox edges (rather
  // than the centre) keeps the rounding consistent with rescaleBinary.
  const anchors = template.anchors.map((a) => {
    const x0 = Math.floor(a.x0 * s);
    const x1 = Math.ceil((a.x1 + 1) * s) - 1;
    const y0 = Math.floor(a.y0 * s);
    const y1 = Math.ceil((a.y1 + 1) * s) - 1;
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, h: y1 - y0 + 1, w: x1 - x0 + 1 };
  });

  // Weight per distance-transform value (units of 1/3 px, see chamferDT).
  const refH = Math.max(h, Config.REFERENCE_HEIGHT_PT * Config.RENDER_SCALE);
  const cap = Math.max(Config.TOLERANCE_MIN_PX, Config.TOLERANCE_RATIO * refH);
  const weights = new Float32Array(dtLevels(Config.DT_MAX));
  for (let v = 0; v < weights.length; v++) {
    const d = v / 3;
    switch (Config.WEIGHT_SHAPE) {
      case "step":
        weights[v] = d <= cap ? 1 : 0;
        break;
      case "quadratic":
        weights[v] = d < cap ? (1 - d / cap) ** 2 : 0;
        break;
      case "smooth":
        weights[v] = d < cap ? 1 - (d / cap) ** 2 : 0;
        break;
      case "linear":
      default:
        weights[v] = Math.max(0, 1 - d / cap);
    }
  }

  st = { scale: s, w, h, binary, ink, inkX, inkY, dt, pad, dtW, anchors, weights };
  template.scaled.set(key, st);
  return st;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Page matching
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * @typedef {Object} PageData
 * @property {Uint8Array} binary
 * @property {number} w
 * @property {number} h
 * @property {Array} ccs         components (Segmentation.analyze)
 * @property {Array} clusters    merged touching components
 * @property {Array} byX0        components sorted by x0
 * @property {Uint8Array} [dt]   page DT (computed here when missing)
 */

/**
 * Find every occurrence of the template on one page.
 *
 * @param {Template} template
 * @param {PageData} page
 * @param {{threshold?: number, keepAll?: boolean, attachedInk?: boolean}} [opts]
 *        keepAll: return every scored candidate regardless of threshold
 *        (debugging / calibration). attachedInk: count sub/superscripts and
 *        accents next to a match as unexplained ink (default
 *        Config.ATTACHED_INK; the panel's checkbox passes its own value).
 * @returns {Array<{x:number,y:number,w:number,h:number,score:number,
 *                  forward:number,reverse:number,scale:number}>}
 *          windows in page px, best score first (call sortReadingOrder
 *          for document order).
 */
function findMatchesOnPage(template, page, opts = {}) {
  const threshold = opts.threshold ?? Config.SIMILARITY_THRESHOLD;
  const keepAll = !!opts.keepAll;
  const attachedInk = opts.attachedInk ?? Config.ATTACHED_INK;
  const { binary, w: W, h: H } = page;
  if (!page.dt) page.dt = chamferDT(binary, W, H, Config.DT_MAX);
  const pageDT = page.dt;

  const candidates = page.clusters.length
    ? page.ccs.concat(page.clusters)
    : page.ccs;

  const raw = [];
  const stats = { candidates: candidates.length * template.anchors.length, gated: 0, scored: 0, pruned: 0 };

  for (let ai = 0; ai < template.anchors.length; ai++) {
    const anchor = template.anchors[ai];

    for (const cand of candidates) {
      // ── Cheap geometric gate ────────────────────────────────────────────
      const sH = cand.h / anchor.h;
      const sW = cand.w / anchor.w;
      if (sH < Config.SCALE_MIN || sH > Config.SCALE_MAX) continue;
      if (sW < Config.SCALE_MIN || sW > Config.SCALE_MAX) continue;
      if (Math.abs(sW / sH - 1) > Config.SCALE_ASYMMETRY_MAX) continue;
      const density = cand.ink / (cand.w * cand.h);
      if (Math.abs(density / anchor.density - 1) > Config.DENSITY_TOLERANCE) continue;
      // Below a handful of pixels every shape looks like every other shape.
      if (template.h * sH < Config.MIN_SCALED_HEIGHT_PX) continue;
      stats.gated++;

      const s0 = (sH + sW) / 2;
      let best = null;

      // ── Scale refinement × jitter search ────────────────────────────────
      // Only the best placement is kept, so a placement's reverse term is
      // skipped when even a perfect one could not beat the best so far or
      // reach the threshold (see scoreAt). Results are unchanged. Trying the
      // unshifted placement first was measured: 0.3 % more skipped, no gain.
      for (const s of refinedScales(s0)) {
        const st = getScaled(template, s);
        const a = st.anchors[ai];
        const ox0 = Math.round(cand.cx - a.cx);
        const oy0 = Math.round(cand.cy - a.cy);
        const J = Config.JITTER_PX;
        for (let dy = -J; dy <= J; dy++) {
          for (let dx = -J; dx <= J; dx++) {
            let floor = best ? best.score : -Infinity;
            if (!keepAll) floor = Math.max(floor, threshold);
            const r = scoreAt(st, page, pageDT, ox0 + dx, oy0 + dy, floor, attachedInk);
            stats.scored++;
            if (r === null) {
              stats.pruned++;
              continue;
            }
            if (!best || r.score > best.score) {
              best = { x: ox0 + dx, y: oy0 + dy, w: st.w, h: st.h, scale: s, ...r };
            }
          }
        }
      }

      if (best && (keepAll || best.score >= threshold)) raw.push(best);
    }
  }

  const matches = dedupe(raw);
  matches.sort((a, b) => b.score - a.score);
  matches.stats = stats;
  return matches;
}

/** The anchor-implied scale plus symmetric refinements around it. */
function refinedScales(s0) {
  const out = [s0];
  for (const eps of Config.SCALE_REFINE) {
    out.push(s0 * (1 - eps), s0 * (1 + eps));
  }
  return out;
}

/**
 * Score the scaled template placed with its top-left at (ox, oy) on the page.
 *
 * The reverse term is at most 1 and every SCORE_COMBINE rule grows with it,
 * so once the forward term is known the score cannot exceed
 * combine(forward, 1). If that ceiling is below `floor`, the costlier reverse
 * term is skipped and null is returned. The caller passes as `floor` the
 * score this placement must reach to matter.
 *
 * @param {number} [floor] skip the reverse term when the ceiling is below this
 * @param {boolean} [attachedInk] count attached scripts/accents (findMatchesOnPage)
 * @returns {{score:number, forward:number, reverse:number}|null}
 */
function scoreAt(st, page, pageDT, ox, oy, floor = -Infinity, attachedInk = Config.ATTACHED_INK) {
  const { w: W, h: H, binary } = page;
  const { inkX, inkY, ink, dt, pad, dtW, weights, w, h } = st;
  // ── Forward: template ink → nearest page ink ────────────────────────────
  let fsum = 0;
  for (let i = 0; i < ink; i++) {
    const x = ox + inkX[i];
    const y = oy + inkY[i];
    if (x < 0 || y < 0 || x >= W || y >= H) continue; // weight 0 off-page
    fsum += weights[pageDT[y * W + x]];
  }
  // A strong downscale can leave a thin template with no ink at all; 0/0
  // would give a NaN score that no later placement could replace.
  const forward = ink ? fsum / ink : 0;
  if (forward === 0) return { score: 0, forward: 0, reverse: 0 };
  // The margin keeps float rounding from skipping a placement that could tie
  // or win: skipping must never change a result.
  if (combine(forward, 1) < floor - 1e-9) return null;

  // ── Reverse: page ink in the window → nearest template ink ──────────────
  let rsum = 0;
  let rcount = 0;
  const x0 = Math.max(0, ox);
  const y0 = Math.max(0, oy);
  const x1 = Math.min(W, ox + w);
  const y1 = Math.min(H, oy + h);
  for (let y = y0; y < y1; y++) {
    const rowOff = y * W;
    const dtRow = (y - oy + pad) * dtW - ox + pad;
    for (let x = x0; x < x1; x++) {
      if (binary[rowOff + x]) {
        rsum += weights[dt[dtRow + x]];
        rcount++;
      }
    }
  }

  // Attached scripts, dots and accents just outside the window count as
  // unexplained ink (unless the template's own ink lies near them, via the
  // padded DT).
  const attached = attachedInk ? findAttachedInk(page, ox, oy, w, h) : [];
  for (const c of attached) {
    const cy0 = Math.max(0, c.y0);
    const cy1 = Math.min(H - 1, c.y1);
    const cx0 = Math.max(0, c.x0);
    const cx1 = Math.min(W - 1, c.x1);
    for (let y = cy0; y <= cy1; y++) {
      const rowOff = y * W;
      const ty = y - oy + pad;
      const inDtRows = ty >= 0 && ty < dt.length / dtW;
      for (let x = cx0; x <= cx1; x++) {
        if (!binary[rowOff + x]) continue;
        if (x >= ox && x < ox + w && y >= oy && y < oy + h) continue; // already counted
        const tx = x - ox + pad;
        if (inDtRows && tx >= 0 && tx < dtW) rsum += weights[dt[ty * dtW + tx]];
        rcount++;
      }
    }
  }

  const reverse = rcount === 0 ? 0 : rsum / rcount;
  return { score: combine(forward, reverse), forward, reverse };
}

/** Combine the two directional terms into the reported score. */
function combine(forward, reverse) {
  switch (Config.SCORE_COMBINE) {
    case "min":
      return Math.min(forward, reverse);
    case "geometric":
      return Math.sqrt(forward * reverse);
    case "harmonic":
    default:
      return forward + reverse === 0 ? 0 : (2 * forward * reverse) / (forward + reverse);
  }
}

/**
 * Page components that are attached to the window [ox, ox+w) × [oy, oy+h)
 * but lie outside it, and therefore count as ink the template failed to
 * explain:
 *
 *   - sub/superscripts to the RIGHT of the window (Config.SCRIPT_*), and
 *   - small marks ABOVE or BELOW it — the dot of an "i", a hat, a bar, a
 *     tilde (Config.ACCENT_*). Thin rules that span the window (fraction
 *     bars, underlines) are deliberately excluded: a letter in a fraction
 *     should still match the bare letter.
 */
function findAttachedInk(page, ox, oy, w, h) {
  const byX0 = page.byX0;
  const right = ox + w;             // first column after the window
  const lo = right - 1;             // allow 1 px overlap with the window edge
  const hi = right + Config.SCRIPT_MAX_GAP * h;
  const minH = Config.SCRIPT_MIN_HEIGHT * h;
  const maxH = Config.SCRIPT_MAX_HEIGHT * h;
  const off = Config.SCRIPT_MIN_OFFSET * h;
  const overlap = Config.SCRIPT_MIN_OVERLAP * h;
  const top = oy;
  const bottom = oy + h - 1;

  const out = [];

  // ── Scripts to the right ────────────────────────────────────────────────
  for (let i = lowerBound(byX0, lo); i < byX0.length; i++) {
    const c = byX0[i];
    if (c.x0 > hi) break;
    if (c.h < minH || c.h > maxH) continue;
    // A script overlaps the base vertically and reaches beyond it on one
    // side: a subscript starts inside the window's vertical extent and ends
    // well below it; a superscript ends inside it and starts well above.
    // (The overlap requirement is what keeps glyphs on the next/previous
    // text line out.)
    const isSub = c.y0 <= bottom - overlap && c.y1 >= bottom + off;
    const isSuper = c.y1 >= top + overlap && c.y0 <= top - off;
    if (!isSub && !isSuper) continue;
    // A comma (or a semicolon's lower half) after the symbol sits where a
    // subscript would; tell it apart by its shape.
    if (isSub && !isSuper && isPunctuationShape(page, c)) continue;
    out.push(c);
  }

  // ── Accents / dots above or below ───────────────────────────────────────
  const accMaxH = Config.ACCENT_MAX_HEIGHT * h;
  const accGap = Config.ACCENT_MAX_GAP * h;
  const accMaxW = Config.ACCENT_MAX_WIDTH * w;
  for (let i = lowerBound(byX0, ox - accMaxW); i < byX0.length; i++) {
    const c = byX0[i];
    if (c.x0 >= right) break;
    if (c.x1 < ox || c.h > accMaxH || c.w > accMaxW) continue;
    // Mostly over/under the window, not merely brushing its corner.
    const overlap = Math.min(c.x1, right - 1) - Math.max(c.x0, ox) + 1;
    if (overlap < Config.ACCENT_MIN_OVERLAP * c.w) continue;
    // Thin rule spanning the window (fraction bar, underline): not an accent.
    if (c.h <= Config.RULE_MAX_THICKNESS_PX && c.w >= Config.RULE_MIN_WIDTH * w) continue;
    const above = c.y1 < top && top - c.y1 - 1 <= accGap;
    const below = c.y0 > bottom && c.y0 - bottom - 1 <= accGap;
    if (!above && !below) continue;
    out.push(c);
  }
  return out;
}

/**
 * Is component c shaped like a comma: a narrow "blob plus tail", whose widest
 * row lies near the top and spans most of its width (the round head, solid)
 * while its lower half is a thin tail (Config.PUNCT_*)? Real subscripts that
 * are as narrow (i, l, 1, j, a parenthesis) are widest at the bottom or in
 * the middle, or have a hollow top (a j whose hook broke off).
 */
function isPunctuationShape(page, c) {
  if (c.w > Config.PUNCT_MAX_ASPECT * c.h) return false;
  const { binary, w: W } = page;
  const headEnd = c.y0 + Math.max(1, Math.round(Config.PUNCT_HEAD_FRACTION * c.h));
  const tailFrom = c.y0 + Math.ceil(c.h / 2);
  let headMax = 0;
  let headInk = 0;
  let headSpan = 0;
  let restMax = 0;
  let tailMax = 0;
  for (let y = c.y0; y <= c.y1; y++) {
    let first = -1, last = -1, ink = 0;
    for (let x = c.x0; x <= c.x1; x++) {
      if (binary[y * W + x]) {
        if (first < 0) first = x;
        last = x;
        ink++;
      }
    }
    const span = first < 0 ? 0 : last - first + 1;
    if (y < headEnd) {
      headMax = Math.max(headMax, span);
      headInk += ink;
      headSpan += span;
    }
    else restMax = Math.max(restMax, span);
    if (y >= tailFrom) tailMax = Math.max(tailMax, span);
  }
  return headMax >= restMax && headMax >= Config.PUNCT_HEAD_MIN_WIDTH * c.w &&
         headInk >= Config.PUNCT_HEAD_SOLIDITY * headSpan &&
         tailMax <= Config.PUNCT_TAIL_MAX_WIDTH * c.w;
}

/** Index of the first component in byX0 with x0 >= value. */
function lowerBound(byX0, value) {
  let a = 0;
  let b = byX0.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (byX0[m].x0 < value) a = m + 1;
    else b = m;
  }
  return a;
}

/** Keep the best-scoring window among mutually overlapping ones. */
function dedupe(raw) {
  raw.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const m of raw) {
    let dup = false;
    for (const k of kept) {
      if (boxIoU(m, k) > Config.DEDUPE_IOU) {
        dup = true;
        break;
      }
    }
    if (!dup) kept.push(m);
  }
  return kept;
}

function boxIoU(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (inter === 0) return 0;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

/**
 * Sort matches (all on one page) into reading order: lines top to bottom,
 * then left to right within a line. Two matches share a line when their
 * vertical centres are within half the smaller height of each other.
 */
function sortReadingOrder(matches) {
  const byCy = matches.slice().sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
  const lines = [];
  for (const m of byCy) {
    const cy = m.y + m.h / 2;
    const line = lines[lines.length - 1];
    if (line && Math.abs(cy - line.cy) <= 0.5 * Math.min(m.h, line.h)) {
      line.items.push(m);
      // Keep a running representative height/centre for the line.
      line.h = Math.max(line.h, m.h);
    } else {
      lines.push({ cy, h: m.h, items: [m] });
    }
  }
  const out = [];
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    out.push(...line.items);
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Image helpers
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * Chamfer 3-4 distance to the nearest ink pixel: an integer approximation of
 * the Euclidean distance in which a horizontal/vertical step costs 3 and a
 * diagonal step costs 4 (so values are in units of 1/3 px, max error ≈ 8 %).
 * Exact two-pass raster algorithm. Values are capped at 3·maxD + 3, meaning
 * "farther than maxD px".
 *
 * The finer gradation matters for small glyphs: with a 2 px tolerance cap a
 * chessboard transform can only produce the weights {1, 0.5, 0}, whereas
 * this metric distinguishes 1 px, 1.33 px and 1.67 px offsets.
 *
 * @param {Uint8Array} binary
 * @param {number} w
 * @param {number} h
 * @param {number} maxD  cap in px
 * @returns {Uint8Array}  values 0 .. 3·maxD + 3
 */
function chamferDT(binary, w, h, maxD) {
  const far = 3 * maxD + 3;
  const d = new Uint8Array(w * h);

  // Forward pass: top-left → bottom-right, looking at NW, N, NE, W.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const up = row - w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (binary[i]) {
        d[i] = 0;
        continue;
      }
      let best = far;
      if (y > 0) {
        let v = d[up + x] + 3;
        if (v < best) best = v;
        if (x > 0) {
          v = d[up + x - 1] + 4;
          if (v < best) best = v;
        }
        if (x < w - 1) {
          v = d[up + x + 1] + 4;
          if (v < best) best = v;
        }
      }
      if (x > 0) {
        const v = d[i - 1] + 3;
        if (v < best) best = v;
      }
      d[i] = best > far ? far : best;
    }
  }

  // Backward pass: bottom-right → top-left, looking at SE, S, SW, E.
  for (let y = h - 1; y >= 0; y--) {
    const row = y * w;
    const down = row + w;
    for (let x = w - 1; x >= 0; x--) {
      const i = row + x;
      let best = d[i];
      if (best === 0) continue;
      if (y < h - 1) {
        let v = d[down + x] + 3;
        if (v < best) best = v;
        if (x > 0) {
          v = d[down + x - 1] + 4;
          if (v < best) best = v;
        }
        if (x < w - 1) {
          v = d[down + x + 1] + 4;
          if (v < best) best = v;
        }
      }
      if (x < w - 1) {
        const v = d[i + 1] + 3;
        if (v < best) best = v;
      }
      d[i] = best;
    }
  }
  return d;
}

/** Number of distinct values chamferDT can produce for a given cap. */
function dtLevels(maxD) {
  return 3 * maxD + 4;
}

/**
 * Resize a flat binary image. Downscaling (the normal case) uses area
 * averaging: an output pixel is ink when at least RESCALE_INK_FRACTION of
 * the source block it covers is ink — this keeps thin strokes alive.
 * Upscaling falls back to nearest neighbour.
 */
function rescaleBinary(src, fromW, fromH, toW, toH) {
  const out = new Uint8Array(toW * toH);
  const sx = fromW / toW;
  const sy = fromH / toH;
  const down = sx > 1 || sy > 1;

  for (let y = 0; y < toH; y++) {
    const dstRow = y * toW;
    if (down) {
      const y0 = Math.floor(y * sy);
      const y1 = Math.min(fromH, Math.max(y0 + 1, Math.ceil((y + 1) * sy)));
      for (let x = 0; x < toW; x++) {
        const x0 = Math.floor(x * sx);
        const x1 = Math.min(fromW, Math.max(x0 + 1, Math.ceil((x + 1) * sx)));
        let ink = 0;
        let total = 0;
        for (let yy = y0; yy < y1; yy++) {
          const srcRow = yy * fromW;
          for (let xx = x0; xx < x1; xx++) {
            ink += src[srcRow + xx];
            total++;
          }
        }
        out[dstRow + x] = total > 0 && ink / total >= Config.RESCALE_INK_FRACTION ? 1 : 0;
      }
    } else {
      const srcY = Math.min(fromH - 1, Math.round(y * sy));
      for (let x = 0; x < toW; x++) {
        const srcX = Math.min(fromW - 1, Math.round(x * sx));
        out[dstRow + x] = src[srcY * fromW + srcX];
      }
    }
  }
  return out;
}
