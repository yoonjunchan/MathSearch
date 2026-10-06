/**
 * panel.js — The floating search UI.
 *
 * Knows nothing about matching or the page index. Beyond the widgets, its
 * one structural job is getRenderedCanvas(): it rasterises the live KaTeX
 * preview with html2canvas so that what the user sees is exactly what
 * becomes the template.
 *
 * A snip (a rectangle cut from the PDF, see snip.js) replaces the LaTeX
 * query: showSnip() draws the snip's binarised template in the preview box,
 * with a caution line under it, until the user types in the box again.
 *
 * The panel is a floating window: dragged by its header (clamped so the
 * header stays on screen; double-click resets it to the top right), hidden
 * with ×, and brought back by the Σ button it adds to the PDF.js toolbar or
 * by Alt+M. Position and visibility live for the session only.
 *
 * Settings (the page index's memory cap, when to release it while the tab
 * is hidden) are the only state kept across sessions: one JSON value in the
 * extension page's localStorage (no permission needed), read and written in
 * try/catch so the panel works with the Config defaults when storage is
 * unavailable.
 *
 * External libraries (classic scripts loaded by viewer.html):
 *   window.katex        — bundled KaTeX
 *   window.html2canvas  — bundled html2canvas
 */

import { Config } from "./config.js";

const el = {};          // element handles, filled by createPanel
let callbacks = {
  onSearch: () => {},
  onLookup: () => {},
  onCancel: () => {},
  onPrev: () => {},
  onNext: () => {},
  onSelect: () => {},
  onJumpPage: () => {},
  onSnip: () => {},
  onSettings: () => {},
};
const SETTINGS_KEY = "mathsearch.settings";
const RELEASE_CHOICES = [10, 30, 60, 120, 0]; // minutes; 0 = never
let settings = null;    // {indexMaxMB, releaseAfterMin}, see readSettings
let lastMatches = [];
let snipCount = 0;      // numbers the snips, for the "searched for" key
let snipKey = null;     // "snip:n" while a snip is the query, else null

/**
 * The first result row at or below the list's scroll position, as the match
 * it shows and its offset from the top, so a rebuilt list can be scrolled
 * back to the same place. null when the list is empty or hidden.
 */
function topVisibleRow() {
  if (!el.results || el.results.hidden) return null;
  const top = el.results.scrollTop;
  for (const li of el.results.querySelectorAll("li[data-index]")) {
    if (li.offsetTop + li.offsetHeight > top) {
      const match = lastMatches[Number(li.dataset.index)];
      return match ? { match, offset: li.offsetTop - top, scrollTop: top } : null;
    }
  }
  return null;
}

/**
 * html2canvas clones the whole document before drawing one element. Skip
 * everything that neither contains the preview nor lies inside it (the
 * rendered PDF pages, text layers, sidebar thumbnails), but keep <head> and
 * stylesheets anywhere, since the KaTeX CSS and fonts come from them.
 * Review finding C7.
 */
function skipInCapture(node, target) {
  if (node.contains(target) || target.contains(node)) return false;
  if (node.tagName === "STYLE" || node.tagName === "LINK") return false;
  return !node.closest?.("head");
}

