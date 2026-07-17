import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { UiState, UiStateFile } from "../../contracts.js";
import { DEFAULT_THEME_MODE, isThemeMode, themeModeFromLegacyPreset } from "../theme/tokens.js";
import { normalizeRestoredActiveRegion } from "../focusPolicy.js";
import { resolveKestrelHomePath } from "../../../src/runtime/kestrelHome.js";
import { extractResponseField, resolveLocalCoreStoreClient } from "../../localCoreStoreClient.js";

const UI_STATE_FILE_NAME = "ui-state.json";

export class UiStateStore {
  private readonly baseDir: string;
  private readonly filePath: string;

  constructor(baseDir = resolveKestrelHomePath()) {
    this.baseDir = baseDir;
    this.filePath = path.join(this.baseDir, UI_STATE_FILE_NAME);
  }

  async load(): Promise<UiState | undefined> {
    const core = resolveLocalCoreStoreClient(this.baseDir);
    if (core !== undefined) {
      const state = extractResponseField<UiState | null>(
        await core.client.getJson("/v1/ui-state"),
        "state",
        "ui state",
      );
      return state === null ? undefined : migrateUiState(state);
    }

    await mkdir(this.baseDir, { recursive: true });
    let raw: string;

    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return ;
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as UiStateFile;
      if (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3 && parsed.version !== 4 && parsed.version !== 5) {
        return ;
      }
      return migrateUiState(parsed.state);
    } catch {
      return ;
    }
  }

  async save(state: UiState): Promise<void> {
    const core = resolveLocalCoreStoreClient(this.baseDir);
    if (core !== undefined) {
      await core.client.putJson("/v1/ui-state", { state });
      return;
    }

    await mkdir(this.baseDir, { recursive: true });
    const payload: UiStateFile = {
      version: 5,
      state,
    };
    await writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}

function migrateUiState(state: UiState): UiState {
  const nextMode = state.themeMode;
  return {
    ...state,
    version: 5,
    activeRegion: normalizeRestoredActiveRegion(state.activeView, state.activeRegion ?? "composer"),
    layoutMode: "minimal",
    paneSizes: state.paneSizes ?? {
      sessions: 0.28,
      chat: 0.44,
      logs: 0.28,
    },
    themeMode: typeof nextMode === "string" && isThemeMode(nextMode)
      ? nextMode
      : state.themePreset !== undefined
        ? themeModeFromLegacyPreset(state.themePreset)
        : DEFAULT_THEME_MODE,
  };
}
