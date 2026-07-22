import type { ModelToolSpec } from "../kestrel/contracts/model-io.js";
import type {
  HarnessEconomicsPolicyV1,
  ToolExposureSelectionEntryV1,
  ToolExposureSelectionV1,
} from "./contracts.js";

export interface ToolExposureCapabilityItem {
  name: string;
  toolFamily?: string | undefined;
}

export function selectToolsForEconomicsPolicyV1(input: {
  tools: ModelToolSpec[];
  capabilityManifest: ToolExposureCapabilityItem[];
  policy?: HarnessEconomicsPolicyV1 | undefined;
  phase: string;
}): { tools: ModelToolSpec[]; selection?: ToolExposureSelectionV1 | undefined } {
  if (input.policy === undefined) return { tools: input.tools };
  const phase = requireString(input.phase, "Tool exposure phase");
  const familyByName = new Map(input.capabilityManifest.map((item) => [item.name, item.toolFamily] as const));
  const allowedFamilies = input.policy.tools.allowedFamiliesByPhase[phase] ?? [];
  const entries = input.tools.map((tool): ToolExposureSelectionEntryV1 => {
    const toolFamily = familyByName.get(tool.name);
    const policyResult = decidePolicyAdmission(input.policy as HarnessEconomicsPolicyV1, toolFamily, allowedFamilies);
    return {
      name: tool.name,
      ...(toolFamily !== undefined ? { toolFamily } : {}),
      ...policyResult,
      effectiveAdmission: input.policy?.mode === "observe" ? "admitted" : policyResult.policyAdmission,
    };
  });
  const selection: ToolExposureSelectionV1 = {
    version: 1,
    policyId: input.policy.policyId,
    policyMode: input.policy.mode,
    exposure: input.policy.tools.exposure,
    phase,
    scope: "assembly_tools",
    allowedFamilies: [...allowedFamilies],
    entries,
    selectedToolNames: entries.filter((entry) => entry.effectiveAdmission === "admitted").map((entry) => entry.name),
    excludedToolNames: entries.filter((entry) => entry.effectiveAdmission === "blocked").map((entry) => entry.name),
  };
  return {
    tools: input.tools.filter((tool) => selection.selectedToolNames.includes(tool.name)),
    selection,
  };
}

export function parseToolExposureSelectionV1(value: unknown): ToolExposureSelectionV1 {
  const root = requireRecord(value, "Tool exposure selection");
  rejectUnknown(root, new Set([
    "version", "policyId", "policyMode", "exposure", "phase", "scope", "allowedFamilies", "entries",
    "selectedToolNames", "excludedToolNames",
  ]), "Tool exposure selection");
  if (root.version !== 1) throw new Error("Tool exposure selection version must be 1.");
  const policyId = requireString(root.policyId, "Tool exposure selection policyId");
  const phase = requireString(root.phase, "Tool exposure selection phase");
  if (root.policyMode !== "observe" && root.policyMode !== "enforce") {
    throw new Error("Tool exposure selection policyMode is invalid.");
  }
  if (root.exposure !== "assembly_allowlist" && root.exposure !== "phase_scoped") {
    throw new Error("Tool exposure selection exposure is invalid.");
  }
  if (root.scope !== "assembly_tools") throw new Error("Tool exposure selection scope is invalid.");
  const allowedFamilies = requireUniqueStringArray(root.allowedFamilies, "Tool exposure selection allowedFamilies");
  if (Array.isArray(root.entries) === false) throw new Error("Tool exposure selection entries must be an array.");
  const entryNames = new Set<string>();
  const entries = root.entries.map((value, index): ToolExposureSelectionEntryV1 => {
    const entry = requireRecord(value, `Tool exposure selection entries[${index}]`);
    rejectUnknown(entry, new Set(["name", "toolFamily", "policyAdmission", "effectiveAdmission", "reason"]), `Tool exposure selection entries[${index}]`);
    const name = requireString(entry.name, `Tool exposure selection entries[${index}].name`);
    if (entryNames.has(name)) throw new Error(`Tool exposure selection contains duplicate tool '${name}'.`);
    entryNames.add(name);
    const policyAdmission = requireAdmission(entry.policyAdmission, `Tool exposure selection entries[${index}].policyAdmission`);
    const effectiveAdmission = requireAdmission(entry.effectiveAdmission, `Tool exposure selection entries[${index}].effectiveAdmission`);
    const reason = entry.reason;
    if (reason !== "assembly_allowlisted" && reason !== "family_allowed" && reason !== "family_not_allowed" && reason !== "tool_family_missing") {
      throw new Error(`Tool exposure selection entries[${index}].reason is invalid.`);
    }
    const toolFamily = entry.toolFamily === undefined
      ? undefined
      : requireString(entry.toolFamily, `Tool exposure selection entries[${index}].toolFamily`);
    assertEntrySemantics({ policyMode: root.policyMode, exposure: root.exposure, allowedFamilies, policyAdmission, effectiveAdmission, reason, toolFamily });
    return { name, ...(toolFamily !== undefined ? { toolFamily } : {}), policyAdmission, effectiveAdmission, reason };
  });
  const selectedToolNames = requireUniqueStringArray(root.selectedToolNames, "Tool exposure selection selectedToolNames");
  const excludedToolNames = requireUniqueStringArray(root.excludedToolNames, "Tool exposure selection excludedToolNames");
  const expectedSelected = entries.filter((entry) => entry.effectiveAdmission === "admitted").map((entry) => entry.name);
  const expectedExcluded = entries.filter((entry) => entry.effectiveAdmission === "blocked").map((entry) => entry.name);
  if (arraysEqual(selectedToolNames, expectedSelected) === false || arraysEqual(excludedToolNames, expectedExcluded) === false) {
    throw new Error("Tool exposure selection name lists do not match entry admissions.");
  }
  return {
    version: 1,
    policyId,
    policyMode: root.policyMode,
    exposure: root.exposure,
    phase,
    scope: "assembly_tools",
    allowedFamilies,
    entries,
    selectedToolNames,
    excludedToolNames,
  };
}

