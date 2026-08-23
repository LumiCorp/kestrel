import assert from "node:assert/strict";
import test from "node:test";
import { CodeExecutionService } from "../../src/code/CodeExecutionService.js";
import { SandboxCapabilityLeaseCoordinator, digestSandboxCapabilityResult } from "../../src/code/SandboxCapabilityLeaseCoordinator.js";
import { DEFAULT_CODE_MODE_ENABLED_CONFIG, type SandboxExecutionInput, type SandboxExecutor } from "../../src/code/contracts.js";
import { KESTREL_EXECUTION_BOUNDARY_POLICY, SensitiveValueRegistry } from "../../src/security/ExecutionBoundaryPolicy.js";
import { fingerprintSandboxCapabilityCatalogV1, fingerprintSandboxCapabilityProfileV1, type SandboxCapabilityChildReservationV1, type SandboxCapabilityLeaseTransitionRecordV1, type SandboxCapabilityProfileV1 } from "../../src/kestrel/contracts/sandbox-capability.js";
import type { SandboxCapabilityLeaseStore } from "../../src/kestrel/contracts/store.js";

const profile: SandboxCapabilityProfileV1 = { version: 1, capabilityId: "tavily.search.read", operations: ["search"], resource: "https://api.tavily.com/search", audience: { tenantId: "tenant-a", environmentId: "env-a" }, maxRequests: 1, maxQueryChars: 100, maxResults: 3, maxResponseBytes: 4096, timeoutMs: 1000, maxExpiryMs: 5000, brokerAuthority: { authorityId: "broker-a", revision: "broker-rev-1" } };

test("CodeExecutionService derives a bounded Tavily grant before sandbox creation", async () => {
  let observed: SandboxExecutionInput | undefined;
  let authorization = "";
  let providerInvoked = false;
  const executor: SandboxExecutor = { async execute(input) { observed = input; assert.equal(providerInvoked, false); await input.capability?.adapter?.(input.capability.expectedInput!, new AbortController().signal); return { status: "ok", exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, artifacts: [] }; } };
  const service = new CodeExecutionService({ executor });
  const result = await service.execute({ ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [profile] }, { language: "javascript", code: "x", capability: { capabilityId: "tavily.search.read", input: { query: "kestrel", maxResults: 2 } } }, { capabilityRuntime: runtime(async (_url, input) => { providerInvoked = true; authorization = new Headers(input?.headers).get("authorization") ?? ""; return new Response(JSON.stringify({ results: [{ title: "A", url: "https://example.com/a", content: "bounded" }] }), { status: 200 }); }) });
  assert.equal(result.status, "ok");
  assert.equal(authorization, "Bearer real-secret-key");
  assert.equal(registeredSensitiveValue, "real-secret-key");
  assert.equal(observed?.capability?.destination, "api.tavily.com");
  assert.equal(JSON.stringify(observed).includes("real-secret-key"), false);
});

test("CodeExecutionService applies the atomic invocation byte allowance before provider response delivery", async () => {
  const capabilityRuntime = runtime(async () => new Response(JSON.stringify({ results: [{ title: "large", url: "https://example.com", content: "x".repeat(100) }] }), { status: 200 }));
  const coordinator = capabilityRuntime.leaseCoordinator;
  const reserve = coordinator.reserveInvocation.bind(coordinator);
  coordinator.reserveInvocation = async (...args) => ({ ...await reserve(...args), invocationResponseByteLimit: 16 });
  const service = new CodeExecutionService({ executor: {
    async execute(input) {
      const reservation = await input.capability!.lifecycle!.beforeProviderInvocation();
      assert.equal(reservation?.responseByteLimit, 16);
      await input.capability!.adapter!(input.capability!.expectedInput!, new AbortController().signal);
      throw new Error("provider response should not cross the reserved byte ceiling");
    },
  } });
  const result = await service.execute(
    { ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [profile] },
    { language: "javascript", code: "x", capability: { capabilityId: "tavily.search.read", input: { query: "bounded" } } },
    { capabilityRuntime },
  );
  assert.equal(result.status, "error");
  assert.match(result.stderr, /profile ceiling/u);
});

