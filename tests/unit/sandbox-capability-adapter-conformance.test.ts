import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_SANDBOX_CAPABILITY_ADAPTER_REGISTRY } from "../../src/code/CodeExecutionService.js";
import { SandboxCapabilityAdapterRegistry, type SandboxCapabilityAdapter } from "../../src/code/SandboxCapabilityAdapterRegistry.js";
import { SandboxCapabilityAdapterFailure } from "../../src/code/adapters/TavilySearchReadAdapter.js";

interface AdapterQualificationCase {
  profile: unknown;
  selection: unknown;
  invalidCeilingSelection: unknown;
  canonicalInput: unknown;
  providerResponse: unknown;
  oversizedProviderResponse: unknown;
  expectedOutput: unknown;
  destination: string;
}

const qualificationCases: Record<string, AdapterQualificationCase> = {
  "tavily.search.read": {
    profile: {
      version: 1,
      capabilityId: "tavily.search.read",
      operations: ["search"],
      resource: "https://api.tavily.com/search",
      audience: { tenantId: "tenant-a", environmentId: "env-a" },
      maxRequests: 1,
      maxQueryChars: 100,
      maxResults: 3,
      maxResponseBytes: 4096,
      timeoutMs: 1000,
      maxExpiryMs: 5000,
      brokerAuthority: { authorityId: "broker-a", revision: "broker-r1" },
    },
    selection: { capabilityId: "tavily.search.read", input: { query: "kestrel", maxResults: 2 } },
    invalidCeilingSelection: { capabilityId: "tavily.search.read", input: { query: "x".repeat(101), maxResults: 2 } },
    canonicalInput: { query: "kestrel", maxResults: 2 },
    providerResponse: { results: [{ title: "A", url: "https://example.com/a", content: "bounded" }] },
    oversizedProviderResponse: { results: [{ title: "x", url: "https://example.com", content: "x".repeat(200) }] },
    expectedOutput: { version: 1, results: [{ title: "A", url: "https://example.com/a", content: "bounded" }] },
    destination: "api.tavily.com",
  },
};

