import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WEB_ASSETS, webAssetName } from "./web-assets.mjs";

const BRAND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.resolve(BRAND_ROOT, "../apps/web/public/brand");

rmSync(destination, { force: true, recursive: true });
mkdirSync(destination, { recursive: true });

for (const source of WEB_ASSETS) {
  copyFileSync(path.join(BRAND_ROOT, source), path.join(destination, webAssetName(source)));
}

console.log(`Synced ${WEB_ASSETS.length} approved Kestrel web brand assets.`);