export const Panel = {
  /**
   * Build the panel and inject it into the viewer DOM.
   * @param {Partial<typeof callbacks>} cbs
   */
  createPanel(cbs) {
    callbacks = { ...callbacks, ...cbs };
    injectStyles();

    const root = document.createElement("div");
    root.id = "ms-panel";
    root.innerHTML = `
      <div class="ms-head">
        <span class="ms-title">MathSearch</span>
        <span class="ms-head-buttons">
          <button id="ms-collapse" type="button" title="Collapse / expand (Alt+M focuses the search box)">▾</button>
          <button id="ms-close" type="button" title="Hide (Alt+M or the Σ toolbar button reopens)">×</button>
        </span>
      </div>
      <div class="ms-body">
        <div class="ms-input-row">
          <input id="ms-input" type="text" spellcheck="false" autocomplete="off"
                 placeholder="\\mathscr{F}_{\\tau_{j+1}}" />
          <button id="ms-snip" type="button"
                  title="Snip: drag a rectangle over a symbol in the PDF to search for it (Alt+S)">✂</button>
        </div>
        <div id="ms-preview" aria-label="Rendered preview"></div>
        <div id="ms-snip-note" hidden>Snip only the symbol: nearby ink (a subscript, a fraction bar, a neighbouring letter) is searched for too and lowers the score of clean matches.</div>
        <div class="ms-row">
          <label class="ms-field">Scope
            <select id="ms-scope">
              <option value="document">whole document</option>
              <option value="page">this page</option>
            </select>
          </label>
          <label class="ms-field">Min score
            <input id="ms-threshold" type="number" max="1" step="0.01" />
          </label>
        </div>
        <label class="ms-field ms-check"
               title="Ink attached to a match that the query lacks (a subscript, a superscript, an accent or dot) lowers its score, so searching R ranks R^d below R. Untick to find the symbol with or without such marks. Changing it searches again.">
          <input id="ms-attached" type="checkbox" checked />
          Penalise scripts and accents next to the match
        </label>
        <div class="ms-row">
          <button id="ms-search" type="button">Search</button>
          <span class="ms-nav">
            <button id="ms-prev" type="button" title="Previous match (Shift+Enter)">‹</button>
            <span id="ms-pos"></span>
            <button id="ms-next" type="button" title="Next match (Enter)">›</button>
          </span>
        </div>
        <div class="ms-row">
          <button id="ms-lookup" type="button"
                  title="Look the symbol up in the book's index or list of notation first, then jump to the page it names and search from there (Ctrl+Enter)">Look up in index</button>
        </div>
        <div id="ms-refs" hidden></div>
        <div id="ms-progress"></div>
        <ol id="ms-results" hidden></ol>
        <div id="ms-error" hidden></div>
        <details id="ms-settings">
          <summary>Settings</summary>
          <label class="ms-field">Memory for the page index
            <input id="ms-index-mb" type="number" step="50" /> MB
          </label>
          <div id="ms-mem-use"></div>
          <label class="ms-field">Release it when the tab is hidden for
            <select id="ms-release">
              <option value="10">10 min</option>
              <option value="30">30 min</option>
              <option value="60">1 hour</option>
              <option value="120">2 hours</option>
              <option value="0">never</option>
            </select>
          </label>
          <div class="ms-settings-note">Saved in this browser. Past the memory limit, the book's index and the pages nearest your last search are kept; other pages are rendered again when searched.</div>
        </details>
      </div>
    `;
    document.body.appendChild(root);

    el.root = root;
    el.head = root.querySelector(".ms-head");
    el.close = root.querySelector("#ms-close");
    el.body = root.querySelector(".ms-body");
    el.collapse = root.querySelector("#ms-collapse");
    el.input = root.querySelector("#ms-input");
    el.preview = root.querySelector("#ms-preview");
    el.snip = root.querySelector("#ms-snip");
    el.snipNote = root.querySelector("#ms-snip-note");
    el.scope = root.querySelector("#ms-scope");
    el.threshold = root.querySelector("#ms-threshold");
    el.attached = root.querySelector("#ms-attached");
    el.search = root.querySelector("#ms-search");
    el.lookup = root.querySelector("#ms-lookup");
    el.refs = root.querySelector("#ms-refs");
    el.prev = root.querySelector("#ms-prev");
    el.next = root.querySelector("#ms-next");
    el.pos = root.querySelector("#ms-pos");
    el.progress = root.querySelector("#ms-progress");
    el.results = root.querySelector("#ms-results");
    el.error = root.querySelector("#ms-error");
    el.indexMB = root.querySelector("#ms-index-mb");
    el.memUse = root.querySelector("#ms-mem-use");
    el.release = root.querySelector("#ms-release");

    settings = Panel.readSettings();
    el.indexMB.min = String(Config.INDEX_MIN_MB);
    el.indexMB.value = String(settings.indexMaxMB);
    el.release.value = String(settings.releaseAfterMin);
    const settingsChanged = () => {
      const mb = Number(el.indexMB.value);
      if (Number.isFinite(mb) && mb >= Config.INDEX_MIN_MB) settings.indexMaxMB = mb;
      else el.indexMB.value = String(settings.indexMaxMB);
      settings.releaseAfterMin = Number(el.release.value);
      saveSettings(settings);
      callbacks.onSettings({ ...settings });
    };
    el.indexMB.addEventListener("change", settingsChanged);
    el.release.addEventListener("change", settingsChanged);

    el.threshold.min = String(Config.SEARCH_FLOOR);
    el.threshold.value = Config.SIMILARITY_THRESHOLD.toFixed(2);
    el.attached.checked = Config.ATTACHED_INK;
    Panel.showResults([], -1);

    el.input.addEventListener("input", () => {
      Panel.clearSnip();
      renderPreview(el.input.value);
      Panel.hideError();
    });

    // Enter searches; once there are results, Enter / Shift+Enter step
    // through them (like a browser find bar), also while the scan is still
    // running. Ctrl+Enter looks the symbol up in the index. Escape blurs.
    el.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.ctrlKey) {
        e.preventDefault();
        callbacks.onLookup();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (lastMatches.length && el.input.dataset.searchedFor === queryKey()) {
          e.shiftKey ? callbacks.onPrev() : callbacks.onNext();
        } else {
          callbacks.onSearch();
        }
      } else if (e.key === "Escape") {
        el.input.blur();
      }
    });

    el.search.addEventListener("click", () => {
      if (el.search.dataset.busy) callbacks.onCancel();
      else callbacks.onSearch();
    });
    el.snip.addEventListener("click", () => callbacks.onSnip());
    el.lookup.addEventListener("click", () => {
      if (el.lookup.dataset.busy) callbacks.onCancel();
      else callbacks.onLookup();
    });
    el.refs.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-page]");
      if (b) callbacks.onJumpPage(Number(b.dataset.page));
    });
    el.prev.addEventListener("click", () => callbacks.onPrev());
    el.next.addEventListener("click", () => callbacks.onNext());
    el.collapse.addEventListener("click", () => Panel.toggleCollapsed());
    el.close.addEventListener("click", () => Panel.setVisible(false));
    el.results.addEventListener("click", (e) => {
      const li = e.target.closest("li[data-index]");
      if (li) callbacks.onSelect(Number(li.dataset.index));
    });

    enableDrag();
    installToolbarButton();
  },

  /**
   * The saved settings, or the Config defaults for any that are missing,
   * invalid or unreadable (no storage, private window, blocked site data).
   * @returns {{indexMaxMB: number, releaseAfterMin: number}}
   */
  readSettings() {
    const s = { indexMaxMB: Config.INDEX_MAX_MB, releaseAfterMin: Config.RELEASE_HIDDEN_AFTER_MIN };
    try {
      const saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || "{}");
      if (Number.isFinite(saved.indexMaxMB) && saved.indexMaxMB >= Config.INDEX_MIN_MB) s.indexMaxMB = saved.indexMaxMB;
      if (RELEASE_CHOICES.includes(saved.releaseAfterMin)) s.releaseAfterMin = saved.releaseAfterMin;
    } catch {
      // Storage unavailable or corrupt: the defaults.
    }
    return s;
  },

  /** The current settings (a copy). */
  getSettings() {
    return { ...settings };
  },

  /** "In use: 12.3 MB of 250 MB" under the memory setting. */
  setMemoryUse({ bytes, maxBytes }) {
    if (el.memUse) el.memUse.textContent = `In use: ${(bytes / 1e6).toFixed(1)} MB of ${Math.round(maxBytes / 1e6)} MB`;
  },

  /** The LaTeX source currently in the box. */
  getQuery() {
    return el.input.value;
  },

  /** True while a snip, not the LaTeX box, is the query. */
  hasSnip() {
    return snipKey !== null;
  },

  /**
   * Make a snip the query: draw its template (black ink on white) in the
   * preview box and show the caution line. The LaTeX stays in the box and
   * comes back as the query as soon as the user types.
   * @param {{binary: Uint8Array, w: number, h: number}} template
   */
  showSnip(template) {
    snipKey = `snip:${++snipCount}`;
    const canvas = document.createElement("canvas");
    canvas.className = "ms-snip-image";
    canvas.width = template.w;
    canvas.height = template.h;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(template.w, template.h);
    for (let i = 0, p = 0; i < template.binary.length; i++, p += 4) {
      const v = template.binary[i] ? 0 : 255;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
      img.data[p + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    el.preview.innerHTML = "";
    el.preview.appendChild(canvas);
    el.snipNote.hidden = false;
  },

  /** Drop the snip and show the LaTeX preview again (no-op without one). */
  clearSnip() {
    if (snipKey === null) return;
    snipKey = null;
    el.snipNote.hidden = true;
    renderPreview(el.input.value);
  },

  /** Record that a search ran for the current query (Enter then steps). */
  markSearched() {
    el.input.dataset.searchedFor = queryKey();
  },

  /** The snip button reads "Cancel snip" while a snip is being drawn. */
  setSnipping(snipping) {
    el.snip.classList.toggle("ms-active", snipping);
    el.snip.title = snipping
      ? "Cancel the snip (Escape)"
      : "Snip: drag a rectangle over a symbol in the PDF to search for it (Alt+S)";
  },

  /** "document" | "page" */
  getScope() {
    return el.scope.value;
  },

  /** Threshold from the panel, falling back to the configured default. */
  getThreshold() {
    const v = parseFloat(el.threshold.value);
    if (Number.isFinite(v) && v >= 0 && v <= 1) return v;
    el.threshold.value = Config.SIMILARITY_THRESHOLD.toFixed(2);
    return Config.SIMILARITY_THRESHOLD;
  },

  /** Whether attached scripts and accents count against a match. */
  getAttachedInk() {
    return el.attached.checked;
  },

  /**
   * Rasterise the live KaTeX preview onto an offscreen canvas.
   * @returns {Promise<HTMLCanvasElement|null>} null if the preview is empty
   *          or the LaTeX did not parse.
   */
  async getRenderedCanvas() {
    if (snipKey !== null) return null;
    if (!el.preview || el.preview.childElementCount === 0) return null;
    if (el.preview.querySelector(".ms-preview-invalid")) return null;
    if (typeof window.html2canvas !== "function") {
      throw new Error("html2canvas is not loaded — check the script tags in viewer.html.");
    }
    // The KaTeX web fonts must be loaded before rasterising, or html2canvas
    // captures a fallback font and the template is garbage.
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    Panel.markSearched();
    // Capture the KaTeX root itself, not the preview box (padding/border).
    const target = el.preview.querySelector(".katex") || el.preview;
    return window.html2canvas(target, {
      backgroundColor: "#ffffff",
      scale: Config.TEMPLATE_RENDER_SCALE,
      logging: false,
      ignoreElements: (node) => skipInCapture(node, target),
    });
  },

  /**
   * Toggle the search-running state: the button that started the search
   * ("search" | "lookup") becomes Cancel, the other one is disabled.
   */
  setBusy(busy, which = "search") {
    const buttons = { search: [el.search, "Search"], lookup: [el.lookup, "Look up in index"] };
    for (const [key, [button, label]] of Object.entries(buttons)) {
      delete button.dataset.busy;
      button.textContent = label;
      button.disabled = busy && key !== which;
      if (busy && key === which) {
        button.dataset.busy = "1";
        button.textContent = "Cancel";
      }
    }
  },

  /**
   * Show where the book's index points: "Index → p. 23 · p. 45 ≈", each a
   * button that jumps to the PDF page (≈: printed → PDF page mapping is a
   * guess). With no refs, show `note` instead, or hide the line.
   * @param {Array<{label:string, pageNumber:number, exact:boolean}>} refs
   * @param {string} [note]
   */
  showIndexRefs(refs, note = "") {
    el.refs.innerHTML = "";
    el.refs.hidden = !refs.length && !note;
    if (!refs.length) {
      el.refs.textContent = note;
      return;
    }
    el.refs.append("Index → ");
    refs.forEach((r, i) => {
      if (i) el.refs.append(" · ");
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.page = String(r.pageNumber);
      b.textContent = `p.\u202f${r.label}${r.exact ? "" : " ≈"}`;
      b.title = r.exact
        ? `PDF page ${r.pageNumber}`
        : `PDF page ${r.pageNumber} (estimated: the printed page number could not be confirmed)`;
      el.refs.appendChild(b);
    });
  },

  /** One-line status under the buttons ("Indexing 3/24 …"). */
  setProgress(text) {
    el.progress.textContent = text || "";
  },

  /**
   * Populate the result list and navigation.
   * @param {Array<{pageNumber:number, score:number}>} matches  document order
   * @param {number} current
   * @param {{keepScroll?: boolean}} [opts]  keepScroll: a running search
   *   added matches; keep the row at the top of the list where it is
   *   instead of scrolling to the current match (review finding C8).
   */
  showResults(matches, current, { keepScroll = false } = {}) {
    const anchor = keepScroll ? topVisibleRow() : null;
    lastMatches = matches;
    el.results.innerHTML = "";
    const n = matches.length;
    el.prev.disabled = el.next.disabled = n === 0;
    if (n === 0) {
      el.results.hidden = true;
      el.pos.textContent = "";
      return;
    }
    el.results.hidden = false;
    const shown = matches.slice(0, Config.RESULT_LIST_MAX);
    shown.forEach((m, i) => {
      const li = document.createElement("li");
      li.dataset.index = String(i);
      li.innerHTML = `<span class="ms-page">p.\u202f${m.pageNumber}</span>` +
                     `<span class="ms-score">${m.score.toFixed(2)}</span>`;
      el.results.appendChild(li);
    });
    if (n > shown.length) {
      const li = document.createElement("li");
      li.className = "ms-more";
      li.textContent = `… ${n - shown.length} more`;
      el.results.appendChild(li);
    }
    Panel.setCurrent(current, { scroll: !anchor });
    if (anchor) {
      const i = matches.indexOf(anchor.match);
      const li = i >= 0 ? el.results.querySelector(`li[data-index="${i}"]`) : null;
      el.results.scrollTop = li ? li.offsetTop - anchor.offset : anchor.scrollTop;
    }
  },

  /** Highlight entry #index in the list and update "i / n". */
  setCurrent(index, { scroll = true } = {}) {
    const n = lastMatches.length;
    el.pos.textContent = n ? `${index >= 0 ? index + 1 : "–"} / ${n}` : "";
    for (const li of el.results.querySelectorAll("li[data-index]")) {
      const active = Number(li.dataset.index) === index;
      li.classList.toggle("ms-current", active);
      if (active && scroll) li.scrollIntoView({ block: "nearest" });
    }
  },

  showError(message) {
    el.error.textContent = message;
    el.error.hidden = false;
  },

  hideError() {
    if (el.error) el.error.hidden = true;
  },

  focusInput() {
    Panel.setVisible(true);
    if (el.root.classList.contains("ms-collapsed")) Panel.toggleCollapsed();
    el.input.focus();
    el.input.select();
  },

  toggleCollapsed() {
    const collapsed = el.root.classList.toggle("ms-collapsed");
    el.collapse.textContent = collapsed ? "▸" : "▾";
  },

  /** Show or hide the whole panel; position, query and results are kept. */
  setVisible(visible) {
    el.root.hidden = !visible;
    if (!visible && el.root.contains(document.activeElement)) document.activeElement.blur();
    if (el.toolbarButton) {
      el.toolbarButton.classList.toggle("toggled", visible);
      el.toolbarButton.setAttribute("aria-pressed", String(visible));
    }
    if (visible) clampToViewport();
  },

  toggleVisible() {
    Panel.setVisible(!Panel.isVisible());
  },

  isVisible() {
    return !el.root.hidden;
  },
};

function saveSettings(s) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Not saved (no storage): the setting still applies to this session.
  }
}