test("CodeExecutionService rejects stale, mismatched, and caller-authored authority before sandbox creation", async () => {
  let executions = 0;
  let credentialResolutions = 0;
  const service = new CodeExecutionService({ executor: { async execute() { executions += 1; throw new Error("must not execute"); } } });
  const config = { ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [profile] };
  const request = { language: "javascript" as const, code: "x", capability: { capabilityId: "tavily.search.read" as const, input: { query: "x" } } };
  await assert.rejects(service.execute(config, request, { capabilityRuntime: { ...runtime(), tenantId: "wrong" } }), /audience/u);
  await assert.rejects(service.execute(config, request, { capabilityRuntime: {
    ...runtime(),
    brokerAuthority: { authorityId: "forged-broker", revision: "broker-rev-1" },
    credentialSnapshot: undefined,
    resolveCredentialSnapshot: async () => {
      credentialResolutions += 1;
      return { credentialId: "tool.tavily.default", revision: "r", secret: "secret" };
    },
  } }), /broker authority/u);
  await assert.rejects(service.execute(config, request, { capabilityRuntime: {
    ...runtime(),
    brokerAuthority: { authorityId: "broker-a", revision: "forged-revision" },
    credentialSnapshot: undefined,
    resolveCredentialSnapshot: async () => {
      credentialResolutions += 1;
      return { credentialId: "tool.tavily.default", revision: "r", secret: "secret" };
    },
  } }), /broker authority/u);
  await assert.rejects(service.execute(config, request, { capabilityRuntime: { ...runtime(), executionBoundaryRevision: "stale" } }), /revision is stale/u);
  await assert.rejects(service.execute({ ...config, capabilities: [{ ...profile, maxResults: 2 }] }, request, { capabilityRuntime: runtime() }), /catalog fingerprint is stale/u);
  await assert.rejects(service.execute(DEFAULT_CODE_MODE_ENABLED_CONFIG, { language: "javascript", code: "x" }, { capability: { transport: "docker-shared-loopback-v1", lease: "caller-lease", operation: "search", destination: "api.tavily.com", response: {} } }), /Caller-authored/u);
  assert.equal(executions, 0);
  assert.equal(credentialResolutions, 0);
});

test("CodeExecutionService rejects partial sensitive-value callback configuration before credential resolution", async () => {
  let credentialResolutions = 0;
  let executions = 0;
  const service = new CodeExecutionService({ executor: { async execute() { executions += 1; throw new Error("must not execute"); } } });
  const config = { ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [profile] };
  const request = { language: "javascript" as const, code: "x", capability: { capabilityId: "tavily.search.read" as const, input: { query: "x" } } };
  const { credentialSnapshot: _credentialSnapshot, ...runtimeWithoutCredential } = runtime();
  const base = {
    ...runtimeWithoutCredential,
    resolveCredentialSnapshot: async () => {
    credentialResolutions += 1;
    return { credentialId: "tool.tavily.default" as const, revision: "credential-rev-1", secret: "real-secret-key" };
    },
  };

  for (const callbacks of [
    { registerSensitiveValue: base.registerSensitiveValue, redactSensitiveValues: undefined },
    { registerSensitiveValue: undefined, redactSensitiveValues: base.redactSensitiveValues },
    { registerSensitiveValue: undefined, redactSensitiveValues: undefined },
  ]) {
    await assert.rejects(
      service.execute(config, request, { capabilityRuntime: { ...base, ...callbacks } }),
      /registration and redaction are required together/u,
    );
  }
  assert.equal(credentialResolutions, 0);
  assert.equal(executions, 0);
});

test("CodeExecutionService fails closed when durable lease coordination is unavailable", async () => {
  let executions = 0;
  let credentialResolutions = 0;
  const service = new CodeExecutionService({ executor: { async execute() { executions += 1; throw new Error("must not execute"); } } });
  const { leaseCoordinator: _leaseCoordinator, credentialSnapshot: _credentialSnapshot, ...withoutCoordinator } = runtime();
  await assert.rejects(
    service.execute(
      { ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [profile] },
      { language: "javascript", code: "x", capability: { capabilityId: "tavily.search.read", input: { query: "x" } } },
      { capabilityRuntime: {
        ...withoutCoordinator,
        resolveCredentialSnapshot: async () => {
          credentialResolutions += 1;
          return { credentialId: "tool.tavily.default", revision: "r", secret: "secret" };
        },
      } },
    ),
    /durable sandbox capability lease coordination is unavailable/iu,
  );
  assert.equal(credentialResolutions, 0);
  assert.equal(executions, 0);
});

test("CodeExecutionService rejects sensitive-value registration without a cleanup disposer", async () => {
  let executions = 0;
  const service = new CodeExecutionService({ executor: { async execute() { executions += 1; throw new Error("must not execute"); } } });
  const config = { ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [profile] };
  const request = { language: "javascript" as const, code: "x", capability: { capabilityId: "tavily.search.read" as const, input: { query: "x" } } };
  const capabilityRuntime = {
    ...runtime(),
    registerSensitiveValue: (() => undefined) as unknown as () => () => void,
  };

  await assert.rejects(
    service.execute(config, request, { capabilityRuntime }),
    (error) => {
      assert.match((error as Error).message, /registration must provide cleanup/u);
      assert.equal((error as Error).message.includes("real-secret-key"), false);
      return true;
    },
  );
  assert.equal(executions, 0);
});

