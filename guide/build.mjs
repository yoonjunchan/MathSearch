// Build the guide and test sheet (guide/mathsearch-guide.tex) and install it
// as the viewer's default document.
//
//   npm run guide
//
// pdflatex runs three times (table of contents, \pageref, hyperref
// bookmarks each need the previous run's output). Auxiliary files go to
// guide/build/; the PDF is written to guide/mathsearch-guide.pdf and copied to
// lib/pdfjs/web/, where the viewer's `defaultUrl` option points to it.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NAME = "mathsearch-guide";
const BUILD = path.join(HERE, "build");
fs.mkdirSync(BUILD, { recursive: true });

for (let run = 1; run <= 3; run++) {
  try {
    execFileSync(
      "pdflatex",
      ["-interaction=batchmode", "-halt-on-error", `-output-directory=${BUILD}`, `${NAME}.tex`],
      { cwd: HERE, stdio: "ignore" }
    );
  } catch {
    console.error(`pdflatex failed on run ${run}; see guide/build/${NAME}.log`);
    process.exit(1);
  }
}

const pdf = path.join(HERE, `${NAME}.pdf`);
fs.copyFileSync(path.join(BUILD, `${NAME}.pdf`), pdf);
console.log(`built ${path.relative(process.cwd(), pdf)}`);

const viewerDir = path.join(HERE, "..", "lib", "pdfjs", "web");
if (fs.existsSync(viewerDir)) {
  fs.copyFileSync(pdf, path.join(viewerDir, `${NAME}.pdf`));
  console.log(`copied to ${path.relative(process.cwd(), viewerDir)}`);
} else {
  console.log("lib/pdfjs/web not found: copy the PDF there after building the viewer");
}