/** Identifies the current query: the snip, or the LaTeX in the box. */
function queryKey() {
  return snipKey ?? el.input.value;
}

// ── Floating window ──────────────────────────────────────────────────────────

/**
 * Drag the panel by its header. Until the first drag it stays anchored with
 * the stylesheet's top/right; after that it is positioned by left/top.
 */
function enableDrag() {
  let drag = null; // {pointerId, dx, dy} while dragging

  el.head.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button")) return;
    const r = el.root.getBoundingClientRect();
    drag = { pointerId: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
    el.head.setPointerCapture?.(e.pointerId);
    el.root.classList.add("ms-dragging");
    e.preventDefault(); // no text selection while dragging
  });
  el.head.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    moveTo(e.clientX - drag.dx, e.clientY - drag.dy);
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    el.head.releasePointerCapture?.(e.pointerId);
    el.root.classList.remove("ms-dragging");
    drag = null;
  };
  el.head.addEventListener("pointerup", end);
  el.head.addEventListener("pointercancel", end);

  // Escape hatch: back to the default top-right position.
  el.head.addEventListener("dblclick", (e) => {
    if (e.target.closest("button")) return;
    el.root.style.left = el.root.style.top = el.root.style.right = "";
  });

  // A shrinking window must not strand the panel off screen.
  window.addEventListener("resize", clampToViewport);
}