test("durable teardown failure still disposes capability authority before container removal", async () => {
  const order: string[] = [];
  const failingCoordinator = {
    async request(input: { binding: SandboxCapabilityLeaseTransitionRecordV1["binding"]; expiresAt: string; requestLimit: number; responseByteLimit: number }) {
      return {
        version: 1 as const,
        leaseId: "lease-disposal-order",
        sequence: 2,
        transition: "issued" as const,
        binding: input.binding,
        bindingDigest: fingerprintSandboxCapabilityProfileV1(profile),
        usage: { requestLimit: input.requestLimit, requestsConsumed: 0, responseByteLimit: input.responseByteLimit, responseBytesConsumed: 0, exactProviderUsage: null },
        issuedAt: "2026-08-22T12:00:00.000Z",
        expiresAt: input.expiresAt,
        occurredAt: "2026-08-22T12:00:00.000Z",
      };
    },
    async settleBeforeTeardown() {
      order.push("durable_transition_failed");
      throw new Error("lease store unavailable");
    },
  } as unknown as SandboxCapabilityLeaseCoordinator;
  const service = new CodeExecutionService({
    executor: {
      async execute(input) {
        try {
          await input.capability!.lifecycle!.beforeContainerTeardown("cancelled");
        } catch {
          order.push("containers_removed");
          throw new Error("teardown failed");
        }
        throw new Error("expected lifecycle failure");
      },
    },
  });
  const result = await service.execute(
    { ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [profile] },
    { language: "javascript", code: "x", capability: { capabilityId: "tavily.search.read", input: { query: "x" } } },
    {
      capabilityRuntime: {
        ...runtime(),
        leaseCoordinator: failingCoordinator,
        registerSensitiveValue: () => () => { order.push("secret_disposed"); },
      },
    },
  );
  assert.equal(result.status, "error");
  assert.deepEqual(order, ["durable_transition_failed", "secret_disposed", "containers_removed"]);
});

