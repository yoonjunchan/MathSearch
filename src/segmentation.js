/**
 * segmentation.js — Connected-component analysis of a binarized page.
 *
 * Pure module: no DOM, no PDF.js. Everything here operates on flat
 * Uint8Array binary images (1 = ink, 0 = background) and is safe to run in
 * Node or a Web Worker.
 *
 * Design (v1.0): the page is NOT cut into word boxes any more. Instead the
 * *connected components* (CCs) of the ink are extracted and used by the
 * matcher as alignment anchors. A CC's bounding box is intrinsic to the glyph
 * it belongs to — it does not depend on kerning, neighbouring punctuation,
 * inter-word gaps or the height of a taller neighbour on the same line —
 * which removes the whole class of "the box does not coincide with the
 * symbol" failures that projection-profile segmentation produced.
 *
 * Two candidate sets are produced per page:
 *   - `ccs`      : every 8-connected component with at least MIN_CC_PIXELS ink
 *   - `clusters` : groups of CCs whose bounding boxes touch or come within
 *                  CLUSTER_GAP_PX of each other (e.g. a glyph that rasterised
 *                  as two pieces at a thin join, or an "i"/"j" with its dot).
 *                  Only clusters with ≥ 2 members are kept; singles are
 *                  already in `ccs`.
 *
 * Components are found with a run-length / union-find labelling pass, which
 * needs no per-pixel label array (important at 4–5 megapixels per page).
 */

import { Config } from "./config.js";

/**
 * @typedef {Object} Component
 * @property {number} x0  left   (inclusive, px)
 * @property {number} y0  top    (inclusive, px)
 * @property {number} x1  right  (inclusive, px)
 * @property {number} y1  bottom (inclusive, px)
 * @property {number} w   x1 - x0 + 1
 * @property {number} h   y1 - y0 + 1
 * @property {number} ink number of ink pixels
 * @property {number} cx  ink-bbox centre x  (x0 + (w - 1) / 2)
 * @property {number} cy  ink-bbox centre y
 * @property {number} [members] number of CCs merged (clusters only)
 */

export const Segmentation = {
  /**
   * Full page analysis: components, clusters, and an index of components
   * sorted by left edge (used by the matcher to find script attachments).
   *
   * @param {Uint8Array} binary  flat page image, 1 = ink
   * @param {number} w
   * @param {number} h
   * `runs` are the horizontal ink runs found on the way (row by row, left
   * to right), which compact() stores instead of scanning the image again.
   * @returns {{ccs: Component[], clusters: Component[], byX0: Component[],
   *   runs: {n: number, y: Int32Array, x0: Int32Array, x1: Int32Array}}}
   */
  analyze(binary, w, h) {
    const runs = {};
    const ccs = labelComponents(binary, w, h, Config.MIN_CC_PIXELS, runs);
    const clusters = clusterComponents(ccs, Config.CLUSTER_GAP_PX);
    const byX0 = ccs.slice().sort((a, b) => a.x0 - b.x0);
    return { ccs, clusters, byX0, runs };
  },

  labelComponents,
  clusterComponents,
  packBits,
  unpackBits,
  compact,
  expand,
  compactBytes,
};

// ── Compact page form (the page index's cache) ──────────────────────────────
// A page's binary image plus its components as typed arrays only: about
// 2.5× smaller than packed bits + component objects (a text page is ≈ 3 %
// ink, so horizontal runs are far fewer than pixels, and a component object
// costs ≈ 165 bytes against 20 here). expand() rebuilds exactly what
// analyze() returned (same objects, same order), so matching is unchanged.

const COMP_FIELDS = 5;    // x0, y0, x1, y1, ink
const CLUSTER_FIELDS = 6; // x0, y0, x1, y1, ink, members

/**
 * @param {Uint8Array} binary
 * @param {number} w
 * @param {number} h
 * @param {{ccs: Component[], clusters: Component[], byX0: Component[], runs?: Object}} seg
 *   analyze() result; without `runs` the image is scanned for them
 * @returns {Object} compact page: w, h, rowStart, runs, comps, clusters, byX0
 */
