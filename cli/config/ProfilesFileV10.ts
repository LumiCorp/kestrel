import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parseKestrelEnvironmentBindingV1,
  parseKestrelProfileDefinitionV1,
  type KestrelEnvironmentPresetIdV1,
} from "../../src/kestrel/contracts/profile.js";
import {
  createKestrelEnvironmentBindingFromOverlay,
  createKestrelProfileDefinitionFromOverlay,
  KESTREL_POLICY_ID,
  LEGACY_KESTREL_ONE_POLICY_ID,
  type KestrelOneProfileOverlay,
} from "../../src/profile/kestrelOnePolicy.js";
import type {
  KestrelOneManagedProfileOverlay,
  ProfilesFileV10,
  TuiProfile,
} from "../contracts.js";
import { parseProfilesFile } from "./ProfileStore.js";

export const PROFILES_FILE_V10_MIGRATION_REPORT_VERSION =
  "profiles_file_v10_migration_report_v1" as const;

export interface ProfilesFileV10MigrationReportV1 {
  version: typeof PROFILES_FILE_V10_MIGRATION_REPORT_VERSION;
  sourceVersion: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  sourceDigest: string;
  retainedManagedFields: string[];
  omittedProfileIds: string[];
  omittedAuthorityFields: Array<{
    profileId: string;
    fields: string[];
  }>;
  backupPath: string;
}

export interface PreparedProfilesFileV10Migration {
  profilesFile: ProfilesFileV10;
  report: ProfilesFileV10MigrationReportV1;
  sourceBytes: string;
  backupPath: string;
  reportPath: string;
}

const PRESET_IDS = [
  "cli_safe_local",
  "cli_dev_local",
  "desktop_safe_local",
  "desktop_dev_local",
  "workspace_hosted",
] as const satisfies readonly KestrelEnvironmentPresetIdV1[];
const PRESET_ID_SET = new Set<string>(PRESET_IDS);
const ROOT_FIELDS = new Set(["version", "profile", "environmentBindings"]);
const AUTHORITY_FIELDS = [
  "approvalPolicyPackId",
  "kestrelOneAppApprovalModes",
  "toolAllowlist",
  "mcpServers",
  "ociMcpEgressBindings",
  "codeMode",
  "devShell",
] as const;
const BEHAVIOR_FIELDS = [
  "recoveryPolicy",
  "evaluationPolicy",
  "reasoning",
  "delegationLimits",
] as const;
const ENVIRONMENT_FIELDS = [
  "modelProvider",
  "model",
  "modelCredential",
  "recoveryModelCandidates",
  "modelCapabilities",
  "storeDriver",
  "approvalPolicyPackId",
  "kestrelOneAppApprovalModes",
  "additionalToolNames",
  "mcpServers",
  "ociMcpEgressBindings",
  "toolQueue",
  "codeMode",
  "devShell",
] as const;

