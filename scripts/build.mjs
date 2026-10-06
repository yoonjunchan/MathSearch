// Assemble the extension from our files and pinned third-party releases.
//
//   npm run setup   → lib/pdfjs, lib/katex, lib/html2canvas in this folder,
//                     so the folder itself can be loaded unpacked (development)
//   npm run build   → dist/mathsearch/ (load unpacked, or upload) and
//                     dist/mathsearch-<version>.zip (store / GitHub release)
//
// Third-party code comes from scripts/vendor.json: each archive is downloaded
// once into vendor-cache/, and refused if its SHA-256 differs from the pinned
// one. Only the files the extension needs are copied, with their licenses.
// The PDF.js viewer then gets MathSearch's three edits (DESIGN.md, setup
// step 2); each must apply exactly once or the build stops, and
// scripts/check-viewer.mjs checks the result, because a lost enableScripting
// edit would silently turn PDF scripting back on (a security setting).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { unzipSync, gunzipSync, zipSync } from "fflate";
import { checkViewer, reportViewer } from "./check-viewer.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "vendor.json"), "utf8"));
const CACHE = path.join(ROOT, "vendor-cache");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

// The extension's own files, copied into dist/ as they are.
const OWN_FILES = ["manifest.json", "background.js", "LICENSE", "THIRD_PARTY_NOTICES.md"];
const OWN_DIRS = ["src", "icons"];

const mode = process.argv[2];
if (mode !== "setup" && mode !== "dist") {
  console.error("usage: node scripts/build.mjs setup|dist");
  process.exit(1);
}

try {
  if (mode === "setup") {
    await writeLib(path.join(ROOT, "lib"), { sourceMaps: true });
    finish(path.join(ROOT, "lib", "pdfjs"));
    console.log("lib/ ready: load this folder unpacked in chrome://extensions");
  } else {
    const out = path.join(ROOT, "dist", "mathsearch");
    fs.rmSync(path.join(ROOT, "dist"), { recursive: true, force: true });
    for (const f of OWN_FILES) copy(path.join(ROOT, f), path.join(out, f));
    for (const d of OWN_DIRS) copyDir(path.join(ROOT, d), path.join(out, d));
    await writeLib(path.join(out, "lib"), { sourceMaps: false });
    checkManifestFiles(out);
    finish(path.join(out, "lib", "pdfjs"));
    const zipFile = path.join(ROOT, "dist", `mathsearch-${MANIFEST.version}.zip`);
    fs.writeFileSync(zipFile, zipFolder(out));
    const mb = (fs.statSync(zipFile).size / 1e6).toFixed(1);
    console.log(`built dist/mathsearch/ and ${path.relative(ROOT, zipFile)} (${mb} MB)`);
  }
} catch (err) {
  console.error(`BUILD FAILED: ${err.message}`);
  process.exit(1);
}

/** Run the viewer checks on what was written; stop on any failure. */
function finish(pdfjsDir) {
  const failed = reportViewer(checkViewer(pdfjsDir), path.relative(ROOT, pdfjsDir).replaceAll("\\", "/"));
  if (failed) throw new Error(`${failed} viewer check(s) failed`);
}