test("exact capability result becomes durable before lease cleanup and container removal", async () => {
  const order: string[] = [];
  const capabilityRuntime = runtime();
  const coordinator = capabilityRuntime.leaseCoordinator;
  const settleBeforeTeardown = coordinator.settleBeforeTeardown.bind(coordinator);
  coordinator.settleBeforeTeardown = async (...args) => {
    order.push("lease_cleanup");
    return settleBeforeTeardown(...args);
  };
  const completedOutput = { status: "ok" as const, exitCode: 0, stdout: "completed", stderr: "", durationMs: 1, artifacts: [] };
  const service = new CodeExecutionService({
    executor: {
      async execute(input) {
        await input.capability!.lifecycle!.beforeContainerTeardown("completed", completedOutput);
        order.push("containers_removed");
        return completedOutput;
      },
    },
  });
  const result = await service.execute(
    { ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [profile] },
    { language: "javascript", code: "console.log('completed')", capability: { capabilityId: "tavily.search.read", input: { query: "unused" } } },
    {
      capabilityRuntime,
      persistCompletedCapabilityResult: async (exactResult) => {
        order.push("exact_result_durable");
        assert.equal(exactResult.status, "ok");
        assert.equal(exactResult.stdout, "completed");
        assert.equal(exactResult.capabilityReplayEvidence?.toolCallId, capabilityRuntime.toolCallId);
      },
    },
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(order, ["exact_result_durable", "lease_cleanup", "containers_removed"]);
});

for (const providerUsed of [false, true]) {
  test(`late cancellation suppresses the ${providerUsed ? "provider-used" : "unused"} exact capability result`, async () => {
    const controller = new AbortController();
    const capabilityRuntime = runtime();
    const transitions: string[] = [];
    const coordinator = capabilityRuntime.leaseCoordinator;
    const settleBeforeTeardown = coordinator.settleBeforeTeardown.bind(coordinator);
    coordinator.settleBeforeTeardown = async (...args) => {
      const settled = await settleBeforeTeardown(...args);
      transitions.push(settled.terminalOutcome ?? "missing", settled.transition);
      return settled;
    };
    let exactSaves = 0;
    const completedOutput = { status: "ok" as const, exitCode: 0, stdout: "late output", stderr: "", durationMs: 1, artifacts: [] };
    const service = new CodeExecutionService({
      executor: {
        async execute(input) {
          if (providerUsed) {
            await input.capability!.lifecycle!.beforeProviderInvocation();
            await input.capability!.lifecycle!.commitProviderResult({ result: { results: [] }, responseBytes: 2, resultCount: 0 });
          }
          controller.abort(new Error("operator cancelled after output construction"));
          await input.capability!.lifecycle!.beforeContainerTeardown("completed", completedOutput);
          return completedOutput;
        },
      },
    });

    await assert.rejects(
      service.execute(
        { ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [profile] },
        { language: "javascript", code: "console.log('late output')", capability: { capabilityId: "tavily.search.read", input: { query: providerUsed ? "used" : "unused" } } },
        {
          signal: controller.signal,
          capabilityRuntime,
          persistCompletedCapabilityResult: async () => { exactSaves += 1; },
        },
      ),
      /cancelled/iu,
    );
    assert.equal(exactSaves, 0);
    assert.deepEqual(transitions, ["cancelled", "cleaned"]);
  });
}

test("CodeExecutionService resolves the current credential revision for every selected call", async () => {
  const revisions: string[] = [];
  let executions = 0;
  const service = new CodeExecutionService({ executor: { async execute(input) { executions += 1; revisions.push(input.capability!.authority!.credentialReference.revision); return { status: "ok", exitCode: 0, stdout: "", stderr: "", durationMs: 1, artifacts: [] }; } } });
  const request = { language: "javascript" as const, code: "x", capability: { capabilityId: "tavily.search.read" as const, input: { query: "x" } } };
  let snapshot: { credentialId: "tool.tavily.default"; revision: string; secret: string } | undefined = { credentialId: "tool.tavily.default", revision: "r1", secret: "first-secret" };
  const capabilityRuntime = { ...runtime(), credentialSnapshot: undefined, resolveCredentialSnapshot: async () => { if (snapshot === undefined) throw new Error("deleted"); return snapshot; } };
  await service.execute({ ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [profile] }, request, { capabilityRuntime });
  snapshot = { credentialId: "tool.tavily.default", revision: "r2", secret: "second-secret" };
  await service.execute({ ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [profile] }, request, { capabilityRuntime });
  snapshot = undefined;
  await assert.rejects(service.execute({ ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [profile] }, request, { capabilityRuntime }), /deleted/u);
  assert.deepEqual(revisions, ["r1", "r2"]);
  assert.equal(executions, 2);
});

test("Tavily adapter rejects redirects and redacts credential-bearing failures", async () => {
  const service = new CodeExecutionService({ executor: { async execute(input) { await input.capability?.adapter?.(input.capability.expectedInput!, new AbortController().signal); return { status: "ok", exitCode: 0, stdout: "", stderr: "", durationMs: 1, artifacts: [] }; } } });
  const config = { ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [profile] };
  const request = { language: "javascript" as const, code: "x", capability: { capabilityId: "tavily.search.read" as const, input: { query: "x" } } };
  const redirect = await service.execute(config, request, { capabilityRuntime: runtime(async () => new Response("", { status: 302, headers: { location: "https://evil.example" } })) });
  assert.match(redirect.stderr, /rejected a redirect/u);
  const redacted = await service.execute(config, request, { capabilityRuntime: runtime(async () => { throw new Error("provider rejected real-secret-key"); }) });
  assert.match(redacted.stderr, /\[redacted:credential\]/u);
  assert.equal(redacted.stderr.includes("real-secret-key"), false);
});

test("Tavily adapter aborts the authenticated fetch when the capability pump is cancelled", async () => {
  let fetchObservedAbort = false;
  const controller = new AbortController();
  const service = new CodeExecutionService({ executor: { async execute(input) {
    const pending = input.capability!.adapter!(input.capability!.expectedInput!, controller.signal);
    controller.abort(new Error("sandbox cancelled"));
    await pending;
    throw new Error("adapter must reject");
  } } });
  const result = await service.execute(
    { ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [profile] },
    { language: "javascript", code: "x", capability: { capabilityId: "tavily.search.read", input: { query: "x" } } },
    { capabilityRuntime: runtime(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        fetchObservedAbort = true;
        reject(init.signal?.reason);
      }, { once: true });
    })) },
  );
  assert.equal(result.status, "error");
  assert.equal(fetchObservedAbort, true);
});

test("Tavily adapter cancels streamed response consumption above the byte ceiling", async () => {
  let bodyCancelled = false;
  let pulls = 0;
  const oversizedProfile = { ...profile, maxResponseBytes: 256 };
  const service = new CodeExecutionService({ executor: { async execute(input) {
    await input.capability!.adapter!(input.capability!.expectedInput!, new AbortController().signal);
    throw new Error("adapter must reject");
  } } });
  const result = await service.execute(
    { ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [oversizedProfile] },
    { language: "javascript", code: "x", capability: { capabilityId: "tavily.search.read", input: { query: "x" } } },
    { capabilityRuntime: {
      ...runtime(async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(150));
        },
        cancel() { bodyCancelled = true; },
      }), { status: 200 })),
      capabilityCatalogFingerprint: fingerprintSandboxCapabilityCatalogV1([oversizedProfile]),
    } },
  );
  assert.equal(result.status, "error");
  assert.match(result.stderr, /response exceeds/u);
  assert.equal(bodyCancelled, true);
  assert.equal(pulls <= 3, true);
});

