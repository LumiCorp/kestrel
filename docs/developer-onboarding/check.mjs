import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(directory, "index.html"), "utf8");
const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

for (const markdownName of ["README.md"]) {
  const markdown = fs.readFileSync(path.join(directory, markdownName), "utf8");
  const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  for (const field of ["id", "domain", "status", "owner", "last_verified_at"]) {
    assert(new RegExp(`^${field}:\\s*\\S+`, "m").test(frontmatter), `${markdownName} is missing governance field ${field}`);
  }
}

const articles = [...html.matchAll(/<article class="reader-slide[^>]+id="slide-(\d+)"[\s\S]*?<\/article>/g)];
const expectedIds = Array.from({ length: 110 }, (_, index) => String(index + 1));
const actualIds = articles.map((match) => match[1]);
assert(articles.length === 110, `Expected 110 reading units; found ${articles.length}`);
assert(actualIds.join(",") === expectedIds.join(","), "Reading unit IDs are missing, duplicated, or out of order");

assert(!html.includes("file://"), "Reader contains a workstation-specific file URL");
assert(!html.includes("/.codex/"), "Reader contains a Codex workspace path");
assert(html.includes('new URLSearchParams(location.search).get("focus")'), "Focused reader mode is missing");

for (const match of html.matchAll(/href="\.\.\/\.\.\/([^"#]+)#L(\d+)"/g)) {
  const relative = decodeURI(match[1]);
  const line = Number(match[2]);
  const file = path.resolve(directory, "../..", relative);
  assert(fs.existsSync(file), `Missing cited source: ${relative}`);
  if (fs.existsSync(file)) {
    const lineCount = fs.readFileSync(file, "utf8").split("\n").length;
    assert(line > 0 && line <= lineCount, `Invalid cited line ${relative}#L${line}; file has ${lineCount} lines`);
  }
}

for (const match of html.matchAll(/<div class="source-frame" data-source-excerpt><div class="source-title"><span>([^<]+)<\/span><span>L(\d+)-L(\d+)<\/span><\/div><pre class="source-lines">([\s\S]*?)<\/pre><\/div>/g)) {
  const relative = match[1];
  const start = Number(match[2]);
  const end = Number(match[3]);
  const sourcePath = path.resolve(directory, "../..", relative);
  if (!fs.existsSync(sourcePath)) continue;
  const sourceLines = fs.readFileSync(sourcePath, "utf8").split(/\r?\n/);
  const excerptLines = [...match[4].matchAll(/<span class="source-line"><i>(\d+)<\/i><code>([\s\S]*?)<\/code><\/span>/g)];
  assert(excerptLines.length === end - start + 1, `Excerpt length does not match ${relative} L${start}-L${end}`);
  for (const excerptLine of excerptLines) {
    const lineNumber = Number(excerptLine[1]);
    const expected = escapeHtml(sourceLines[lineNumber - 1] || " ");
    assert(excerptLine[2] === expected, `Stale embedded excerpt: ${relative}#L${lineNumber}`);
  }
}

for (const match of html.matchAll(/data-evidence-link data-start="(\d+)" data-end="(\d+)" href="\.\.\/\.\.\/([^"#]+)#L\d+"/g)) {
  const start = Number(match[1]);
  const end = Number(match[2]);
  const relative = decodeURI(match[3]);
  const file = path.resolve(directory, "../..", relative);
  if (fs.existsSync(file)) {
    const lineCount = fs.readFileSync(file, "utf8").split("\n").length;
    assert(start > 0 && end >= start && end <= lineCount, `Invalid evidence range ${relative} L${start}-L${end}; file has ${lineCount} lines`);
  }
}

for (const match of html.matchAll(/src="(assets\/[^"]+\.svg)"/g)) {
  assert(fs.existsSync(path.join(directory, match[1])), `Missing diagram asset: ${match[1]}`);
}

assert(!/Engineering consequence|ARROWS navigate|slide-controls|class="slide"/.test(html), "Legacy fixed-deck template content remains");

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log(JSON.stringify({
  readingUnits: articles.length,
  repositoryCitations: [...html.matchAll(/href="\.\.\/\.\.\/[^"#]+#L\d+"/g)].length,
  diagramAssets: [...html.matchAll(/src="assets\/[^"]+\.svg"/g)].length,
  status: "pass",
}, null, 2));
