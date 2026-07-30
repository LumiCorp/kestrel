import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_ASSETS,
  desktopAssetName,
} from "./desktop-assets.mjs";

const BRAND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.resolve(BRAND_ROOT, "../apps/desktop/assets");

mkdirSync(destination, { recursive: true });
for (const source of DESKTOP_ASSETS) {
  copyFileSync(
    path.join(BRAND_ROOT, source),
    path.join(destination, desktopAssetName(source)),
  );
}

console.log(`Synced ${DESKTOP_ASSETS.length} approved Kestrel Desktop brand assets.`);
