import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BROWSER_RUNTIME_RELEASE_MANIFEST,
  type BrowserRuntimeTarget,
} from "../src/browser/runtimeReleaseManifest.js";
import { stageBrowserRuntimeSourceAssets } from "./browser-runtime-source-assets.js";

const TARGETS = Object.keys(
  BROWSER_RUNTIME_RELEASE_MANIFEST.targets,
) as BrowserRuntimeTarget[];

export function parseBrowserRuntimeSourceTarget(
  value: string | undefined,
): BrowserRuntimeTarget {
  if (!TARGETS.includes(value as BrowserRuntimeTarget)) {
    throw new Error(
      `Usage: stage-browser-runtime-sources <${TARGETS.join("|")}>`,
    );
  }
  return value as BrowserRuntimeTarget;
}

function resolveRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const target = parseBrowserRuntimeSourceTarget(process.argv[2]);
    const staged = stageBrowserRuntimeSourceAssets(resolveRepoRoot(), target);
    process.stdout.write(
      `Verified Browser runtime sources for ${target} in ${staged.sourceRoot}.\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Browser runtime source staging failed."}\n`,
    );
    process.exitCode = 1;
  }
}