test("Tavily adapter uses lease expiry when it precedes the profile timeout", async () => {
  const shortLeaseProfile = { ...profile, timeoutMs: 1000, maxExpiryMs: 100 };
  let deadlineObserved = false;
  const service = new CodeExecutionService({ executor: { async execute(input) {
    await input.capability!.adapter!(input.capability!.expectedInput!, new AbortController().signal);
    throw new Error("adapter must reject");
  } } });
  const startedAt = Date.now();
  const result = await service.execute(
    { ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [shortLeaseProfile] },
    { language: "javascript", code: "x", capability: { capabilityId: "tavily.search.read", input: { query: "x" } } },
    { capabilityRuntime: {
      ...runtime(async (_url, init) => new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error("adapter deadline was not enforced")), 500);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          deadlineObserved = true;
          reject(init.signal?.reason);
        }, { once: true });
      })),
      capabilityCatalogFingerprint: fingerprintSandboxCapabilityCatalogV1([shortLeaseProfile]),
      now: () => new Date(),
    } },
  );
  assert.equal(result.status, "error");
  assert.equal(deadlineObserved, true);
  assert.equal(Date.now() - startedAt < 750, true);
});

test("sensitive credential registration is reusable across sequential and overlapping capability calls", async () => {
  const activeReferences = new Set<string>();
  const registerSensitiveValue = (input: { referenceId: string }) => {
    assert.equal(activeReferences.has(input.referenceId), false, input.referenceId);
    activeReferences.add(input.referenceId);
    return () => {
      activeReferences.delete(input.referenceId);
    };
  };
  const config = { ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [profile] };
  const request = { language: "javascript" as const, code: "x", capability: { capabilityId: "tavily.search.read" as const, input: { query: "x" } } };

  const sequential = new CodeExecutionService({
    executor: {
      async execute() {
        assert.equal(activeReferences.size, 1);
        return { status: "ok", exitCode: 0, stdout: "", stderr: "", durationMs: 1, artifacts: [] };
      },
    },
  });
  const sequentialRuntime = { ...runtime(), registerSensitiveValue, toolCallId: "call-sequential" };
  await sequential.execute(config, request, { capabilityRuntime: sequentialRuntime });
  assert.equal(activeReferences.size, 0);
  await sequential.execute(config, request, { capabilityRuntime: sequentialRuntime });
  assert.equal(activeReferences.size, 0);

  let releaseExecutions: (() => void) | undefined;
  const executionsMayFinish = new Promise<void>((resolve) => {
    releaseExecutions = resolve;
  });
  let executing = 0;
  const overlapping = new CodeExecutionService({
    executor: {
      async execute() {
        executing += 1;
        if (executing === 2) releaseExecutions?.();
        await executionsMayFinish;
        assert.equal(activeReferences.size, 2);
        return { status: "ok", exitCode: 0, stdout: "", stderr: "", durationMs: 1, artifacts: [] };
      },
    },
  });
  await Promise.all([
    overlapping.execute(config, request, { capabilityRuntime: { ...runtime(), registerSensitiveValue, toolCallId: "call-overlap-a" } }),
    overlapping.execute(config, request, { capabilityRuntime: { ...runtime(), registerSensitiveValue, toolCallId: "call-overlap-b" } }),
  ]);
  assert.equal(activeReferences.size, 0);
});

test("sensitive credential registration is released after error, timeout, and cancellation", async () => {
  const activeReferences = new Set<string>();
  const registerSensitiveValue = (input: { referenceId: string }) => {
    activeReferences.add(input.referenceId);
    return () => {
      activeReferences.delete(input.referenceId);
    };
  };
  const config = { ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [profile] };
  const request = { language: "javascript" as const, code: "x", capability: { capabilityId: "tavily.search.read" as const, input: { query: "x" } } };
  const output = (status: "error" | "timeout") => ({ status, exitCode: status === "error" ? 1 : null, stdout: "", stderr: "", durationMs: 1, artifacts: [] });

  for (const status of ["error", "timeout"] as const) {
    const service = new CodeExecutionService({ executor: { async execute() { return output(status); } } });
    await service.execute(config, request, { capabilityRuntime: { ...runtime(), registerSensitiveValue, toolCallId: `call-${status}` } });
    assert.equal(activeReferences.size, 0, status);
  }

  const controller = new AbortController();
  const cancellationRegistry = new SensitiveValueRegistry();
  const cancellationSecret = "cancelled-provider-secret";
  const cancelled = new CodeExecutionService({
    executor: {
      async execute() {
        controller.abort();
        const error = new Error(`cancelled after provider reflected ${cancellationSecret}`);
        Object.assign(error, { code: "RUN_CANCELLED", detail: cancellationSecret });
        throw error;
      },
    },
  });
  await assert.rejects(
    cancelled.execute(config, request, {
      signal: controller.signal,
      capabilityRuntime: {
        ...runtime(),
        credentialSnapshot: { credentialId: "tool.tavily.default", revision: "credential-rev-cancelled", secret: cancellationSecret },
        registerSensitiveValue: (input) => cancellationRegistry.register({
          reference: { referenceId: input.referenceId, kind: "credential", scope: "sandbox-capability" },
          value: input.value,
        }),
        redactSensitiveValues: <T>(value: T) => cancellationRegistry.redact(value).value,
        toolCallId: "call-cancelled",
      },
    }),
    (error) => {
      assert.equal(error instanceof Error, true);
      assert.equal(JSON.stringify({
        message: (error as Error).message,
        stack: (error as Error).stack,
        ...(error as Record<string, unknown>),
      }).includes(cancellationSecret), false);
      assert.equal((error as Error & { code?: string }).code, "RUN_CANCELLED");
      assert.match((error as Error).message, /redacted/iu);
      return true;
    },
  );
  assert.equal(activeReferences.size, 0);
  assert.equal(cancellationRegistry.registeredValueDigests().length, 0);
});