/**
 * Place the panel's top-left corner at (x, y), clamped so the whole header
 * stays inside the viewport and the panel can always be grabbed again.
 */
function moveTo(x, y) {
  const r = el.root.getBoundingClientRect();
  const headH = el.head.getBoundingClientRect().height;
  const maxX = Math.max(0, window.innerWidth - r.width);
  const maxY = Math.max(0, window.innerHeight - headH);
  el.root.style.right = "auto";
  el.root.style.left = `${Math.round(Math.min(Math.max(x, 0), maxX))}px`;
  el.root.style.top = `${Math.round(Math.min(Math.max(y, 0), maxY))}px`;
}

/** Re-apply the clamp to a panel that has been moved (no-op otherwise). */
function clampToViewport() {
  if (!el.root.style.left || el.root.hidden) return;
  const r = el.root.getBoundingClientRect();
  moveTo(r.left, r.top);
}

/**
 * Add a Σ toggle to the PDF.js toolbar, just left of the Tools menu. Skipped
 * silently if the viewer has no such toolbar (Alt+M still works).
 */
function installToolbarButton() {
  const bar = document.getElementById("toolbarViewerRight");
  if (!bar || document.getElementById("ms-toolbar-toggle")) return;
  const button = document.createElement("button");
  button.id = "ms-toolbar-toggle";
  button.className = "toolbarButton toggled";
  button.type = "button";
  button.title = "MathSearch (Alt+M)";
  button.setAttribute("aria-pressed", "true");
  button.innerHTML = "<span>MathSearch</span>";
  button.addEventListener("click", () => Panel.toggleVisible());
  const separator = document.createElement("div");
  separator.className = "verticalToolbarSeparator";
  const tools = document.getElementById("secondaryToolbarToggle");
  if (tools && tools.parentNode === bar) {
    bar.insertBefore(button, tools);
    bar.insertBefore(separator, tools);
  } else {
    bar.append(separator, button);
  }
  el.toolbarButton = button;
}

