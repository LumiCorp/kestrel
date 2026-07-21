import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parseDesktopUiStateV1,
  type DesktopUiStateSyncResult,
  type DesktopUiStateV1,
} from "../desktopShell/contracts.js";
import { resolveLocalCorePaths } from "./home.js";

const DESKTOP_UI_STATE_FILE_NAME = "desktop-ui-state.json";
const mutationTails = new Map<string, Promise<void>>();

export class DesktopUiStateStore {
  private readonly filePath: string;

  constructor(homePath: string) {
    this.filePath = path.join(
      resolveLocalCorePaths(homePath).settingsPath,
      DESKTOP_UI_STATE_FILE_NAME,
    );
  }

  async load(): Promise<DesktopUiStateV1 | null> {
    try {
      return parseDesktopUiStateV1(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async sync(state: DesktopUiStateV1): Promise<DesktopUiStateSyncResult> {
    const next = parseDesktopUiStateV1(state);
    return await withMutation(this.filePath, async () => {
      const current = await this.load();
      if (current !== null && desktopUiStateContentMatches(current, next)) {
        return {
          state: current,
          updated: false,
        };
      }

      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        await rename(temporary, this.filePath);
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
      return {
        state: next,
        updated: true,
      };
    });
  }
}

async function withMutation<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationTails.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  mutationTails.set(filePath, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (mutationTails.get(filePath) === current) {
      mutationTails.delete(filePath);
    }
  }
}

function desktopUiStateContentMatches(
  current: DesktopUiStateV1,
  next: DesktopUiStateV1,
): boolean {
  return current.source === next.source
    && current.sourceAppVersion === next.sourceAppVersion
    && JSON.stringify(current.entries) === JSON.stringify(next.entries);
}
