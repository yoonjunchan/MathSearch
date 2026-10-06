# Changelog

## 1.0.0 — unreleased

First public release.

- Search a PDF for a math symbol by how it looks: type LaTeX (live KaTeX
  preview) or snip a symbol from the page (✂, Alt+S).
- Search order from the current page backward, then forward; *Look up in
  index* finds the symbol in the book's index or list of notation and jumps
  to the page it names.
- Works on rotated and landscape pages, with the viewer rotated, and finds
  content printed sideways when the PDF has a text layer.
- Page index with a memory cap (default 250 MB) and release of memory when
  the tab is hidden.
- No permissions, no network access; bundles PDF.js 4.10.38, KaTeX 0.17.0
  and html2canvas 1.4.1.