test("credential-bearing executor output is redacted before its registration is released", async () => {
  const registry = new SensitiveValueRegistry();
  const secret = "real-secret-key";
  const service = new CodeExecutionService({
    executor: {
      async execute() {
        assert.equal(registry.registeredValueDigests().length, 1);
        return {
          status: "error",
          exitCode: 1,
          stdout: `provider reflected ${secret}`,
          stderr: `provider rejected ${secret}`,
          durationMs: 1,
          artifacts: [{
            path: "provider.txt",
            sizeBytes: secret.length,
            sha256: "a".repeat(64),
            preview: { text: secret, truncated: false },
          }],
        };
      },
    },
  });
  const capabilityRuntime = {
    ...runtime(),
    registerSensitiveValue: (input: { referenceId: string; value: string }) => registry.register({
      reference: { referenceId: input.referenceId, kind: "credential", scope: "sandbox-capability" },
      value: input.value,
    }),
    redactSensitiveValues: <T>(value: T) => registry.redact(value).value,
  };

  const result = await service.execute(
    { ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [profile] },
    { language: "javascript", code: "x", capability: { capabilityId: "tavily.search.read", input: { query: "x" } } },
    { capabilityRuntime },
  );

  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.match(result.stdout, /redacted/iu);
  assert.match(result.stderr, /redacted/iu);
  assert.match(result.summary, /redacted/iu);
  assert.match(result.artifacts[0]?.preview?.text ?? "", /redacted/iu);
  assert.equal(registry.registeredValueDigests().length, 0);
});

test("throwing sensitive-value cleanup never replaces success, error, or sanitized cancellation", async () => {
  const secret = "throwing-cleanup-secret";
  const config = { ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [profile] };
  const request = { language: "javascript" as const, code: "x", capability: { capabilityId: "tavily.search.read" as const, input: { query: "x" } } };

  for (const mode of ["success", "error", "cancellation"] as const) {
    const registry = new SensitiveValueRegistry();
    const controller = new AbortController();
    let cleanupCalls = 0;
    const service = new CodeExecutionService({ executor: {
      async execute() {
        if (mode === "success") return { status: "ok", exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, artifacts: [] };
        if (mode === "error") throw new Error("primary execution error");
        controller.abort();
        throw Object.assign(new Error(`cancelled ${secret}`), { code: "RUN_CANCELLED" });
      },
    } });
    const capabilityRuntime = {
      ...runtime(),
      credentialSnapshot: { credentialId: "tool.tavily.default" as const, revision: `cleanup-${mode}`, secret },
      registerSensitiveValue: (input: { referenceId: string; value: string }) => {
        const release = registry.register({
          reference: { referenceId: input.referenceId, kind: "credential", scope: "sandbox-capability" },
          value: input.value,
        });
        return () => {
          cleanupCalls += 1;
          release();
          throw new Error(`cleanup leaked ${secret}`);
        };
      },
      redactSensitiveValues: <T>(value: T) => registry.redact(value).value,
    };

    if (mode === "cancellation") {
      await assert.rejects(
        service.execute(config, request, { signal: controller.signal, capabilityRuntime }),
        (error) => {
          assert.equal((error as Error & { code?: string }).code, "RUN_CANCELLED");
          assert.equal(JSON.stringify({ message: (error as Error).message, ...(error as object) }).includes(secret), false);
          return true;
        },
      );
    } else {
      const result = await service.execute(config, request, { capabilityRuntime });
      assert.equal(result.status, mode === "success" ? "ok" : "error");
      if (mode === "error") assert.match(result.stderr, /primary execution error/u);
    }
    assert.equal(cleanupCalls, 1);
    assert.equal(registry.registeredValueDigests().length, 0);
  }
});