/** lib/pdfjs (patched), lib/katex and lib/html2canvas, each with its license. */
async function writeLib(lib, { sourceMaps }) {
  // PDF.js: the generic viewer (web/, build/) from the release zip.
  const pdfjs = unzipSync(await fetchPinned("pdfjs"));
  const pdfjsDir = path.join(lib, "pdfjs");
  fs.rmSync(pdfjsDir, { recursive: true, force: true });
  for (const [name, data] of Object.entries(pdfjs)) {
    if (name.endsWith("/")) continue;
    if (!/^(web|build)\//.test(name) && name !== "LICENSE") continue;
    if (name === "web/compressed.tracemonkey-pldi-09.pdf") continue; // PDF.js's demo paper
    if (!sourceMaps && name.endsWith(".map")) continue;
    write(path.join(pdfjsDir, name), data);
  }
  patchViewer(pdfjsDir);
  copy(path.join(ROOT, "guide", "mathsearch-guide.pdf"), path.join(pdfjsDir, "web", "mathsearch-guide.pdf"));

  // KaTeX: the minified script, stylesheet and fonts.
  const katex = untar(gunzipSync(await fetchPinned("katex")));
  const katexDir = path.join(lib, "katex");
  fs.rmSync(katexDir, { recursive: true, force: true });
  for (const [name, data] of katex) {
    const rel = name.match(/^package\/dist\/(katex\.min\.js|katex\.min\.css|fonts\/[^/]+)$/)?.[1];
    if (rel) write(path.join(katexDir, rel), data);
    if (name === "package/LICENSE") write(path.join(katexDir, "LICENSE"), data);
  }

  // html2canvas: the minified script.
  const h2c = untar(gunzipSync(await fetchPinned("html2canvas")));
  const h2cDir = path.join(lib, "html2canvas");
  fs.rmSync(h2cDir, { recursive: true, force: true });
  for (const [name, data] of h2c) {
    if (name === "package/dist/html2canvas.min.js") write(path.join(h2cDir, "html2canvas.min.js"), data);
    if (name === "package/LICENSE") write(path.join(h2cDir, "LICENSE"), data);
  }
  for (const f of ["katex/katex.min.js", "katex/katex.min.css", "katex/LICENSE",
    "html2canvas/html2canvas.min.js", "html2canvas/LICENSE", "pdfjs/LICENSE"]) {
    if (!fs.existsSync(path.join(lib, f))) throw new Error(`lib/${f} missing from its archive`);
  }
}

/**
 * MathSearch's edits to the PDF.js viewer. Each replacement must match
 * exactly once; a new PDF.js release that changed these lines stops the
 * build instead of shipping an unpatched viewer. Apache-2.0 §4(b): changed
 * files carry a notice saying so.
 */
function patchViewer(pdfjsDir) {
  const notice = "Changed by MathSearch: see DESIGN.md \"Setup from source\", step 2.";
  const htmlFile = path.join(pdfjsDir, "web", "viewer.html");
  let html = fs.readFileSync(htmlFile, "utf8");
  const snippet = fs.readFileSync(path.join(ROOT, "viewer-snippet.html"), "utf8");
  html = replaceOnce(html, "</body>", `${snippet}\n</body>`, "viewer.html </body>");
  html = replaceOnce(html, "<!DOCTYPE html>", `<!DOCTYPE html>\n<!-- ${notice} The MathSearch script tags are pasted before </body>. -->`, "viewer.html doctype");
  fs.writeFileSync(htmlFile, html);

  const mjsFile = path.join(pdfjsDir, "web", "viewer.mjs");
  let mjs = fs.readFileSync(mjsFile, "utf8");
  mjs = replaceOnce(mjs, 'value: "compressed.tracemonkey-pldi-09.pdf"', 'value: "mathsearch-guide.pdf"', "defaultUrl");
  mjs = replaceOnce(mjs, "enableScripting: {\n    value: true,", "enableScripting: {\n    value: false,", "AppOptions enableScripting");
  mjs = replaceOnce(mjs, "\n    enableScripting: true,\n", "\n    enableScripting: false,\n", "default preferences enableScripting");
  mjs = `/* ${notice} defaultUrl is the MathSearch guide, and both enableScripting defaults are false. */\n${mjs}`;
  fs.writeFileSync(mjsFile, mjs);
}

function replaceOnce(text, find, replacement, label) {
  const n = text.split(find).length - 1;
  if (n !== 1) throw new Error(`viewer patch "${label}": expected 1 match, found ${n}`);
  return text.replace(find, () => replacement);
}

/** The pinned archive, from vendor-cache/ or downloaded; SHA-256 checked. */
async function fetchPinned(key) {
  const { url, sha256, version } = VENDOR[key];
  const file = path.join(CACHE, path.basename(new URL(url).pathname));
  let data;
  if (fs.existsSync(file)) {
    data = fs.readFileSync(file);
  } else {
    console.log(`downloading ${key} ${version}: ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    data = Buffer.from(await res.arrayBuffer());
  }
  const got = crypto.createHash("sha256").update(data).digest("hex");
  if (got !== sha256) {
    throw new Error(`${key} ${version}: SHA-256 ${got} does not match the pinned ${sha256} (scripts/vendor.json); ` +
      `delete ${path.relative(ROOT, file)} if it is a damaged download`);
  }
  if (!fs.existsSync(file)) write(file, data);
  return new Uint8Array(data);
}

/** Minimal tar reader (npm tarballs: regular files only). */
function untar(buf) {
  const files = [];
  for (let off = 0; off + 512 <= buf.length;) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const str = (a, b) => new TextDecoder().decode(header.subarray(a, b)).replace(/\0.*$/s, "");
    const name = (str(345, 500) ? `${str(345, 500)}/` : "") + str(0, 100);
    const size = parseInt(str(124, 136).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    if (type === "0" && !name.split("/").includes("..")) files.push([name, buf.subarray(off + 512, off + 512 + size)]);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Every file the manifest names must exist in the package. */
function checkManifestFiles(out) {
  const refs = [MANIFEST.background?.service_worker, ...Object.values(MANIFEST.icons || {}),
    ...Object.values(MANIFEST.action?.default_icon || {})].filter(Boolean);
  for (const ref of refs) {
    if (!fs.existsSync(path.join(out, ref))) throw new Error(`manifest.json names ${ref}, which is not in the package`);
  }
}

/** Zip a folder with its files at the root (as stores expect), fixed dates. */
function zipFolder(dir) {
  const entries = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else entries[path.relative(dir, p).replaceAll("\\", "/")] = [fs.readFileSync(p), { mtime: new Date("2026-01-01T00:00:00Z") }];
    }
  };
  walk(dir);
  return zipSync(entries, { level: 9 });
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

function copy(from, to) {
  if (!fs.existsSync(from)) throw new Error(`${path.relative(ROOT, from)} is missing`);
  write(to, fs.readFileSync(from));
}

function copyDir(from, to) {
  if (!fs.existsSync(from)) throw new Error(`${path.relative(ROOT, from)}/ is missing`);
  fs.cpSync(from, to, { recursive: true });
}
