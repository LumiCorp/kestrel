import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ApprovalPolicyPackId, StoreDriverId } from "../contracts.js";
import { extractResponseField, resolveLocalCoreStoreClient } from "../localCoreStoreClient.js";

export interface RuntimeSettingsDefaults {
  profileId?: string | undefined;
  storeDriver?: StoreDriverId | undefined;
  sqlitePath?: string | undefined;
  approvalPolicyPackId?: ApprovalPolicyPackId | undefined;
  minimalMode?: boolean | undefined;
}

export interface RuntimeSettingsFile {
  version: 1;
  defaults: RuntimeSettingsDefaults;
}

const EMPTY_RUNTIME_SETTINGS: RuntimeSettingsFile = {
  version: 1,
  defaults: {},
};

export async function readRuntimeSettings(home: string): Promise<RuntimeSettingsFile> {
  const core = resolveLocalCoreStoreClient(home);
  if (core !== undefined) {
    return extractResponseField<RuntimeSettingsFile>(
      await core.client.getJson("/v1/runtime-settings"),
      "runtimeSettings",
      "runtime settings",
    );
  }

  const settingsPath = path.join(home, "settings.json");
  try {
    const raw = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as RuntimeSettingsFile;
    if (parsed.version !== 1 || typeof parsed.defaults !== "object" || parsed.defaults === null) {
      return EMPTY_RUNTIME_SETTINGS;
    }
    return {
      version: 1,
      defaults: {
        ...(parseOptionalString(parsed.defaults.profileId) !== undefined
          ? { profileId: parseOptionalString(parsed.defaults.profileId) }
          : {}),
        ...(parseOptionalStoreDriver(parsed.defaults.storeDriver) !== undefined
          ? { storeDriver: parseOptionalStoreDriver(parsed.defaults.storeDriver) }
          : {}),
        ...(parseOptionalString(parsed.defaults.sqlitePath) !== undefined
          ? { sqlitePath: parseOptionalString(parsed.defaults.sqlitePath) }
          : {}),
        ...(parseOptionalApprovalPolicyPack(parsed.defaults.approvalPolicyPackId) !== undefined
          ? { approvalPolicyPackId: parseOptionalApprovalPolicyPack(parsed.defaults.approvalPolicyPackId) }
          : {}),
        ...(typeof parsed.defaults.minimalMode === "boolean"
          ? { minimalMode: parsed.defaults.minimalMode }
          : {}),
      },
    };
  } catch {
    return EMPTY_RUNTIME_SETTINGS;
  }
}

export async function writeRuntimeSettings(home: string, settings: RuntimeSettingsFile): Promise<void> {
  const core = resolveLocalCoreStoreClient(home);
  if (core !== undefined) {
    await core.client.putJson("/v1/runtime-settings", { runtimeSettings: settings });
    return;
  }

  const settingsPath = path.join(home, "settings.json");
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function parseOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalStoreDriver(value: unknown): StoreDriverId | undefined {
  if (value === "auto" || value === "postgres" || value === "sqlite") {
    return value;
  }
  return undefined;
}

function parseOptionalApprovalPolicyPack(value: unknown): ApprovalPolicyPackId | undefined {
  if (value === "dev" || value === "ci_bot" || value === "production") {
    return value;
  }
  return undefined;
}