export function parseProfilesFileV10(raw: string): ProfilesFileV10 {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid profiles V10 JSON: ${error instanceof Error ? error.message : "unknown parse error"}`,
    );
  }
  const root = requireRecord(decoded, "profiles.json V10");
  rejectUnknownFields(root, ROOT_FIELDS, "profiles.json V10");
  if (root.version !== 10) {
    throw new Error("profiles.json V10 version must be 10");
  }
  const profile = parseKestrelProfileDefinitionV1(root.profile);
  const rawBindings = requireRecord(
    root.environmentBindings,
    "profiles.json V10 environmentBindings",
  );
  const bindingKeys = Object.keys(rawBindings);
  if (bindingKeys.length === 0) {
    throw new Error(
      "profiles.json V10 requires at least one Kestrel environment binding",
    );
  }
  const environmentBindings: ProfilesFileV10["environmentBindings"] = {};
  const bindingIds = new Set<string>();
  for (const key of bindingKeys.sort()) {
    if (PRESET_ID_SET.has(key) === false) {
      throw new Error(
        `profiles.json V10 environmentBindings contains unsupported key '${key}'`,
      );
    }
    const presetId = key as KestrelEnvironmentPresetIdV1;
    const binding = parseKestrelEnvironmentBindingV1(rawBindings[key]);
    if (binding.presetId !== presetId) {
      throw new Error(
        `profiles.json V10 binding '${key}' disagrees with preset '${binding.presetId}'`,
      );
    }
    if (bindingIds.has(binding.bindingId)) {
      throw new Error(
        `profiles.json V10 contains duplicate binding id '${binding.bindingId}'`,
      );
    }
    bindingIds.add(binding.bindingId);
    environmentBindings[presetId] = binding;
  }
  return { version: 10, profile, environmentBindings };
}

export function fingerprintProfilesFileV10(value: ProfilesFileV10): string {
  const parsed = parseProfilesFileV10(serializeProfilesFileV10(value));
  return digestCanonical(parsed);
}

export function serializeProfilesFileV10(value: ProfilesFileV10): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function prepareProfilesFileV10Migration(input: {
  raw: string;
  profilePath?: string | undefined;
}): PreparedProfilesFileV10Migration {
  const parsed = parseProfilesFile(input.raw);
  const sourceProfilePath = input.profilePath ?? "profiles.json";
  const backupPath = path.join(
    path.dirname(sourceProfilePath),
    `profiles.json.v${parsed.sourceVersion}.pre-v10.bak`,
  );
  const reportPath = path.join(
    path.dirname(sourceProfilePath),
    "profiles.json.v10-migration-report.json",
  );
  const managedProfile = parsed.profiles.find((profile) =>
    isManagedProfileId(profile.id),
  );
  const overlayByPreset = collectManagedOverlays(parsed.managedProfileOverlays);
  if (managedProfile !== undefined) {
    const presetId = normalizeManagedPreset(managedProfile.presetId);
    overlayByPreset.set(presetId, {
      ...extractManagedConfiguration(managedProfile),
      ...(overlayByPreset.get(presetId) ?? {}),
    });
  }
  if (overlayByPreset.size === 0) {
    overlayByPreset.set("cli_safe_local", {});
  }

  const definitionOverlay = resolveCanonicalBehaviorOverlay(overlayByPreset);
  const profile = createKestrelProfileDefinitionFromOverlay(definitionOverlay);
  const environmentBindings: ProfilesFileV10["environmentBindings"] = {};
  for (const presetId of PRESET_IDS) {
    const overlay = overlayByPreset.get(presetId);
    if (overlay === undefined) continue;
    environmentBindings[presetId] = createKestrelEnvironmentBindingFromOverlay({
      environmentPresetId: presetId,
      overlay: omitBehaviorFields(overlay),
      bindingId: `kestrel:${presetId}`,
    });
  }
  const profilesFile = parseProfilesFileV10(
    serializeProfilesFileV10({ version: 10, profile, environmentBindings }),
  );
  const omittedProfiles = parsed.profiles.filter(
    (candidate) => isManagedProfileId(candidate.id) === false,
  );
  const report: ProfilesFileV10MigrationReportV1 = {
    version: PROFILES_FILE_V10_MIGRATION_REPORT_VERSION,
    sourceVersion: parsed.sourceVersion,
    sourceDigest: digestBytes(input.raw),
    retainedManagedFields: collectRetainedManagedFields(overlayByPreset),
    omittedProfileIds: omittedProfiles.map((candidate) => candidate.id).sort(),
    omittedAuthorityFields: omittedProfiles
      .map((candidate) => ({
        profileId: candidate.id,
        fields: AUTHORITY_FIELDS.filter(
          (field) => candidate[field] !== undefined,
        ).sort(),
      }))
      .filter((entry) => entry.fields.length > 0)
      .sort((left, right) => left.profileId.localeCompare(right.profileId)),
    backupPath,
  };
  return {
    profilesFile,
    report,
    sourceBytes: input.raw,
    backupPath,
    reportPath,
  };
}

/**
 * Writes only migration evidence. PR1 intentionally does not replace
 * profiles.json or activate V10 loading.
 */
export async function writeProfilesFileV10MigrationArtifacts(
  prepared: PreparedProfilesFileV10Migration,
): Promise<void> {
  await mkdir(path.dirname(prepared.backupPath), { recursive: true });
  await writeExactBackup(prepared.backupPath, prepared.sourceBytes);
  await writeAtomicJson(prepared.reportPath, prepared.report);
}

function collectManagedOverlays(
  overlays:
    | {
        "kestrel@cli_safe_local"?: KestrelOneManagedProfileOverlay | undefined;
        "kestrel@cli_dev_local"?: KestrelOneManagedProfileOverlay | undefined;
        "kestrel@workspace_hosted"?: KestrelOneManagedProfileOverlay | undefined;
      }
    | undefined,
): Map<KestrelEnvironmentPresetIdV1, KestrelOneProfileOverlay> {
  const collected = new Map<
    KestrelEnvironmentPresetIdV1,
    KestrelOneProfileOverlay
  >();
  if (overlays?.["kestrel@cli_safe_local"] !== undefined) {
    collected.set(
      "cli_safe_local",
      structuredClone(overlays["kestrel@cli_safe_local"]),
    );
  }
  if (overlays?.["kestrel@cli_dev_local"] !== undefined) {
    collected.set(
      "cli_dev_local",
      structuredClone(overlays["kestrel@cli_dev_local"]),
    );
  }
  if (overlays?.["kestrel@workspace_hosted"] !== undefined) {
    collected.set(
      "workspace_hosted",
      structuredClone(overlays["kestrel@workspace_hosted"]),
    );
  }
  return collected;
}

function resolveCanonicalBehaviorOverlay(
  overlays: ReadonlyMap<KestrelEnvironmentPresetIdV1, KestrelOneProfileOverlay>,
): KestrelOneProfileOverlay {
  let selected: KestrelOneProfileOverlay | undefined;
  let selectedCanonical: string | undefined;
  for (const presetId of PRESET_IDS) {
    const overlay = overlays.get(presetId);
    if (overlay === undefined) continue;
    const behavior = pickBehaviorFields(overlay);
    if (Object.keys(behavior).length === 0) continue;
    const canonical = canonicalJson(behavior);
    if (selectedCanonical !== undefined && selectedCanonical !== canonical) {
      throw new Error(
        "profiles.json managed Kestrel behavior differs across environment overlays",
      );
    }
    selected = behavior;
    selectedCanonical = canonical;
  }
  return selected ?? {};
}

function pickBehaviorFields(
  overlay: KestrelOneProfileOverlay,
): KestrelOneProfileOverlay {
  return Object.fromEntries(
    BEHAVIOR_FIELDS.flatMap((field) =>
      overlay[field] === undefined ? [] : [[field, structuredClone(overlay[field])]],
    ),
  ) as KestrelOneProfileOverlay;
}

function omitBehaviorFields(
  overlay: KestrelOneProfileOverlay,
): KestrelOneProfileOverlay {
  const clone = structuredClone(overlay);
  for (const field of BEHAVIOR_FIELDS) delete clone[field];
  delete clone.theme;
  delete clone.default;
  return clone;
}

function extractManagedConfiguration(
  profile: TuiProfile,
): KestrelOneProfileOverlay {
  return {
    ...(profile.modelProvider !== undefined
      ? { modelProvider: profile.modelProvider }
      : {}),
    ...(profile.model !== undefined ? { model: profile.model } : {}),
    ...(profile.modelCredential !== undefined
      ? { modelCredential: structuredClone(profile.modelCredential) }
      : {}),
    ...(profile.modelCapabilities !== undefined
      ? { modelCapabilities: structuredClone(profile.modelCapabilities) }
      : {}),
    ...(profile.recoveryPolicy !== undefined
      ? { recoveryPolicy: structuredClone(profile.recoveryPolicy) }
      : {}),
    ...(profile.evaluationPolicy !== undefined
      ? { evaluationPolicy: structuredClone(profile.evaluationPolicy) }
      : {}),
    ...(profile.storeDriver !== undefined
      ? { storeDriver: profile.storeDriver }
      : {}),
    ...(profile.approvalPolicyPackId !== undefined
      ? { approvalPolicyPackId: profile.approvalPolicyPackId }
      : {}),
    ...(profile.kestrelOneAppApprovalModes !== undefined
      ? {
          kestrelOneAppApprovalModes: structuredClone(
            profile.kestrelOneAppApprovalModes,
          ),
        }
      : {}),
    ...(profile.toolAllowlist !== undefined
      ? { additionalToolNames: [...profile.toolAllowlist] }
      : {}),
    ...(profile.mcpServers !== undefined
      ? { mcpServers: structuredClone(profile.mcpServers) }
      : {}),
    ...(profile.ociMcpEgressBindings !== undefined
      ? {
          ociMcpEgressBindings: structuredClone(
            profile.ociMcpEgressBindings,
          ),
        }
      : {}),
    ...(profile.toolQueue !== undefined
      ? { toolQueue: structuredClone(profile.toolQueue) }
      : {}),
    ...(profile.codeMode !== undefined
      ? { codeMode: structuredClone(profile.codeMode) }
      : {}),
    ...(profile.devShell !== undefined
      ? { devShell: structuredClone(profile.devShell) }
      : {}),
    ...(profile.delegation !== undefined
      ? {
          delegationLimits: {
            maxConcurrentChildSessions:
              profile.delegation.maxConcurrentChildSessions,
            maxDepth: profile.delegation.maxDepth,
          },
        }
      : {}),
    ...(profile.reasoning !== undefined
      ? { reasoning: structuredClone(profile.reasoning) }
      : {}),
  };
}

function collectRetainedManagedFields(
  overlays: ReadonlyMap<KestrelEnvironmentPresetIdV1, KestrelOneProfileOverlay>,
): string[] {
  const fields = new Set<string>();
  for (const [presetId, overlay] of overlays) {
    for (const field of [...BEHAVIOR_FIELDS, ...ENVIRONMENT_FIELDS]) {
      if (overlay[field] !== undefined) {
        fields.add(`${presetId}.${field}`);
      }
    }
  }
  return [...fields].sort();
}

function normalizeManagedPreset(
  presetId: TuiProfile["presetId"],
): KestrelEnvironmentPresetIdV1 {
  return presetId === "cli_dev_local" ||
    presetId === "desktop_safe_local" ||
    presetId === "desktop_dev_local" ||
    presetId === "workspace_hosted"
    ? presetId
    : "cli_safe_local";
}

function isManagedProfileId(profileId: string): boolean {
  return (
    profileId === KESTREL_POLICY_ID ||
    profileId === LEGACY_KESTREL_ONE_POLICY_ID
  );
}

async function writeExactBackup(filePath: string, sourceBytes: string): Promise<void> {
  try {
    await writeFile(filePath, sourceBytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const existing = await readFile(filePath, "utf8");
  if (existing !== sourceBytes) {
    throw new Error(
      `Refusing to overwrite profiles migration backup '${filePath}' with different bytes.`,
    );
  }
}

async function writeAtomicJson(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, filePath);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(record).find((key) => allowed.has(key) === false);
  if (unknown !== undefined) {
    throw new Error(`${label} contains unsupported field '${unknown}'`);
  }
}

function digestBytes(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digestCanonical(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}