for (const adapter of DEFAULT_SANDBOX_CAPABILITY_ADAPTER_REGISTRY.list()) {
  test(`registered sandbox adapter '${adapter.capabilityId}' passes the shared conformance contract`, async () => {
    const qualification = qualificationCases[adapter.capabilityId];
    assert.ok(qualification, `registered adapter '${adapter.capabilityId}' must provide a conformance case`);
    assert.equal(DEFAULT_SANDBOX_CAPABILITY_ADAPTER_REGISTRY.requireExact({
      capabilityId: adapter.capabilityId,
      operation: adapter.operation,
      resource: adapter.resource,
    }), adapter);
    assert.ok(adapter.effectClass === "read_only" || adapter.effectClass === "external_effect");
    const parsedProfile = adapter.parseProfile(qualification.profile);
    const selection = adapter.parseSelection(qualification.selection);
    const canonicalInput = adapter.canonicalInput(parsedProfile, selection);
    assert.deepEqual(canonicalInput, qualification.canonicalInput);
    assert.equal(adapter.destination(parsedProfile), qualification.destination);

    let redirectMode: string | undefined;
    const output = await adapter.invoke(canonicalInput, {
      fetchImpl: async (_url, init) => {
        redirectMode = init?.redirect;
        return new Response(JSON.stringify(qualification.providerResponse), { status: 200 });
      },
      credential: "conformance-secret",
      timeoutMs: 1000,
      expiryMs: 1000,
      maxResponseBytes: 4096,
      signal: new AbortController().signal,
    });
    assert.equal(redirectMode, "manual");
    assert.deepEqual(output, qualification.expectedOutput);

    assert.throws(
      () => adapter.canonicalInput(parsedProfile, adapter.parseSelection(qualification.invalidCeilingSelection)),
      (error) => error instanceof SandboxCapabilityAdapterFailure && error.code === "CAPABILITY_REQUEST_CEILING_EXCEEDED",
    );

    const providerSecret = "provider-secret-that-must-not-escape";
    await assert.rejects(adapter.invoke(canonicalInput, {
      fetchImpl: async () => { throw new Error(`provider reflected ${providerSecret}`); },
      credential: providerSecret, timeoutMs: 1000, expiryMs: 1000, maxResponseBytes: 4096,
      signal: new AbortController().signal,
    }), (error) => error instanceof SandboxCapabilityAdapterFailure && error.code === "CAPABILITY_PROVIDER_FAILED" && error.message === "Sandbox capability provider request failed" && !JSON.stringify(error).includes(providerSecret));

    const keepEventLoopAlive = setTimeout(() => {}, 25);
    await assert.rejects(adapter.invoke(canonicalInput, {
      fetchImpl: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
      credential: "conformance-secret", timeoutMs: 1000, expiryMs: 10, maxResponseBytes: 4096,
      signal: new AbortController().signal,
    }), (error) => error instanceof SandboxCapabilityAdapterFailure && error.code === "CAPABILITY_DEADLINE_EXCEEDED" && error.message === "Sandbox capability adapter deadline expired");
    clearTimeout(keepEventLoopAlive);

    const cancellationController = new AbortController();
    const cancellation = adapter.invoke(canonicalInput, {
      fetchImpl: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
      credential: "conformance-secret", timeoutMs: 1000, expiryMs: 1000, maxResponseBytes: 4096,
      signal: cancellationController.signal,
    });
    cancellationController.abort();
    await assert.rejects(cancellation, (error) => error instanceof SandboxCapabilityAdapterFailure && error.code === "CAPABILITY_CANCELLED" && error.message === "Sandbox capability adapter invocation was cancelled");

    await assert.rejects(adapter.invoke(canonicalInput, {
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example" } }),
      credential: "conformance-secret", timeoutMs: 1000, expiryMs: 1000, maxResponseBytes: 4096,
      signal: new AbortController().signal,
    }), (error) => error instanceof SandboxCapabilityAdapterFailure && error.code === "CAPABILITY_REDIRECT_REJECTED" && !error.message.includes("conformance-secret"));

    await assert.rejects(adapter.invoke(canonicalInput, {
      fetchImpl: async () => new Response(JSON.stringify(qualification.oversizedProviderResponse), { status: 200 }),
      credential: "conformance-secret", timeoutMs: 1000, expiryMs: 1000, maxResponseBytes: 32,
      signal: new AbortController().signal,
    }), (error) => error instanceof SandboxCapabilityAdapterFailure && error.code === "CAPABILITY_RESPONSE_CEILING_EXCEEDED" && !error.message.includes("conformance-secret"));
  });
}

test("sandbox adapter registry rejects duplicates, unknown IDs, operations, resources, and unsafe declarations", () => {
  const adapter = DEFAULT_SANDBOX_CAPABILITY_ADAPTER_REGISTRY.list()[0]!;
  assert.throws(() => new SandboxCapabilityAdapterRegistry([adapter, adapter]), /Duplicate sandbox capability adapter/u);
  assert.throws(() => DEFAULT_SANDBOX_CAPABILITY_ADAPTER_REGISTRY.requireExact({ capabilityId: "unknown.read" }), /Unknown sandbox capability adapter/u);
  assert.throws(() => DEFAULT_SANDBOX_CAPABILITY_ADAPTER_REGISTRY.requireExact({ capabilityId: adapter.capabilityId, operation: "write" }), /operation/u);
  assert.throws(() => DEFAULT_SANDBOX_CAPABILITY_ADAPTER_REGISTRY.requireExact({ capabilityId: adapter.capabilityId, resource: "https://evil.example" }), /resource/u);
  assert.throws(() => new SandboxCapabilityAdapterRegistry([{ ...adapter, capabilityId: "unsafe", resource: "http://example.com" } as SandboxCapabilityAdapter]), /credential-free HTTPS/u);
  assert.throws(() => new SandboxCapabilityAdapterRegistry([{ ...adapter, capabilityId: "unknown-class", effectClass: "unknown" } as unknown as SandboxCapabilityAdapter]), /effect class is invalid/u);
});