function compact(binary, w, h, seg) {
  const found = seg.runs?.y ? seg.runs : labelRuns(binary, w, h);
  // Runs per row: rowStart[y] .. rowStart[y+1] index pairs (x0, length) in `runs`.
  const n = found.n;
  const rowStart = new Uint32Array(h + 1);
  const runs = w < 65536 ? new Uint16Array(2 * n) : new Uint32Array(2 * n);
  let y = 0;
  for (let r = 0; r < n; r++) {
    while (y <= found.y[r]) rowStart[y++] = r;
    runs[2 * r] = found.x0[r];
    runs[2 * r + 1] = found.x1[r] - found.x0[r] + 1;
  }
  while (y <= h) rowStart[y++] = n;

  const comps = new Int32Array(seg.ccs.length * COMP_FIELDS);
  const indexOf = new Map();
  seg.ccs.forEach((c, i) => {
    const p = i * COMP_FIELDS;
    comps[p] = c.x0; comps[p + 1] = c.y0; comps[p + 2] = c.x1; comps[p + 3] = c.y1; comps[p + 4] = c.ink;
    indexOf.set(c, i);
  });
  const clusters = new Int32Array(seg.clusters.length * CLUSTER_FIELDS);
  seg.clusters.forEach((c, i) => {
    const p = i * CLUSTER_FIELDS;
    clusters[p] = c.x0; clusters[p + 1] = c.y0; clusters[p + 2] = c.x1; clusters[p + 3] = c.y1;
    clusters[p + 4] = c.ink; clusters[p + 5] = c.members;
  });
  const byX0 = new Uint32Array(seg.byX0.length);
  seg.byX0.forEach((c, i) => { byX0[i] = indexOf.get(c); });
  return { w, h, rowStart, runs, comps, clusters, byX0 };
}

/**
 * Inverse of compact(): the binary image and the component objects.
 * @returns {{binary: Uint8Array, ccs: Component[], clusters: Component[], byX0: Component[]}}
 */
function expand(c) {
  const { w, h, rowStart, runs } = c;
  const binary = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let r = rowStart[y]; r < rowStart[y + 1]; r++) {
      const x0 = runs[2 * r];
      binary.fill(1, off + x0, off + x0 + runs[2 * r + 1]);
    }
  }
  const ccs = new Array(c.comps.length / COMP_FIELDS);
  for (let i = 0, p = 0; i < ccs.length; i++, p += COMP_FIELDS) {
    const k = c.comps;
    ccs[i] = finalizeBox({ x0: k[p], y0: k[p + 1], x1: k[p + 2], y1: k[p + 3], w: 0, h: 0, ink: k[p + 4], cx: 0, cy: 0 });
  }
  const clusters = new Array(c.clusters.length / CLUSTER_FIELDS);
  for (let i = 0, p = 0; i < clusters.length; i++, p += CLUSTER_FIELDS) {
    const k = c.clusters;
    clusters[i] = finalizeBox({ x0: k[p], y0: k[p + 1], x1: k[p + 2], y1: k[p + 3], ink: k[p + 4], members: k[p + 5], w: 0, h: 0, cx: 0, cy: 0 });
  }
  const byX0 = Array.from(c.byX0, (i) => ccs[i]);
  return { binary, ccs, clusters, byX0 };
}

/** The runs of an image, as labelComponents reports them (for compact()). */
function labelRuns(binary, w, h) {
  const runs = {};
  labelComponents(binary, w, h, Infinity, runs);
  return runs;
}

/** Bytes held by a compact page (its typed arrays). */
function compactBytes(c) {
  return c.rowStart.byteLength + c.runs.byteLength + c.comps.byteLength + c.clusters.byteLength + c.byX0.byteLength;
}

/**
 * 8-connected component labelling of a binary image using horizontal runs.
 *
 * Runs on consecutive rows are joined when they overlap or are diagonally
 * adjacent (8-connectivity: run A on row y-1 and run B on row y are joined
 * when A.x1 >= B.x0 - 1 && A.x0 <= B.x1 + 1). Union-find over run indices
 * gives the components; a second pass over the runs accumulates bounding
 * boxes and ink counts.
 *
 * @param {Uint8Array} binary
 * @param {number} w
 * @param {number} h
 * @param {number} minPixels  components with fewer ink pixels are dropped
 * @param {Object} [runsOut]  if given, receives the runs: {n, y, x0, x1}
 *   (typed arrays, the first n entries valid; row-major order)
 * @returns {Component[]}
 */
