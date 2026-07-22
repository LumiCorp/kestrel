import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BRAND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MASTER_DIR = path.join(BRAND_ROOT, "masters");
const EXPORT_DIR = path.join(BRAND_ROOT, "exports");
const REVIEW_DIR = path.join(BRAND_ROOT, "review");
const svgNames = [
  "kestrel-mark-black.svg",
  "kestrel-mark-white.svg",
  "kestrel-one-lockup-black.svg",
  "kestrel-one-lockup-white.svg",
];
const canonicalSvgNames = [...svgNames, "kestrel-one-social-card.svg"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(relative) {
  return readFileSync(path.join(BRAND_ROOT, relative));
}

function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function pngDimensions(relative) {
  const png = read(relative);
  assert(png.subarray(1, 4).toString("ascii") === "PNG", `${relative} is not a PNG`);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), colorType: png[25] };
}

const approval = JSON.parse(readFileSync(path.join(BRAND_ROOT, "approval.json"), "utf8"));
assert(approval.version === 1, "Unsupported brand approval version");
assert(/^\d{4}-\d{2}-\d{2}$/u.test(approval.approvedAt), "Brand approval date is invalid");
assert(
  digest(read("review/kestrel-one-brand-review.png")) === approval.reviewSha256,
  "Approved brand review sheet has changed"
);
assert(
  JSON.stringify(Object.keys(approval.files).sort()) ===
    JSON.stringify(canonicalSvgNames.map((name) => `masters/${name}`).sort()),
  "Approved canonical master set has changed"
);
for (const [relative, approvedDigest] of Object.entries(approval.files)) {
  assert(digest(read(relative)) === approvedDigest, `${relative} differs from its approved geometry`);
}

for (const name of canonicalSvgNames) {
  const svg = readFileSync(path.join(MASTER_DIR, name), "utf8");
  const expectedViewBox = name.includes("social-card")
    ? "0 0 1200 630"
    : name.includes("lockup")
      ? "0 0 680 100"
      : "0 0 721 721";
  assert(svg.includes(`viewBox="${expectedViewBox}"`), `${name} has the wrong viewBox`);
  assert(!/<(?:text|script|image)\b/iu.test(svg), `${name} contains a forbidden element`);
  assert(!/(?:font-family|data:image|#[a-f\d]{6})/iu.test(svg.replaceAll("#111111", "").replaceAll("#ffffff", "")), `${name} contains an unapproved dependency or color`);
}

const blackMark = readFileSync(path.join(MASTER_DIR, svgNames[0]), "utf8").replaceAll("#111111", "TONE");
const whiteMark = readFileSync(path.join(MASTER_DIR, svgNames[1]), "utf8").replaceAll("#ffffff", "TONE");
const blackLockup = readFileSync(path.join(MASTER_DIR, svgNames[2]), "utf8").replaceAll("#111111", "TONE");
const whiteLockup = readFileSync(path.join(MASTER_DIR, svgNames[3]), "utf8").replaceAll("#ffffff", "TONE");
assert(blackMark === whiteMark, "Black and white mark geometry differs");
assert(blackLockup === whiteLockup, "Black and white lockup geometry differs");

for (const size of [16, 32, 180, 192, 512]) {
  for (const tone of ["light", "dark"]) {
    const filename = `exports/favicon-${tone}-${size}.png`;
    const dimensions = pngDimensions(filename);
    assert(dimensions.width === size && dimensions.height === size, `${filename} has the wrong dimensions`);
  }
}

const expectedPngs = new Map([
  ["exports/kestrel-mark-black-512.png", [512, 512]],
  ["exports/kestrel-mark-black-1024.png", [1024, 1024]],
  ["exports/kestrel-mark-white-512.png", [512, 512]],
  ["exports/kestrel-mark-white-1024.png", [1024, 1024]],
  ["exports/kestrel-one-lockup-black-1x.png", [680, 100]],
  ["exports/kestrel-one-lockup-black-2x.png", [1360, 200]],
  ["exports/kestrel-one-lockup-black-512.png", [512, 75]],
  ["exports/kestrel-one-lockup-black-1024.png", [1024, 151]],
  ["exports/kestrel-one-lockup-white-1x.png", [680, 100]],
  ["exports/kestrel-one-lockup-white-2x.png", [1360, 200]],
  ["exports/kestrel-one-lockup-white-512.png", [512, 75]],
  ["exports/kestrel-one-lockup-white-1024.png", [1024, 151]],
  ["exports/kestrel-one-social-card.png", [1200, 630]],
  ["review/kestrel-one-brand-review.png", [1600, 1900]],
]);
for (const [relative, [width, height]] of expectedPngs) {
  const dimensions = pngDimensions(relative);
  assert(dimensions.width === width && dimensions.height === height, `${relative} has the wrong dimensions`);
  if (relative.startsWith("exports/kestrel-") && !relative.includes("social-card")) {
    assert([4, 6].includes(dimensions.colorType), `${relative} must preserve transparency`);
  }
}

for (const relative of [
  "exports/favicon-light.ico",
  "exports/favicon-dark.ico",
  "review/kestrel-one-brand-review.svg",
]) {
  assert(statSync(path.join(BRAND_ROOT, relative)).size > 0, `${relative} is missing`);
}

const forbidden = /better auth|chatbot|starter template|#f71925|#c91b2e/iu;
for (const relative of [
  ...canonicalSvgNames.map((name) => `masters/${name}`),
  "review/kestrel-one-brand-review.svg",
]) {
  assert(!forbidden.test(readFileSync(path.join(BRAND_ROOT, relative), "utf8")), `${relative} contains retired brand residue`);
}

console.log(`Brand assets passed (${digest(read("review/kestrel-one-brand-review.png")).slice(0, 12)})`);
