import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WEB_ASSETS, webAssetName } from "./web-assets.mjs";

const BRAND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.resolve(BRAND_ROOT, "../apps/web/public/brand");
const expectedNames = WEB_ASSETS.map(webAssetName).sort();

assert.deepEqual(
  readdirSync(destination).sort(),
  expectedNames,
  "Web brand export set differs from the approved distribution contract"
);

for (const source of WEB_ASSETS) {
  const name = webAssetName(source);
  assert.deepEqual(
    readFileSync(path.join(destination, name)),
    readFileSync(path.join(BRAND_ROOT, source)),
    `${name} differs from its approved canonical export`
  );
}

console.log(`Web brand assets match ${WEB_ASSETS.length} approved exports.`);
