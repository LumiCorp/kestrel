import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BRAND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPORT_DIR = path.join(BRAND_ROOT, "exports");
const MARK_MASTER = path.join(BRAND_ROOT, "masters", "kestrel-mark-black.svg");
const temp = mkdtempSync(path.join(tmpdir(), "kestrel-desktop-icon-"));

function run(command, args) {
  execFileSync(command, args, { cwd: BRAND_ROOT, stdio: "inherit" });
}

function renderIcon(size, destination) {
  const markSize = Math.round(size * 0.625);
  const markPath = path.join(temp, `mark-${size}.png`);
  run("rsvg-convert", [
    "--width",
    String(markSize),
    "--height",
    String(markSize),
    "--output",
    markPath,
    MARK_MASTER,
  ]);
  run("magick", [
    "-size",
    `${size}x${size}`,
    "canvas:#ffffff",
    markPath,
    "-gravity",
    "center",
    "-composite",
    `PNG32:${destination}`,
  ]);
}

function writeIcns(entries, destination) {
  const chunks = entries.map(([type, source]) => {
    const image = readFileSync(source);
    const chunk = Buffer.alloc(8 + image.length);
    chunk.write(type, 0, 4, "ascii");
    chunk.writeUInt32BE(chunk.length, 4);
    image.copy(chunk, 8);
    return chunk;
  });
  const totalLength = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(totalLength, 4);
  writeFileSync(destination, Buffer.concat([header, ...chunks], totalLength));
}

try {
  mkdirSync(EXPORT_DIR, { recursive: true });

  const pngPath = path.join(EXPORT_DIR, "kestrel-app-icon-light.png");
  const icnsPath = path.join(EXPORT_DIR, "kestrel-app-icon-light.icns");
  const icoPath = path.join(EXPORT_DIR, "kestrel-app-icon-light.ico");
  renderIcon(1024, pngPath);

  const icnsSources = [];
  for (const [type, size] of [
    ["icp4", 16],
    ["icp5", 32],
    ["icp6", 64],
    ["ic07", 128],
    ["ic08", 256],
    ["ic09", 512],
    ["ic10", 1024],
  ]) {
    const source = path.join(temp, `icns-${size}.png`);
    renderIcon(size, source);
    icnsSources.push([type, source]);
  }
  writeIcns(icnsSources, icnsPath);

  const icoSources = [];
  for (const size of [16, 32, 48, 64, 128, 256]) {
    const source = path.join(temp, `icon-${size}.png`);
    renderIcon(size, source);
    icoSources.push(source);
  }
  run("magick", [...icoSources, icoPath]);

  console.log("Built approved black-on-white Kestrel Desktop app icons.");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
