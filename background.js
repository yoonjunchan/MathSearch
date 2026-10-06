/**
 * background.js — Minimal MV3 service worker.
 *
 * Its only job: open the bundled PDF.js viewer page when the toolbar icon
 * is clicked. (chrome.tabs.create does not require the "tabs" permission;
 * that permission is only needed to *read* other tabs, which we never do.)
 *
 * Note: the architecture document listed "scripting" as required to inject
 * the panel. Since we ship our own viewer.html and load panel code from a
 * <script> tag inside it, no injection — and therefore no permission at
 * all — turned out to be necessary. The permission list is empty.
 */

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({
    url: chrome.runtime.getURL("lib/pdfjs/web/viewer.html"),
  });
});
