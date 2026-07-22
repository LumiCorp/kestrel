import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BRAND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(BRAND_ROOT, "..");
const MASTER_DIR = path.join(BRAND_ROOT, "masters");
const EXPORT_DIR = path.join(BRAND_ROOT, "exports");
const REVIEW_DIR = path.join(BRAND_ROOT, "review");
const SOURCE_MARK = path.join(REPO_ROOT, "apps/desktop/assets/kestrel-head.png");
const GEIST_FONT = path.join(
  REPO_ROOT,
  "apps/web/node_modules/geist/dist/fonts/geist-sans/Geist-SemiBold.ttf"
);
const temp = mkdtempSync(path.join(tmpdir(), "kestrel-brand-"));

const BLACK = "#111111";
const WHITE = "#ffffff";
const MARK_VIEWBOX = 721;
const LOCKUP_WIDTH = 680;
const LOCKUP_HEIGHT = 100;

for (const directory of [MASTER_DIR, EXPORT_DIR, REVIEW_DIR]) {
  mkdirSync(directory, { recursive: true });
}

function run(command, args) {
  execFileSync(command, args, { cwd: REPO_ROOT, stdio: "inherit" });
}

function readSvgParts(svg) {
  const transform = svg.match(/<g transform="([^"]+)"\s+fill=/u)?.[1];
  const pathData = svg.match(/<path d="([\s\S]*?)"\/>/u)?.[1];
  if (!(transform && pathData)) {
    throw new Error("Could not read the traced Kestrel mark.");
  }
  return { pathData, transform };
}

function readWordmarkParts(svg) {
  const definitions = svg.match(/<defs>([\s\S]*?)<\/defs>/u)?.[1];
  const uses = svg.match(
    /<g fill="rgb\(0%, 0%, 0%\)" fill-opacity="1">([\s\S]*?)<\/g>\s*<\/svg>/u
  )?.[1];
  if (!(definitions && uses)) {
    throw new Error("Could not outline the Geist Kestrel One wordmark.");
  }
  return { definitions, uses };
}

function markDrawing(fill, trace) {
  return `<g transform="translate(0 0.5)">
    <g transform="${trace.transform}" fill="${fill}" stroke="none">
      <path d="${trace.pathData}"/>
    </g>
  </g>`;
}

function markSvg(fill, trace) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}" role="img">
  ${markDrawing(fill, trace)}
</svg>
`;
}

function lockupSvg(fill, trace, wordmark) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${LOCKUP_WIDTH} ${LOCKUP_HEIGHT}" role="img">
  <defs>${wordmark.definitions}</defs>
  ${lockupDrawing(fill, trace, wordmark)}
</svg>
`;
}

function lockupDrawing(fill, trace, wordmark) {
  const markScale = (100 / MARK_VIEWBOX).toFixed(8);
  return `<g transform="scale(${markScale})">${markDrawing(fill, trace)}</g>
  <g transform="translate(105 -31)" fill="${fill}">${wordmark.uses}</g>`;
}

function writeMaster(name, contents) {
  const destination = path.join(MASTER_DIR, name);
  writeFileSync(destination, contents);
  return destination;
}

function renderSvg(source, destination, width, height) {
  run("rsvg-convert", [
    "--width",
    String(width),
    "--height",
    String(height),
    "--output",
    destination,
    source,
  ]);
}

function appIconSvg(fill, background, trace) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${background}"/>
  <g transform="translate(96 96) scale(${(320 / MARK_VIEWBOX).toFixed(8)})">${markDrawing(fill, trace)}</g>
