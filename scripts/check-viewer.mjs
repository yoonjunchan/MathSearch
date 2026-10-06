// Check that a patched PDF.js viewer has all three MathSearch edits, and
// print what to record after an update.
//
//   npm run check-viewer               (checks lib/pdfjs)
//   node scripts/check-viewer.mjs DIR  (checks DIR/web and DIR/build)
//
// Exit 1 if an edit is missing. The enableScripting edit is a security
// setting: if it is lost in a rebuild, PDF scripting
// silently comes back on. scripts/build.mjs runs the same checks on what it
// builds. See DESIGN.md "Updating PDF.js".
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

/**
 * @param {string} dir  a folder with web/ and build/ (lib/pdfjs)
 * @returns {{checks: Array<{name:string, ok:boolean, hint:string}>,
 *            version:string, build:string, sums:Array<[string,string]>}}
 */
export function checkViewer(dir) {
  const file = (...p) => path.join(dir, ...p);
  for (const f of [file("web", "viewer.html"), file("web", "viewer.mjs"), file("build", "pdf.mjs")]) {
    if (!fs.existsSync(f)) throw new Error(`missing ${f}: run npm run setup (or npm run build) first`);
  }
  const html = fs.readFileSync(file("web", "viewer.html"), "utf8");
  const mjs = fs.readFileSync(file("web", "viewer.mjs"), "utf8");

  const checks = [];
  const check = (name, ok, hint) => checks.push({ name, ok, hint });

  // 1. viewer-snippet.html pasted before </body>: the four tags it adds.
  const body = html.slice(0, html.lastIndexOf("</body>"));
  for (const src of ["../../katex/katex.min.css", "../../katex/katex.min.js",
    "../../html2canvas/html2canvas.min.js", "../../../src/controller.js"]) {
    check(`viewer.html loads ${src}`, body.includes(`"${src}"`),
      "paste viewer-snippet.html just before </body> in web/viewer.html");
  }
  check("viewer.html loads controller.js as a module",
    /<script type="module" src="\.\.\/\.\.\/\.\.\/src\/controller\.js">/.test(body),
    "the controller.js tag must have type=\"module\"");

  // 2. defaultUrl → the guide.
  check("viewer.mjs defaultUrl is mathsearch-guide.pdf",
    /defaultUrl\s*=\s*\{\s*value:\s*"mathsearch-guide\.pdf"/.test(mjs),
    "set the defaultUrl option's value to \"mathsearch-guide.pdf\"");
  check("web/mathsearch-guide.pdf present", fs.existsSync(file("web", "mathsearch-guide.pdf")),
    "run npm run guide (or copy guide/mathsearch-guide.pdf to web/)");

  // 3. enableScripting off in both defaults: the AppOptions entry and the
  // default-preferences object. Any `true` default left over is a failure.
  const optionEntry = mjs.match(/enableScripting:\s*\{\s*value:\s*(true|false)/g) ?? [];
  const prefEntry = mjs.match(/^\s*enableScripting:\s*(true|false),?\s*$/gm) ?? [];
  check("viewer.mjs AppOptions enableScripting is false",
    optionEntry.length > 0 && optionEntry.every((m) => m.endsWith("false")),
    `found ${optionEntry.length ? optionEntry.join(" | ") : "no entry"}; set its value to false`);
  check("viewer.mjs default preferences enableScripting is false",
    prefEntry.length > 0 && prefEntry.every((m) => /false/.test(m)),
    `found ${prefEntry.length ? prefEntry.map((m) => m.trim()).join(" | ") : "no entry"}; set it to false`);

  const pdf = fs.readFileSync(file("build", "pdf.mjs"), "utf8");
  const version = pdf.match(/pdfjsVersion = "([^"]+)"/)?.[1] ?? "?";
  const build = pdf.match(/pdfjsBuild = "([^"]+)"/)?.[1] ?? "?";
  const sums = [];
  for (const rel of [["build", "pdf.mjs"], ["build", "pdf.worker.mjs"]]) {
    const f = file(...rel);
    if (fs.existsSync(f)) sums.push([crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"), rel.join("/")]);
  }
  return { checks, version, build, sums };
}

/** Print the result; returns the number of failed checks. */
export function reportViewer(result, label = "lib/pdfjs") {
  let failed = 0;
  for (const c of result.checks) {
    console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok ? "" : `\n     → ${c.hint}`}`);
    if (!c.ok) failed++;
  }
  console.log(`\nPDF.js ${result.version} (build ${result.build})`);
  for (const [sum, rel] of result.sums) console.log(`${sum}  ${label}/${rel}`);
  return failed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dir = path.resolve(process.argv[2] ?? path.join(ROOT, "lib", "pdfjs"));
  let failed;
  try {
    failed = reportViewer(checkViewer(dir));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall patches present; in the browser, check the console line " +
    "\"[mathsearch] PDF.js … (viewer: false)\"");
}
