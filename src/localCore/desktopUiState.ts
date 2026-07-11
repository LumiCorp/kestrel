import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parseDesktopUiStateV1,
  type DesktopUiStateSyncResult,
  type DesktopUiStateV1,
} from "../desktopShell/contracts.js";
import { resolveLocalCorePaths } from "./home.js";

const DESKTOP_UI_STATE_FILE_NAME = "desktop-ui-state.json";

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
    const current = await this.load();
    if (current !== null && desktopUiStateContentMatches(current, next)) {
      return {
        state: current,
        updated: false,
      };
    }

    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return {
      state: next,
      updated: true,
    };
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
