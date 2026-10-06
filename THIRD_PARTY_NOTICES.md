# Third-party notices

MathSearch's own code is under the MIT License (`LICENSE`). The packaged
extension also contains the following third-party software, each under its
own license. The exact versions and download hashes are pinned in
`scripts/vendor.json`; `npm run build` copies each license text next to the
code it covers.

## PDF.js 4.10.38 — Apache License 2.0

- Copyright Mozilla Foundation and contributors. <https://github.com/mozilla/pdf.js>
- Files: `lib/pdfjs/` (the generic viewer `web/` and `build/` from the
  official release `pdfjs-4.10.38-dist.zip`).
- License text: `lib/pdfjs/LICENSE`.
- **Modified files** (Apache-2.0 §4(b)): `lib/pdfjs/web/viewer.html` (the
  MathSearch script tags from `viewer-snippet.html` are added before
  `</body>`) and `lib/pdfjs/web/viewer.mjs` (the default document is the
  MathSearch guide, and both `enableScripting` defaults are `false`). Each
  file starts with a comment saying so. No other PDF.js file is changed;
  the demo document `compressed.tracemonkey-pldi-09.pdf` and the source maps
  are left out of the package.
- PDF.js includes no `NOTICE` file.

## KaTeX 0.17.0 — MIT License

- Copyright (c) 2013-2020 Khan Academy and other contributors. <https://katex.org>
- Files: `lib/katex/katex.min.js`, `lib/katex/katex.min.css`.
- License text: `lib/katex/LICENSE`.

### KaTeX fonts — MIT License

- Copyright (c) 2018 Khan Academy. <https://github.com/KaTeX/katex-fonts>
- Files: `lib/katex/fonts/`, as published in the KaTeX 0.17.0 package.
- License: MIT, the same terms as `lib/katex/LICENSE`.

## html2canvas 1.4.1 — MIT License

- Copyright (c) 2012 Niklas von Hertzen. <https://html2canvas.hertzen.com>
- Files: `lib/html2canvas/html2canvas.min.js`.
- License text: `lib/html2canvas/LICENSE`.

## Fonts embedded in the guide PDF

`lib/pdfjs/web/mathsearch-guide.pdf` is MathSearch's own text (MIT, like the
code), typeset with pdfLaTeX. Like any PDF, it embeds subsets of the fonts
it uses. Their licenses allow embedding them in documents:

| Fonts | Source | License |
|---|---|---|
| Computer Modern (CMR, CMBX, CMTT, CMTI, CMMI, CMSY) | Knuth; Type 1 versions in the AMS fonts | Knuth's license; Type 1: SIL Open Font License 1.1 |
| AMS symbols and Fraktur (MSAM, MSBM, EUFM) | American Mathematical Society, `amsfonts` | SIL Open Font License 1.1 |
| RSFS (script letters) | Ralph Smith's Formal Script, `rsfs` | free license (CTAN: "other-free") |
| TC text companion (`tcrm`, one bitmap symbol) | `ec` fonts | free license (CTAN: "other-free") |