function labelComponents(binary, w, h, minPixels, runsOut) {
  // ── Pass 1: extract runs and union overlapping runs of consecutive rows ──
  // Runs are stored in growable typed arrays: (y, x0, x1) per run.
  let cap = 1 << 16;
  let runY = new Int32Array(cap);
  let runX0 = new Int32Array(cap);
  let runX1 = new Int32Array(cap);
  let parent = new Int32Array(cap);
  let nRuns = 0;

  const grow = () => {
    cap *= 2;
    const g = (old) => {
      const n = new Int32Array(cap);
      n.set(old);
      return n;
    };
    runY = g(runY);
    runX0 = g(runX0);
    runX1 = g(runX1);
    parent = g(parent);
  };

  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]; // path halving
      i = parent[i];
    }
    return i;
  };
  const union = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[b] = a;
  };

  let prevStart = 0; // index of the first run on the previous row
  let prevEnd = 0;   // one past the last run on the previous row

  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    const curStart = nRuns;
    let x = 0;
    while (x < w) {
      if (binary[rowOff + x] === 0) {
        x++;
        continue;
      }
      const x0 = x;
      while (x < w && binary[rowOff + x] !== 0) x++;
      const x1 = x - 1;
      if (nRuns === cap) grow();
      runY[nRuns] = y;
      runX0[nRuns] = x0;
      runX1[nRuns] = x1;
      parent[nRuns] = nRuns;
      nRuns++;
    }
    const curEnd = nRuns;

    // Join with the previous row's runs (both lists are x-sorted; merge-walk).
    let p = prevStart;
    for (let c = curStart; c < curEnd; c++) {
      const cx0 = runX0[c] - 1; // 8-connectivity: 1 px diagonal slack
      const cx1 = runX1[c] + 1;
      // Skip previous runs entirely to the left of this run.
      while (p < prevEnd && runX1[p] < cx0) p++;
      for (let q = p; q < prevEnd && runX0[q] <= cx1; q++) {
        union(q, c);
      }
    }
    prevStart = curStart;
    prevEnd = curEnd;
  }

  if (runsOut) Object.assign(runsOut, { n: nRuns, y: runY, x0: runX0, x1: runX1 });

  // ── Pass 2: accumulate bounding boxes per root ───────────────────────────
  const rootIndex = new Int32Array(nRuns).fill(-1);
  const comps = [];
  for (let i = 0; i < nRuns; i++) {
    const r = find(i);
    let k = rootIndex[r];
    if (k === -1) {
      k = comps.length;
      rootIndex[r] = k;
      comps.push({
        x0: runX0[i], y0: runY[i], x1: runX1[i], y1: runY[i],
        w: 0, h: 0, ink: 0, cx: 0, cy: 0,
      });
    }
    const c = comps[k];
    if (runX0[i] < c.x0) c.x0 = runX0[i];
    if (runX1[i] > c.x1) c.x1 = runX1[i];
    if (runY[i] < c.y0) c.y0 = runY[i];
    if (runY[i] > c.y1) c.y1 = runY[i];
    c.ink += runX1[i] - runX0[i] + 1;
  }

  const out = [];
  for (const c of comps) {
    if (c.ink < minPixels) continue;
    finalizeBox(c);
    out.push(c);
  }
  return out;
}

/** Fill in w, h, cx, cy from the inclusive bounds. */
function finalizeBox(c) {
  c.w = c.x1 - c.x0 + 1;
  c.h = c.y1 - c.y0 + 1;
  c.cx = c.x0 + (c.w - 1) / 2;
  c.cy = c.y0 + (c.h - 1) / 2;
  return c;
}

/**
 * Merge components whose bounding boxes touch or come within `gap` px.
 *
 * Returns only clusters with two or more members: these are additional
 * anchor candidates for glyphs that rasterised as several pieces.
 * Single components are not duplicated here.
 *
 * Complexity: components are sorted by x0; each component is compared with
 * later ones until their x0 exceeds its x1 + gap, so it is O(n · k) with k
 * the number of horizontally nearby components.
 *
 * @param {Component[]} ccs
 * @param {number} gap
 * @returns {Component[]}
 */
function clusterComponents(ccs, gap) {
  const n = ccs.length;
  if (n < 2) return [];
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => ccs[a].x0 - ccs[b].x0);

  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };

  for (let oi = 0; oi < n; oi++) {
    const a = ccs[order[oi]];
    const reach = a.x1 + gap;
    for (let oj = oi + 1; oj < n; oj++) {
      const b = ccs[order[oj]];
      if (b.x0 > reach) break;
      if (b.y0 > a.y1 + gap || b.y1 < a.y0 - gap) continue; // no vertical proximity
      const ra = find(order[oi]);
      const rb = find(order[oj]);
      if (ra !== rb) parent[rb] = ra;
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) {
      g = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, ink: 0, members: 0 };
      groups.set(r, g);
    }
    const c = ccs[i];
    if (c.x0 < g.x0) g.x0 = c.x0;
    if (c.y0 < g.y0) g.y0 = c.y0;
    if (c.x1 > g.x1) g.x1 = c.x1;
    if (c.y1 > g.y1) g.y1 = c.y1;
    g.ink += c.ink;
    g.members++;
  }

  const clusters = [];
  for (const g of groups.values()) {
    if (g.members < 2) continue;
    clusters.push(finalizeBox({ ...g, w: 0, h: 0, cx: 0, cy: 0 }));
  }
  return clusters;
}

/**
 * Pack a 0/1 Uint8Array into bits (8 pixels per byte) for the page cache.
 * A 1836×2376 page shrinks from 4.4 MB to 0.55 MB.
 */
function packBits(binary) {
  const n = binary.length;
  const out = new Uint8Array((n + 7) >> 3);
  for (let i = 0; i < n; i++) {
    if (binary[i]) out[i >> 3] |= 1 << (i & 7);
  }
  return out;
}

/** Inverse of packBits. `n` is the number of pixels. */
function unpackBits(packed, n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = (packed[i >> 3] >> (i & 7)) & 1;
  }
  return out;
}