</svg>
`;
}

function approvalSheetSvg(trace, wordmark) {
  const smallSizes = [16, 24, 32, 48, 128];
  const smallLight = smallSizes
    .map((size, index) => `<use href="#mark" x="${90 + index * 130}" y="690" width="${size}" height="${size}" color="${BLACK}"/><text x="${90 + index * 130}" y="850" class="caption">${size}px</text>`)
    .join("\n");
  const smallDark = smallSizes
    .map((size, index) => `<use href="#mark" x="${890 + index * 120}" y="690" width="${size}" height="${size}" color="${WHITE}"/><text x="${890 + index * 120}" y="850" class="caption inverse">${size}px</text>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1600 1900">
  <defs>
    ${wordmark.definitions}
    <symbol id="mark" viewBox="0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}">${markDrawing("currentColor", trace)}</symbol>
    <symbol id="lockup" viewBox="0 0 ${LOCKUP_WIDTH} ${LOCKUP_HEIGHT}">${lockupDrawing("currentColor", trace, wordmark)}</symbol>
  </defs>
  <style>
    .title { font: 600 46px Arial, sans-serif; fill: #111111; }
    .heading { font: 600 25px Arial, sans-serif; fill: #111111; }
    .body { font: 400 17px Arial, sans-serif; fill: #555555; }
    .caption { font: 600 15px Arial, sans-serif; fill: #555555; }
    .inverse { fill: #d8d8d8; }
  </style>
  <rect width="1600" height="1900" fill="#ececec"/>
  <text x="70" y="82" class="title">Kestrel One — Monochrome Brand Review</text>
  <text x="70" y="120" class="body">Approval gate • traced kestrel-head • outlined Geist Sans Semibold • #111111 / #ffffff only</text>

  <rect x="60" y="170" width="720" height="420" rx="18" fill="#ffffff"/>
  <text x="90" y="218" class="heading">Black on white</text>
  <use href="#mark" x="90" y="260" width="190" height="190" color="${BLACK}"/>
  <use href="#lockup" x="330" y="300" width="400" height="59" color="${BLACK}"/>
  <text x="90" y="535" class="body">Canonical light-appearance treatment</text>

  <rect x="820" y="170" width="720" height="420" rx="18" fill="${BLACK}"/>
  <text x="850" y="218" class="heading inverse">White on black</text>
  <use href="#mark" x="850" y="260" width="190" height="190" color="${WHITE}"/>
  <use href="#lockup" x="1090" y="300" width="400" height="59" color="${WHITE}"/>
  <text x="850" y="535" class="body inverse">Canonical dark-appearance treatment</text>

  <rect x="60" y="630" width="720" height="270" rx="18" fill="#ffffff"/>
  <text x="90" y="670" class="heading">Mark reduction</text>
  ${smallLight}
  <rect x="820" y="630" width="720" height="270" rx="18" fill="${BLACK}"/>
  <text x="850" y="670" class="heading inverse">Mark reduction — inverse</text>
  ${smallDark}

  <rect x="60" y="940" width="720" height="330" rx="18" fill="#ffffff"/>
  <text x="90" y="985" class="heading">Application lockup sizes</text>
  <use href="#lockup" x="90" y="1030" width="109" height="16" color="${BLACK}"/>
  <text x="230" y="1046" class="caption">16px — expanded sidebar</text>
  <use href="#lockup" x="90" y="1090" width="163" height="24" color="${BLACK}"/>
  <text x="285" y="1111" class="caption">24px — shared transcript</text>
  <use href="#lockup" x="90" y="1160" width="272" height="40" color="${BLACK}"/>
  <text x="395" y="1188" class="caption">40px — authentication</text>

  <rect x="820" y="940" width="720" height="330" rx="18" fill="#ffffff"/>
  <text x="850" y="985" class="heading">Clear space and app icons</text>
  <rect x="860" y="1030" width="192" height="192" fill="none" stroke="#777777" stroke-dasharray="8 7"/>
  <use href="#mark" x="892" y="1062" width="128" height="128" color="${BLACK}"/>
  <text x="860" y="1250" class="caption">¼-mark minimum clear space</text>
  <rect x="1120" y="1040" width="128" height="128" fill="${WHITE}"/>
  <use href="#mark" x="1144" y="1064" width="80" height="80" color="${BLACK}"/>
  <rect x="1300" y="1040" width="128" height="128" fill="${BLACK}"/>
  <use href="#mark" x="1324" y="1064" width="80" height="80" color="${WHITE}"/>
  <text x="1120" y="1198" class="caption">Light icon</text>
  <text x="1300" y="1198" class="caption">Dark icon</text>

  <rect x="60" y="1310" width="1480" height="520" rx="18" fill="#ffffff"/>
  <text x="90" y="1355" class="heading">Social card — native asset 1200 × 630</text>
  <rect x="290" y="1390" width="1020" height="378" fill="${BLACK}"/>
  <use href="#lockup" x="510" y="1529" width="580" height="85" color="${WHITE}"/>
  <text x="90" y="1800" class="body">Centered white lockup on solid black. No descriptor, screenshots, gradients, or secondary identity.</text>
</svg>
`;
}

try {
  const mask = path.join(temp, "kestrel-mask.pbm");
  const tracedSvg = path.join(temp, "kestrel-traced.svg");
  const wordmarkSvg = path.join(temp, "kestrel-one-wordmark.svg");
  run("magick", [SOURCE_MARK, "-alpha", "extract", "-negate", "-threshold", "50%", mask]);
  run("potrace", [
    mask,
    "--svg",
    "--tight",
    "--alphamax",
    "1",
    "--opttolerance",
    "0.2",
    "--output",
    tracedSvg,
  ]);
  run("hb-view", [
    GEIST_FONT,
    "--text=Kestrel One",
    "--font-size=100",
    "--output-format=svg",
    `--output-file=${wordmarkSvg}`,
  ]);

  const trace = readSvgParts(readFileSync(tracedSvg, "utf8"));
  const wordmark = readWordmarkParts(readFileSync(wordmarkSvg, "utf8"));
  const markBlack = writeMaster("kestrel-mark-black.svg", markSvg(BLACK, trace));
  const markWhite = writeMaster("kestrel-mark-white.svg", markSvg(WHITE, trace));
  const lockupBlack = writeMaster(
    "kestrel-one-lockup-black.svg",
    lockupSvg(BLACK, trace, wordmark)
  );
  const lockupWhite = writeMaster(
    "kestrel-one-lockup-white.svg",
    lockupSvg(WHITE, trace, wordmark)
  );

  for (const [source, stem] of [
    [markBlack, "kestrel-mark-black"],
    [markWhite, "kestrel-mark-white"],
  ]) {
    renderSvg(source, path.join(EXPORT_DIR, `${stem}-512.png`), 512, 512);
    renderSvg(source, path.join(EXPORT_DIR, `${stem}-1024.png`), 1024, 1024);
  }
  for (const [source, stem] of [
    [lockupBlack, "kestrel-one-lockup-black"],
    [lockupWhite, "kestrel-one-lockup-white"],
  ]) {
    renderSvg(source, path.join(EXPORT_DIR, `${stem}-1x.png`), 680, 100);
    renderSvg(source, path.join(EXPORT_DIR, `${stem}-2x.png`), 1360, 200);
    renderSvg(source, path.join(EXPORT_DIR, `${stem}-512.png`), 512, 75);
    renderSvg(source, path.join(EXPORT_DIR, `${stem}-1024.png`), 1024, 151);
  }

  const iconLightSvg = path.join(temp, "favicon-light-source.svg");
  const iconDarkSvg = path.join(temp, "favicon-dark-source.svg");
  writeFileSync(iconLightSvg, appIconSvg(BLACK, WHITE, trace));
  writeFileSync(iconDarkSvg, appIconSvg(WHITE, BLACK, trace));
  for (const size of [16, 32, 180, 192, 512]) {
    renderSvg(iconLightSvg, path.join(EXPORT_DIR, `favicon-light-${size}.png`), size, size);
    renderSvg(iconDarkSvg, path.join(EXPORT_DIR, `favicon-dark-${size}.png`), size, size);
  }
  run("magick", [
    path.join(EXPORT_DIR, "favicon-light-16.png"),
    path.join(EXPORT_DIR, "favicon-light-32.png"),
    path.join(EXPORT_DIR, "favicon-light.ico"),
  ]);
  run("magick", [
    path.join(EXPORT_DIR, "favicon-dark-16.png"),
    path.join(EXPORT_DIR, "favicon-dark-32.png"),
    path.join(EXPORT_DIR, "favicon-dark.ico"),
  ]);

  const socialSvg = path.join(MASTER_DIR, "kestrel-one-social-card.svg");
  writeFileSync(
    socialSvg,
    `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1200 630">\n  <defs>${wordmark.definitions}</defs>\n  <rect width="1200" height="630" fill="${BLACK}"/>\n  <g transform="translate(260 265)">${lockupDrawing(WHITE, trace, wordmark)}</g>\n</svg>\n`
  );
  renderSvg(socialSvg, path.join(EXPORT_DIR, "kestrel-one-social-card.png"), 1200, 630);

  const reviewSvg = path.join(REVIEW_DIR, "kestrel-one-brand-review.svg");
  writeFileSync(reviewSvg, approvalSheetSvg(trace, wordmark));
  renderSvg(
    reviewSvg,
    path.join(REVIEW_DIR, "kestrel-one-brand-review.png"),
    1600,
    1900
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