test("cancellation sanitization handles DOMException, frozen errors, and cyclic diagnostics without leaking", async () => {
  const cases = [
    (secret: string): Error => {
      const error = new DOMException(`provider aborted with ${secret}`, "AbortError");
      Object.defineProperty(error, "detail", {
        value: { secret },
        enumerable: true,
      });
      return error;
    },
    (secret: string): Error => {
      const error = new Error(`frozen cancellation ${secret}`) as Error & { code: string; detail: unknown };
      error.name = "RunCancelledError";
      error.code = "RUN_CANCELLED";
      const detail: { secret: string; self?: unknown; error?: unknown } = { secret };
      detail.self = detail;
      detail.error = error;
      error.detail = detail;
      error.cause = error;
      return Object.freeze(error);
    },
  ];

  for (const [index, createError] of cases.entries()) {
    const secret = `cancellation-secret-${index}`;
    const registry = new SensitiveValueRegistry();
    const controller = new AbortController();
    const thrown = createError(secret);
    const service = new CodeExecutionService({
      executor: {
        async execute() {
          controller.abort();
          throw thrown;
        },
      },
    });

    await assert.rejects(
      service.execute(
        { ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [profile] },
        { language: "javascript", code: "x", capability: { capabilityId: "tavily.search.read", input: { query: "x" } } },
        { signal: controller.signal, capabilityRuntime: {
          ...runtime(),
          credentialSnapshot: { credentialId: "tool.tavily.default", revision: `credential-${index}`, secret },
          registerSensitiveValue: (input) => registry.register({
            reference: { referenceId: input.referenceId, kind: "credential", scope: "sandbox-capability" },
            value: input.value,
          }),
          redactSensitiveValues: <T>(value: T) => registry.redact(value).value,
          toolCallId: `call-${index}`,
        } },
      ),
      (error) => {
        assert.equal(error instanceof Error, true);
        assert.notEqual(error, thrown);
        assert.equal((error as Error).name, index === 0 ? "AbortError" : "RunCancelledError");
        assert.equal((error as Error & { code?: unknown }).code, index === 0 ? DOMException.ABORT_ERR : "RUN_CANCELLED");
        const serialized = JSON.stringify({
          name: (error as Error).name,
          message: (error as Error).message,
          cause: (error as Error).cause,
          ...(error as Record<string, unknown>),
        });
        assert.equal(serialized.includes(secret), false);
        assert.match(serialized, /redacted/iu);
        return true;
      },
    );
    assert.equal(registry.registeredValueDigests().length, 0);
  }
});

test("cancellation sanitization fails closed for hostile proxies and secret-bearing keys", async () => {
  const secret = "proxy-cancellation-secret";
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const ownKeysProxy = new Proxy({}, {
    ownKeys() {
      throw new Error(secret);
    },
  });
  const descriptorProxy = new Proxy({ detail: secret }, {
    getOwnPropertyDescriptor() {
      throw new Error(secret);
    },
  });
  const topLevelOwnKeysProxy = new Proxy({}, {
    ownKeys() {
      throw new Error(secret);
    },
  });
  const topLevelDescriptorProxy = new Proxy({ detail: secret }, {
    getOwnPropertyDescriptor() {
      throw new Error(secret);
    },
  });
  const keyedError = Object.assign(new Error(`cancelled ${secret}`), {
    code: "RUN_CANCELLED",
    [secret]: secret,
    [Symbol(secret)]: secret,
    ownKeysProxy,
    descriptorProxy,
  });
  const cases: Array<{ thrown: unknown; expectedName: string; expectedCode: string }> = [
    { thrown: revoked.proxy, expectedName: "RunCancelledError", expectedCode: "RUN_CANCELLED" },
    { thrown: topLevelOwnKeysProxy, expectedName: "RunCancelledError", expectedCode: "RUN_CANCELLED" },
    { thrown: topLevelDescriptorProxy, expectedName: "RunCancelledError", expectedCode: "RUN_CANCELLED" },
    { thrown: keyedError, expectedName: "Error", expectedCode: "RUN_CANCELLED" },
  ];

  for (const [index, testCase] of cases.entries()) {
    const registry = new SensitiveValueRegistry();
    const controller = new AbortController();
    const service = new CodeExecutionService({
      executor: {
        async execute() {
          controller.abort();
          throw testCase.thrown;
        },
      },
    });

    await assert.rejects(
      service.execute(
        { ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [profile] },
        { language: "javascript", code: "x", capability: { capabilityId: "tavily.search.read", input: { query: "x" } } },
        { signal: controller.signal, capabilityRuntime: {
          ...runtime(),
          credentialSnapshot: { credentialId: "tool.tavily.default", revision: `proxy-credential-${index}`, secret },
          registerSensitiveValue: (input) => registry.register({
            reference: { referenceId: input.referenceId, kind: "credential", scope: "sandbox-capability" },
            value: input.value,
          }),
          redactSensitiveValues: <T>(value: T) => registry.redact(value).value,
          toolCallId: `proxy-call-${index}`,
        } },
      ),
      (error) => {
        assert.equal(error instanceof Error, true);
        assert.equal((error as Error).name, testCase.expectedName);
        assert.equal((error as Error & { code?: unknown }).code, testCase.expectedCode);
        assert.equal(Reflect.ownKeys(error as object).some((key) => String(key).includes(secret)), false);
        assert.equal(JSON.stringify(error).includes(secret), false);
        return true;
      },
    );
    assert.equal(registry.registeredValueDigests().length, 0);
  }
});

