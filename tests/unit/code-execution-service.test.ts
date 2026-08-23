import assert from "node:assert/strict";
import test from "node:test";
import { CodeExecutionService } from "../../src/code/CodeExecutionService.js";
import { DEFAULT_CODE_MODE_ENABLED_CONFIG, type SandboxExecutionInput, type SandboxExecutor } from "../../src/code/contracts.js";
import { KESTREL_EXECUTION_BOUNDARY_POLICY } from "../../src/security/ExecutionBoundaryPolicy.js";
import { fingerprintSandboxCapabilityCatalogV1, fingerprintSandboxCapabilityProfileV1, type SandboxCapabilityProfileV1 } from "../../src/kestrel/contracts/sandbox-capability.js";

const profile: SandboxCapabilityProfileV1 = { version: 1, capabilityId: "tavily.search.read", operations: ["search"], resource: "https://api.tavily.com/search", audience: { tenantId: "tenant-a", environmentId: "env-a" }, maxRequests: 1, maxQueryChars: 100, maxResults: 3, maxResponseBytes: 4096, timeoutMs: 1000, maxExpiryMs: 5000, brokerAuthority: { authorityId: "broker-a", revision: "broker-rev-1" } };

test("CodeExecutionService derives a bounded Tavily grant before sandbox creation", async () => {
  let observed: SandboxExecutionInput | undefined;
  let authorization = "";
  let providerInvoked = false;
  const executor: SandboxExecutor = { async execute(input) { observed = input; assert.equal(providerInvoked, false); await input.capability?.adapter?.(input.capability.expectedInput!); return { status: "ok", exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, artifacts: [] }; } };
  const service = new CodeExecutionService({ executor });
  const result = await service.execute({ ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [profile] }, { language: "javascript", code: "x", capability: { capabilityId: "tavily.search.read", input: { query: "kestrel", maxResults: 2 } } }, { capabilityRuntime: runtime(async (_url, input) => { providerInvoked = true; authorization = new Headers(input?.headers).get("authorization") ?? ""; return new Response(JSON.stringify({ results: [{ title: "A", url: "https://example.com/a", content: "bounded" }] }), { status: 200 }); }) });
  assert.equal(result.status, "ok");
  assert.equal(authorization, "Bearer real-secret-key");
  assert.equal(registeredSensitiveValue, "real-secret-key");
  assert.equal(observed?.capability?.destination, "api.tavily.com");
  assert.equal(JSON.stringify(observed).includes("real-secret-key"), false);
});

test("CodeExecutionService rejects stale, mismatched, and caller-authored authority before sandbox creation", async () => {
  let executions = 0;
  const service = new CodeExecutionService({ executor: { async execute() { executions += 1; throw new Error("must not execute"); } } });
  const config = { ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [profile] };
  const request = { language: "javascript" as const, code: "x", capability: { capabilityId: "tavily.search.read" as const, input: { query: "x" } } };
  await assert.rejects(service.execute(config, request, { capabilityRuntime: { ...runtime(), tenantId: "wrong" } }), /audience/u);
  await assert.rejects(service.execute(config, request, { capabilityRuntime: { ...runtime(), executionBoundaryRevision: "stale" } }), /revision is stale/u);
  await assert.rejects(service.execute({ ...config, capabilities: [{ ...profile, maxResults: 2 }] }, request, { capabilityRuntime: runtime() }), /catalog fingerprint is stale/u);
  await assert.rejects(service.execute(DEFAULT_CODE_MODE_ENABLED_CONFIG, { language: "javascript", code: "x" }, { capability: { transport: "docker-shared-loopback-v1", lease: "caller-lease", operation: "search", destination: "api.tavily.com", response: {} } }), /Caller-authored/u);
  assert.equal(executions, 0);
});

test("Tavily adapter rejects redirects and redacts credential-bearing failures", async () => {
  const service = new CodeExecutionService({ executor: { async execute(input) { await input.capability?.adapter?.(input.capability.expectedInput!); return { status: "ok", exitCode: 0, stdout: "", stderr: "", durationMs: 1, artifacts: [] }; } } });
  const config = { ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [profile] };
  const request = { language: "javascript" as const, code: "x", capability: { capabilityId: "tavily.search.read" as const, input: { query: "x" } } };
  const redirect = await service.execute(config, request, { capabilityRuntime: runtime(async () => new Response("", { status: 302, headers: { location: "https://evil.example" } })) });
  assert.match(redirect.stderr, /rejected a redirect/u);
  const redacted = await service.execute(config, request, { capabilityRuntime: runtime(async () => { throw new Error("provider rejected real-secret-key"); }) });
  assert.match(redacted.stderr, /\[redacted:credential\]/u);
  assert.equal(redacted.stderr.includes("real-secret-key"), false);
});

let registeredSensitiveValue = "";
function runtime(fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ results: [] }), { status: 200 })) {
  registeredSensitiveValue = "";
  return { tenantId: "tenant-a", environmentId: "env-a", sessionId: "session-a", runId: "run-a", toolCallId: "call-a", profileFingerprint: fingerprintSandboxCapabilityProfileV1(profile), capabilityCatalogFingerprint: fingerprintSandboxCapabilityCatalogV1([profile]), executionBoundaryRevision: KESTREL_EXECUTION_BOUNDARY_POLICY.revision, brokerAuthority: profile.brokerAuthority, credentialSnapshot: { credentialId: "tool.tavily.default" as const, revision: "credential-rev-1", secret: "real-secret-key" }, fetchImpl, registerSensitiveValue: (input: { value: string }) => { registeredSensitiveValue = input.value; }, now: () => new Date("2026-08-22T12:00:00.000Z") };
}
