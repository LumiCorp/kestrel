import assert from "node:assert/strict";
import test from "node:test";

import { parseJobInput, parseJobInputV1 } from "../../cli/job/contracts.js";
import {
  buildExecutionPolicyFromPack,
  getApprovalPolicyPack,
} from "../../cli/runtime/approvalPolicyPacks.js";
import { composeKestrelOneProfile } from "../../src/profile/kestrelOnePolicy.js";
import { codeExecuteDefinitionForProfile } from "../../tools/code/execute.js";
import { mergeCodeModeConfig } from "../../src/code/PolicyEngine.js";
import { DEFAULT_CODE_MODE_ENABLED_CONFIG } from "../../src/code/contracts.js";

test("safe and developer presets resolve to satisfiable, distinct execution policies", () => {
  for (const preset of ["cli_safe_local", "desktop_safe_local"] as const) {
    const profile = composeKestrelOneProfile({ environmentPresetId: preset }).profile;
    assert.equal(profile.approvalPolicyPackId, "isolated_code");
    assert.ok(profile.toolAllowlist?.includes("code.execute"));
    assert.ok(!profile.toolAllowlist?.includes("exec_command"));
    const policy = buildExecutionPolicyFromPack(profile.approvalPolicyPackId);
    assert.equal(policy.capabilityPolicy?.["code.execute"], true);
    assert.equal(policy.capabilityPolicy?.["shell.exec"], false);
  }

  const developer = composeKestrelOneProfile({ environmentPresetId: "cli_dev_local" }).profile;
  assert.equal(developer.approvalPolicyPackId, "dev");
  assert.ok(developer.toolAllowlist?.includes("exec_command"));
  assert.equal(getApprovalPolicyPack("dev").allowedCapabilities.includes("code.execute"), false);
});

test("explicitly unsatisfiable preset and policy combinations fail during composition", () => {
  assert.throws(
    () => composeKestrelOneProfile({
      environmentPresetId: "cli_safe_local",
      overlay: { approvalPolicyPackId: "dev" },
    }),
    /does not authorize advertised tool 'code\.execute'/u,
  );
  assert.throws(
    () => composeKestrelOneProfile({
      environmentPresetId: "cli_dev_local",
      overlay: { approvalPolicyPackId: "isolated_code" },
    }),
    /does not authorize advertised tool 'exec_command'/u,
  );
});

test("job input V2 requires an exact preset while V1 remains compatible", () => {
  const turn = { sessionId: "session-a", message: "implement" };
  assert.equal(parseJobInputV1({ version: "job_input_v1", turn }).version, "job_input_v1");
  const v2 = parseJobInput({
    version: "job_input_v2",
    profileId: "profile-a",
    environmentPresetId: "cli_dev_local",
    approvalPolicyPackId: "dev",
    requiredTools: ["exec_command"],
    turn,
  });
  assert.equal(v2.version, "job_input_v2");
  assert.equal(v2.environmentPresetId, "cli_dev_local");
  assert.throws(
    () => parseJobInput({
      version: "job_input_v2",
      profileId: "profile-a",
      approvalPolicyPackId: "dev",
      requiredTools: ["exec_command"],
      turn,
    }),
    /environmentPresetId/u,
  );
  assert.throws(
    () => parseJobInput({
      version: "job_input_v2",
      profileId: "profile-a",
      environmentPresetId: "cli_dev_local",
      approvalPolicyPackId: "dev",
      requiredTools: ["exec_command"],
      turn,
      surprise: true,
    }),
    /unknown field\(s\): surprise/u,
  );
  assert.throws(
    () => parseJobInput({
      version: "job_input_v2",
      profileId: "profile-a",
      environmentPresetId: "web_balanced",
      approvalPolicyPackId: "dev",
      requiredTools: ["exec_command"],
      turn,
    }),
    /cli_safe_local\|cli_dev_local/u,
  );
});

test("code.execute advertises only exact V2 adapter selections and keeps omission valid", () => {
  const definition = codeExecuteDefinitionForProfile(mergeCodeModeConfig({
    ...DEFAULT_CODE_MODE_ENABLED_CONFIG,
    capabilities: [{
      version: 1,
      capabilityId: "tavily.search.read",
      operations: ["search"],
      resource: "https://api.tavily.com/search",
      audience: { tenantId: "tenant-a", environmentId: "env-a" },
      maxRequests: 1,
      maxQueryChars: 400,
      maxResults: 5,
      maxResponseBytes: 20_000,
      timeoutMs: 5_000,
      maxExpiryMs: 10_000,
      brokerAuthority: { authorityId: "broker-a", revision: "r1" },
    }],
  }));
  const schema = definition.inputSchema as {
    required: string[];
    properties: Record<string, { oneOf?: Array<Record<string, unknown>> }>;
  };
  assert.deepEqual(schema.required, ["language", "code"]);
  assert.equal(schema.properties.capability?.oneOf?.length, 1);
  assert.match(definition.description, /no direct network access/u);
  assert.match(JSON.stringify(schema.properties.capability), /"version":\{"const":2\}/u);
  assert.match(JSON.stringify(schema.properties.capability), /"operation":\{"const":"search"\}/u);

  const capabilityFree = codeExecuteDefinitionForProfile(mergeCodeModeConfig(undefined));
  assert.equal("capability" in (capabilityFree.inputSchema.properties as Record<string, unknown>), false);
});
