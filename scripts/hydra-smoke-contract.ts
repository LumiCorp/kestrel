import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const HYDRA_SMOKE_VERSION = "hydra_smoke_evidence_v1" as const;
export const HYDRA_RUNTIME_IDS = ["codex", "claude"] as const;
export type HydraRuntimeId = (typeof HYDRA_RUNTIME_IDS)[number];

export interface HydraScenarioEvidence {
  id: string;
  status: "passed" | "failed";
  durationMs: number;
  failureCode?: string | undefined;
}

export interface HydraRuntimeEvidence {
  runtimeId: HydraRuntimeId;
  nativeVersion?: string | undefined;
  modelId: string;
  authenticationSource?: "native-login" | "profile-credential" | undefined;
  scenarios: HydraScenarioEvidence[];
}

export interface HydraSmokeEvidenceV1 {
  version: typeof HYDRA_SMOKE_VERSION;
  sourceSha: string;
  startedAt: string;
  completedAt: string;
  status: "passed" | "failed";
  local: {
    status: "passed" | "failed";
    runtimes: HydraRuntimeEvidence[];
  };
  candidate: {
    status: "passed" | "failed";
    origin: string;
    deploymentRevision: string;
    runtimes: HydraRuntimeEvidence[];
  };
}

const SHA = /^[a-f0-9]{40}$/u;
const FORBIDDEN_KEYS = /(?:credential|fingerprint|nativeSession|config(?:uration)?Path|storageState|cookie|token|secret|apiKey)/iu;

export function validateHydraSmokeEvidence(
  value: unknown,
  options: { requirePassed?: boolean | undefined } = {},
): asserts value is HydraSmokeEvidenceV1 {
  assertRecord(value, "Hydra smoke evidence");
  assert.equal(value.version, HYDRA_SMOKE_VERSION);
  assert.match(requireText(value.sourceSha, "sourceSha"), SHA);
  assertTimestamp(value.startedAt, "startedAt");
  assertTimestamp(value.completedAt, "completedAt");
  assertStatus(value.status, "status");
  assertRecord(value.local, "local");
  assertRecord(value.candidate, "candidate");
  validateSection(value.local, "local", true);
  validateSection(value.candidate, "candidate", false);
  assertNoForbiddenKeys(value);
  if (options.requirePassed === true) {
    assert.equal(value.status, "passed", "Hydra smoke must pass");
    assert.equal(value.local.status, "passed", "Hydra local smoke must pass");
    assert.equal(
      value.candidate.status,
      "passed",
      "Hydra candidate smoke must pass",
    );
  }
}

export async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function validateSection(value: unknown, label: string, local: boolean): void {
  assertRecord(value, label);
  assertStatus(value.status, `${label}.status`);
  if (!local) {
    requireText(value.origin, `${label}.origin`);
    assert.match(
      requireText(value.deploymentRevision, `${label}.deploymentRevision`),
      SHA,
    );
  }
  assert.ok(Array.isArray(value.runtimes), `${label}.runtimes must be an array`);
  assert.deepEqual(
    value.runtimes.map((item) => {
      assertRecord(item, `${label}.runtime`);
      return item.runtimeId;
    }).sort(),
    [...HYDRA_RUNTIME_IDS].sort(),
    `${label} must contain exactly Codex and Claude`,
  );
  for (const runtime of value.runtimes) {
    assertRecord(runtime, `${label}.runtime`);
    requireText(runtime.modelId, `${label}.runtime.modelId`);
    if (local) {
      requireText(runtime.nativeVersion, `${label}.runtime.nativeVersion`);
      assert.ok(
        runtime.authenticationSource === "native-login" ||
          runtime.authenticationSource === "profile-credential",
        `${label}.runtime.authenticationSource is invalid`,
      );
    }
    assert.ok(
      Array.isArray(runtime.scenarios) && runtime.scenarios.length > 0,
      `${label}.runtime.scenarios must not be empty`,
    );
    const ids = new Set<string>();
    for (const scenario of runtime.scenarios) {
      assertRecord(scenario, `${label}.scenario`);
      const id = requireText(scenario.id, `${label}.scenario.id`);
      assert.equal(ids.has(id), false, `${label} scenario '${id}' is duplicated`);
      ids.add(id);
      assertStatus(scenario.status, `${label}.scenario.status`);
      assert.ok(
        typeof scenario.durationMs === "number" &&
          Number.isFinite(scenario.durationMs) &&
          scenario.durationMs >= 0,
        `${label}.scenario.durationMs is invalid`,
      );
      if (scenario.failureCode !== undefined) {
        assert.match(String(scenario.failureCode), /^[A-Z0-9_]{1,80}$/u);
      }
      if (value.status === "passed") {
        assert.equal(scenario.status, "passed");
      }
    }
  }
}

function assertNoForbiddenKeys(value: unknown, path = "evidence"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(FORBIDDEN_KEYS.test(key), false, `${path}.${key} is prohibited`);
    assertNoForbiddenKeys(child, `${path}.${key}`);
  }
}

function assertRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), `${label} must be an object`);
}

function requireText(value: unknown, label: string): string {
  assert.ok(typeof value === "string" && value.trim().length > 0, `${label} is required`);
  return value;
}

function assertTimestamp(value: unknown, label: string): void {
  assert.equal(Number.isNaN(Date.parse(requireText(value, label))), false, `${label} is invalid`);
}

function assertStatus(value: unknown, label: string): void {
  assert.ok(value === "passed" || value === "failed", `${label} is invalid`);
}