let registeredSensitiveValue = "";
function runtime(fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ results: [] }), { status: 200 })) {
  registeredSensitiveValue = "";
  return { tenantId: "tenant-a", environmentId: "env-a", sessionId: "session-a", runId: "run-a", toolCallId: "call-a", profileFingerprint: fingerprintSandboxCapabilityProfileV1(profile), capabilityCatalogFingerprint: fingerprintSandboxCapabilityCatalogV1([profile]), executionBoundaryRevision: KESTREL_EXECUTION_BOUNDARY_POLICY.revision, brokerAuthority: profile.brokerAuthority, credentialSnapshot: { credentialId: "tool.tavily.default" as const, revision: "credential-rev-1", secret: "real-secret-key" }, fetchImpl, registerSensitiveValue: (input: { value: string }) => { registeredSensitiveValue = input.value; return () => {}; }, redactSensitiveValues: <T>(value: T) => value, now: () => new Date("2026-08-22T12:00:00.000Z"), leaseCoordinator: createTestLeaseCoordinator() };
}

function createTestLeaseCoordinator(): SandboxCapabilityLeaseCoordinator {
  const transitions = new Map<string, SandboxCapabilityLeaseTransitionRecordV1[]>();
  const childReservations = new Map<string, SandboxCapabilityChildReservationV1>();
  const store: SandboxCapabilityLeaseStore = {
    async appendSandboxCapabilityLeaseTransition({ expectedSequence, record }) {
      const records = transitions.get(record.leaseId) ?? [];
      assert.equal(records.at(-1)?.sequence ?? 0, expectedSequence);
      records.push(structuredClone(record));
      transitions.set(record.leaseId, records);
      return structuredClone(record);
    },
    async issueSandboxCapabilityLease(input) {
      if (input.childReservation !== undefined) childReservations.set(input.childReservation.reservationId, structuredClone(input.childReservation));
      return this.appendSandboxCapabilityLeaseTransition(input);
    },
    async reserveSandboxCapabilityInvocation(input) {
      return { ...await this.appendSandboxCapabilityLeaseTransition(input), invocationResponseByteLimit: input.record.usage.responseByteLimit - input.record.usage.responseBytesConsumed };
    },
    async getSandboxCapabilityLease(leaseId) {
      return structuredClone(transitions.get(leaseId)?.at(-1) ?? null);
    },
    async listSandboxCapabilityLeaseTransitions(leaseId) {
      return structuredClone(transitions.get(leaseId) ?? []);
    },
    async listRecoverableSandboxCapabilityLeases() { return []; },
    async reserveSandboxCapabilityChild({ reservation }) {
      childReservations.set(reservation.reservationId, structuredClone(reservation));
      return structuredClone(reservation);
    },
    async settleSandboxCapabilityChild(input) {
      const current = childReservations.get(input.reservationId)!;
      const next: SandboxCapabilityChildReservationV1 = { ...current, sequence: input.expectedSequence + 1, status: input.status, requestsCommitted: input.requestsCommitted, responseBytesCommitted: input.responseBytesCommitted, ...(input.reason === undefined ? {} : { reason: input.reason }), occurredAt: input.occurredAt };
      childReservations.set(input.reservationId, next);
      return structuredClone(next);
    },
    async getSandboxCapabilityChildReservation(reservationId) {
      return structuredClone(childReservations.get(reservationId) ?? null);
    },
    async listSandboxCapabilityChildReservations(parentLeaseId) {
      return structuredClone([...childReservations.values()].filter((item) => item.decision.parentLeaseId === parentLeaseId));
    },
    async saveSandboxCapabilityEffectResult() {},
  };
  return new SandboxCapabilityLeaseCoordinator({
    store,
    now: () => new Date("2026-08-22T12:00:00.000Z"),
    validateCurrent: async () => ({ authorized: true }),
    persistResult: async ({ leaseId, result }) => ({
      digest: digestSandboxCapabilityResult(result),
      reference: `test-result:${leaseId}`,
    }),
  });
}