/** Render the LaTeX input into the live preview div. */
function renderPreview(latex) {
  if (typeof window.katex === "undefined") {
    el.preview.textContent = "KaTeX is not loaded.";
    return;
  }
  if (latex.trim() === "") {
    el.preview.innerHTML = "";
    return;
  }
  try {
    window.katex.render(latex, el.preview, {
      throwOnError: true,
      displayMode: false, // inline style: symbols as they appear in text
      maxSize: Config.KATEX_MAX_SIZE,     // sizes are capped to this (em)
      maxExpand: Config.KATEX_MAX_EXPAND, // over it: throws → "…"
    });
  } catch (err) {
    // Incomplete input while typing: show a placeholder, not an error.
    el.preview.innerHTML = `<span class="ms-preview-invalid">…</span>`;
  }
}

/** One-time injection of the panel stylesheet. */
function injectStyles() {
  if (document.getElementById("ms-style")) return;
  const style = document.createElement("style");
  style.id = "ms-style";
  style.textContent = `
    #ms-panel {
      position: fixed;
      top: 48px;
      right: 16px;
      z-index: 10000;
      width: 272px;
      background: #fffdf7;
      border: 1px solid #d8d2c4;
      border-radius: 6px;
      box-shadow: 0 4px 16px rgba(40, 35, 25, 0.18);
      font: 13px/1.4 system-ui, sans-serif;
      color: #2b2620;
    }
    #ms-panel[hidden] { display: none; }
    #ms-panel.ms-dragging { box-shadow: 0 8px 28px rgba(40, 35, 25, 0.28); }
    #ms-panel .ms-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px 6px;
      cursor: move;
      user-select: none;
      touch-action: none;
    }
    #ms-panel.ms-dragging .ms-head { cursor: grabbing; }
    #ms-panel .ms-head-buttons { display: flex; align-items: center; gap: 2px; }
    #ms-panel .ms-title {
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #8a8270;
    }
    #ms-panel #ms-collapse, #ms-panel #ms-close {
      border: none; background: none; cursor: pointer; font-size: 14px;
      color: #8a8270; padding: 0 4px; line-height: 1;
    }
    #ms-panel #ms-close { font-size: 17px; }
    #ms-panel #ms-collapse:hover, #ms-panel #ms-close:hover { background: #ece5d3; }
    #ms-toolbar-toggle::before {
      content: "Σ";
      width: auto; height: auto;
      background: none;
      -webkit-mask: none; mask: none;
      color: var(--toolbar-icon-bg-color, #000);
      font: 600 16px/1 "Times New Roman", serif;
    }
    #ms-toolbar-toggle.toggled::before { color: var(--toggled-btn-color, #000); }
    #ms-panel .ms-body { padding: 0 12px 12px; }
    #ms-panel.ms-collapsed .ms-body { display: none; }
    #ms-panel .ms-input-row { display: flex; gap: 6px; }
    #ms-input {
      flex: 1;
      min-width: 0;
      box-sizing: border-box;
      padding: 6px 8px;
      border: 1px solid #c9c2b2;
      border-radius: 4px;
      font: 13px/1.4 ui-monospace, "Cascadia Mono", Menlo, monospace;
      background: #fff;
    }
    #ms-input:focus { outline: 2px solid #b58900; outline-offset: 1px; }
    #ms-preview {
      min-height: 34px;
      margin: 8px 0;
      padding: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #ffffff;
      border: 1px dashed #d8d2c4;
      border-radius: 4px;
      font-size: 18px;
      overflow-x: auto;
    }
    .ms-preview-invalid { color: #b0a890; }
    #ms-preview .ms-snip-image { max-width: 100%; max-height: 48px; }
    #ms-panel #ms-snip { padding: 4px 8px; font-size: 14px; line-height: 1; }
    #ms-panel #ms-snip.ms-active { background: #ffe9b8; border-color: #d9b56a; }
    #ms-snip-note { margin: -4px 0 6px; font-size: 11px; line-height: 1.35; color: #8a6d1f; }
    #ms-panel .ms-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-top: 6px;
    }
    #ms-panel .ms-field {
      display: flex; align-items: center; gap: 4px;
      font-size: 12px; color: #5d5648;
    }
    #ms-scope, #ms-threshold {
      font: inherit; padding: 2px 4px;
      border: 1px solid #c9c2b2; border-radius: 4px; background: #fff;
    }
    #ms-threshold { width: 58px; }
    #ms-panel .ms-check { margin-top: 6px; cursor: pointer; }
    #ms-attached { margin: 0; }
    #ms-panel button {
      border: 1px solid #c9c2b2;
      border-radius: 4px;
      background: #f4efe3;
      padding: 6px 10px;
      font: inherit;
      cursor: pointer;
    }
    #ms-panel button:hover:not(:disabled) { background: #ece5d3; }
    #ms-panel button:disabled { opacity: 0.5; cursor: default; }
    #ms-search, #ms-lookup { flex: 1; }
    #ms-search[data-busy], #ms-lookup[data-busy] { background: #f7dede; border-color: #d9a3a3; }
    #ms-refs { margin-top: 6px; font-size: 12px; color: #5d5648; }
    #ms-panel #ms-refs button {
      border: none; background: none; padding: 0 2px;
      color: #7a5a00; text-decoration: underline; cursor: pointer;
    }
    #ms-panel #ms-refs button:hover { background: #f7f2e6; }
    #ms-panel .ms-nav { display: flex; align-items: center; gap: 4px; }
    #ms-prev, #ms-next { width: 30px; padding: 4px 0; font-size: 15px; line-height: 1; }
    #ms-pos { min-width: 44px; text-align: center; color: #5d5648; font-variant-numeric: tabular-nums; }
    #ms-progress { margin-top: 6px; min-height: 1.4em; color: #5d5648; font-size: 12px; }
    #ms-results {
      margin: 6px 0 0; padding: 0; list-style: none;
      max-height: 220px; overflow-y: auto;
      border: 1px solid #e6e0d2; border-radius: 4px; background: #fff;
      font-size: 12px; font-variant-numeric: tabular-nums;
    }
    #ms-results li {
      display: flex; justify-content: space-between;
      padding: 3px 8px; cursor: pointer;
      border-bottom: 1px solid #f0ebdf;
    }
    #ms-results li:last-child { border-bottom: none; }
    #ms-results li:hover { background: #f7f2e6; }
    #ms-results li.ms-current { background: #ffe9b8; }
    #ms-results li.ms-more { color: #8a8270; cursor: default; justify-content: center; }
    #ms-results .ms-score { color: #8a8270; }
    #ms-settings { margin-top: 8px; font-size: 12px; color: #5d5648; }
    #ms-settings summary { cursor: pointer; color: #8a8270; }
    #ms-settings .ms-field { margin-top: 6px; flex-wrap: wrap; }
    #ms-index-mb { width: 64px; font: inherit; padding: 2px 4px; border: 1px solid #c9c2b2; border-radius: 4px; }
    #ms-release { font: inherit; padding: 2px 4px; border: 1px solid #c9c2b2; border-radius: 4px; background: #fff; }
    #ms-mem-use { margin-top: 2px; color: #8a8270; font-variant-numeric: tabular-nums; }
    #ms-settings .ms-settings-note { margin-top: 6px; font-size: 11px; line-height: 1.35; color: #8a8270; }
    #ms-error {
      margin-top: 8px;
      padding: 6px 8px;
      border-radius: 4px;
      background: #fbeaea;
      border: 1px solid #e3b8b8;
      color: #7a2e2e;
      font-size: 12px;
    }
  `;
  document.head.appendChild(style);
}
