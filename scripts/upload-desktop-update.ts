import { readFileSync } from "node:fs";
import path from "node:path";

import { createDesktopUpdateR2StoreFromEnvironment } from "./desktop-update-r2-store.js";
import { uploadDesktopUpdateRelease } from "./desktop-update-publisher.js";

const root = resolveRoot(process.cwd());
const version = readVersion(path.join(root, "apps", "desktop", "package.json"));
const { store, prefix } = createDesktopUpdateR2StoreFromEnvironment();
const result = await uploadDesktopUpdateRelease({
  outDir: path.join(root, "apps", "desktop", "out"),
  version,
  store,
  prefix,
});
process.stdout.write(
  `[desktop-update-upload] version=${version} uploaded=${
    result.uploaded.length
  } skipped=${result.skipped.length} metadata=${result.releaseMetadataKey}\n`,
);

function readVersion(file: string): string {
  const value = JSON.parse(readFileSync(file, "utf8")) as {
    version?: unknown;
  };
  if (typeof value.version !== "string") {
    throw new Error(`Missing package version in ${file}.`);
  }
  return value.version;
}

function resolveRoot(cwd: string): string {
  let current = cwd;
  while (true) {
    if (readFileExists(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to find workspace root from ${cwd}.`);
    }
    current = parent;
  }
}

function readFileExists(file: string): boolean {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}
