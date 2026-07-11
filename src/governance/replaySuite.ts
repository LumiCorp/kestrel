import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CapturedReplayBundle } from "./contracts.js";

const DEFAULT_SUITE_DIR = path.join(process.cwd(), "tests", "fixtures", "replay-suite");

export class ReplayBaselineSuiteStore {
  private readonly suiteDir: string;

  constructor(suiteDir = process.env.KESTREL_REPLAY_SUITE_DIR ?? DEFAULT_SUITE_DIR) {
    this.suiteDir = suiteDir;
  }

  getSuiteDir(): string {
    return this.suiteDir;
  }

  async listBundles(): Promise<CapturedReplayBundle[]> {
    let files: string[];
    try {
      files = await readdir(this.suiteDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const bundles = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => {
          const raw = await readFile(path.join(this.suiteDir, file), "utf8");
          return JSON.parse(raw) as CapturedReplayBundle;
        }),
    );

    return bundles.filter((bundle) => bundle.manifest?.flow_id !== undefined);
  }

  async findPrimaryBundleForBehavior(behaviorId: string, mode: "mock" | "replay" | "live"): Promise<CapturedReplayBundle | null> {
    const bundles = await this.listBundles();
    return bundles.find((bundle) =>
      bundle.manifest.source_behavior_id === behaviorId &&
      bundle.manifest.source_mode === mode &&
      bundle.manifest.primary_for_behavior === true,
    ) ?? null;
  }

  async writeBundle(bundle: CapturedReplayBundle): Promise<string> {
    await mkdir(this.suiteDir, { recursive: true });
    const filePath = path.join(this.suiteDir, `${bundle.manifest.flow_id}.json`);
    await writeFile(filePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    return filePath;
  }
}
