# MathSearch — find math symbols in a PDF by how they look

Reading a mathematics paper or textbook, you meet a symbol such as
𝓕<sub>τ<sub>j+1</sub></sub> and want to know where it was defined. Ctrl+F
rarely helps: in a PDF, math usually has no searchable text behind it, only
glyphs drawn on the page.

MathSearch is a Chrome/Edge extension that searches a PDF by **appearance**.
Type the symbol in LaTeX (`\mathscr{F}_{\tau_{j+1}}`), check the live
preview, press Enter, and every place in the document that looks like the
preview is highlighted, starting with the nearest earlier occurrence. If you
don't know the LaTeX, drag a rectangle around the symbol on the page and
search for that.
It can also look the symbol up in the book's index of notation.

It runs entirely in your browser: no server, no network access, nothing
leaves your computer, and the extension asks for no permissions. The only
thing it stores is its two memory settings.

Status: version 1.0, working and tested. For now it is installed in
Developer mode (see Install below). The author is working on publishing it
on the Microsoft Edge Add-ons store, so that Edge users can install it from
there without turning on Developer mode.

## Quick start

### Install

**Ready-made:** download `mathsearch-<version>.zip` from the
[Releases page](https://github.com/yoonjunchan/MathSearch/releases) and unzip
it into a folder of its own.

**Or build it yourself** (Node.js 18 or newer):

```bash
npm install
npm run build      # → dist/mathsearch/
```

The build downloads the pinned releases of PDF.js, KaTeX and html2canvas,
checks their SHA-256, and adds MathSearch's three edits to the PDF.js viewer
([DESIGN.md](DESIGN.md#setup-from-source) explains each step).

Then, in Chrome or Edge, open `chrome://extensions`, turn on **Developer
mode**, click **Load unpacked** and select the unzipped folder (or
`dist/mathsearch/`).

### Use

1. Click the MathSearch toolbar icon. A PDF viewer opens with the
   **MathSearch guide**.
2. Open your own PDF with the viewer's **Open file** button (Ctrl+O), or
   drag the file onto the viewer.
   For several PDFs at once, click the toolbar icon again: each click opens
   a new viewer tab.
3. Type LaTeX in the MathSearch panel and press **Enter**.
   **Enter** / **Shift+Enter** step through the matches.
4. Other ways to search:
   - **✂** (Alt+S): drag a rectangle around a symbol on the page to search
     for it.
   - **Look up in index** (Ctrl+Enter): find the symbol in the book's index
     and jump to the page it names.
5. Lower **Min score** to see weaker matches, such as small subscript
   versions of a symbol.

The guide PDF that opens by default is the full user manual: every panel
control, the keyboard shortcuts, how to read the scores, the limitations,
and practice text to try the search on.

## More

- [DESIGN.md](DESIGN.md): how it works, configuration and known limitations.
- [REBUILD-WITH-AI.md](REBUILD-WITH-AI.md): prompts for rebuilding
  MathSearch yourself with an AI coding assistant.
- [PRIVACY.md](PRIVACY.md): no data is collected; no network access.
- [CHANGELOG.md](CHANGELOG.md).

## License

MathSearch is under the [MIT License](LICENSE). The bundled third-party code
keeps its own license: PDF.js (Apache-2.0), KaTeX and its fonts (MIT) and
html2canvas (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