function decidePolicyAdmission(
  policy: HarnessEconomicsPolicyV1,
  toolFamily: string | undefined,
  allowedFamilies: string[],
): Pick<ToolExposureSelectionEntryV1, "policyAdmission" | "reason"> {
  if (policy.tools.exposure === "assembly_allowlist") {
    return { policyAdmission: "admitted", reason: "assembly_allowlisted" };
  }
  if (toolFamily === undefined) return { policyAdmission: "blocked", reason: "tool_family_missing" };
  return allowedFamilies.includes(toolFamily)
    ? { policyAdmission: "admitted", reason: "family_allowed" }
    : { policyAdmission: "blocked", reason: "family_not_allowed" };
}

function assertEntrySemantics(input: {
  policyMode: unknown;
  exposure: unknown;
  allowedFamilies: string[];
  policyAdmission: "admitted" | "blocked";
  effectiveAdmission: "admitted" | "blocked";
  reason: ToolExposureSelectionEntryV1["reason"];
  toolFamily: string | undefined;
}): void {
  if (input.policyMode === "observe" && input.effectiveAdmission !== "admitted") {
    throw new Error("Tool exposure observation mode cannot remove a tool.");
  }
  if (input.policyMode === "enforce" && input.effectiveAdmission !== input.policyAdmission) {
    throw new Error("Tool exposure enforcement must apply the policy admission.");
  }
  if (input.exposure === "assembly_allowlist") {
    if (input.policyAdmission !== "admitted" || input.reason !== "assembly_allowlisted") {
      throw new Error("Assembly allowlist exposure must admit assembly-selected tools.");
    }
    return;
  }
  const expected = input.toolFamily === undefined
    ? { admission: "blocked", reason: "tool_family_missing" }
    : input.allowedFamilies.includes(input.toolFamily)
      ? { admission: "admitted", reason: "family_allowed" }
      : { admission: "blocked", reason: "family_not_allowed" };
  if (input.policyAdmission !== expected.admission || input.reason !== expected.reason) {
    throw new Error("Phase-scoped tool exposure entry does not match its exact tool family policy.");
  }
}

function requireAdmission(value: unknown, label: string): "admitted" | "blocked" {
  if (value !== "admitted" && value !== "blocked") throw new Error(`${label} is invalid.`);
  return value;
}

function requireUniqueStringArray(value: unknown, label: string): string[] {
  if (Array.isArray(value) === false) throw new Error(`${label} must be an array.`);
  const parsed = value.map((entry) => requireString(entry, `${label} item`));
  if (new Set(parsed).size !== parsed.length) throw new Error(`${label} must not contain duplicates.`);
  return parsed;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).find((field) => allowed.has(field) === false);
  if (unknown !== undefined) throw new Error(`${label} contains unknown field '${unknown}'.`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
