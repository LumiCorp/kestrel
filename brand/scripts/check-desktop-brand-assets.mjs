import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_ASSETS,
  desktopAssetName,
} from "./desktop-assets.mjs";

const BRAND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.resolve(BRAND_ROOT, "../apps/desktop/assets");

for (const source of DESKTOP_ASSETS) {
  const name = desktopAssetName(source);
  assert.deepEqual(
    readFileSync(path.join(destination, name)),
    readFileSync(path.join(BRAND_ROOT, source)),
    `${name} differs from its approved canonical export`,
  );
}

console.log(`Desktop brand assets match ${DESKTOP_ASSETS.length} approved exports.`);
