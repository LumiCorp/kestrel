import assert from "node:assert/strict";
import test from "node:test";

import type { TuiProfile } from "../../cli/contracts.js";
import type { CodexAppServerClientOptions } from "../../src/runtimes/codex/CodexAppServerClient.js";
import {
  CodexRuntimeAdapter,
  type CodexClient,
} from "../../src/runtimes/codex/CodexRuntimeAdapter.js";
import { InMemoryRuntimeNativeSessionStore } from "../../src/runtimes/contracts.js";
import type { RuntimeBindingV1 } from "../../src/runtimes/contracts.js";

class FakeCodexClient implements CodexClient {
  readonly requests: Array<{ method: string; params: unknown }> = [];

  constructor(private readonly options: CodexAppServerClientOptions) {}

  async start() {}

  async request<TResult>(method: string, params?: unknown): Promise<TResult> {
    this.requests.push({ method, params });
    if (method === "account/read") {
      return { account: null, requiresOpenaiAuth: false } as TResult;
    }
    if (method === "thread/start") return { thread: { id: "native-thread-1" } } as TResult;
    if (method === "thread/resume") {
      return { thread: { id: (params as { threadId: string }).threadId } } as TResult;
    }
    if (method === "turn/start") {
      const threadId = (params as { threadId: string }).threadId;
      queueMicrotask(() =>
        this.options.onNotification?.({
          method: "turn/completed",
          params: {
            threadId,
            turn: { id: "turn-1", status: "completed", error: null },
          },
        }),
      );
      return { turn: { id: "turn-1" } } as TResult;
    }
    return {} as TResult;
  }

  respond() {}
  respondError() {}
  close() {}
}

class WaitingCodexClient implements CodexClient {
  responses = 0;
  constructor(private readonly options: CodexAppServerClientOptions) {}
  async start() {}
  async request<TResult>(method: string, params?: unknown): Promise<TResult> {
    if (method === "account/read") return { account: null, requiresOpenaiAuth: false } as TResult;
    if (method === "thread/start") return { thread: { id: "native-thread-wait" } } as TResult;
    if (method === "turn/start") {
      queueMicrotask(() => this.options.onServerRequest?.({
        method: "item/commandExecution/requestApproval",
        id: 41,
        params: {
          threadId: "native-thread-wait",
          turnId: "turn-wait",
          itemId: "item-wait",
          reason: "Run tests?",
        },
      }));
      return { turn: { id: "turn-wait" } } as TResult;
    }
    return {} as TResult;
  }
  respond() { this.responses += 1; }
  respondError() {}
  close() {}
  exit() { this.options.onExit?.(new Error("app-server exited")); }
}

class ExitingCodexClient implements CodexClient {
  constructor(
    private readonly options: CodexAppServerClientOptions,
    private readonly failure: Error,
  ) {}
  async start() {}
  async request<TResult>(method: string): Promise<TResult> {
    if (method === "thread/start") {
      return { thread: { id: "native-thread-exit" } } as TResult;
    }
    if (method === "turn/start") {
      queueMicrotask(() => this.options.onExit?.(this.failure));
      return { turn: { id: "turn-exit" } } as TResult;
    }
    return {} as TResult;
  }
  respond() {}
  respondError() {}
  close() {}
}

class MissingResumeCodexClient extends FakeCodexClient {
  override async request<TResult>(method: string, params?: unknown): Promise<TResult> {
    if (method === "thread/resume") {
      this.requests.push({ method, params });
      throw new Error("native rollout not found");
    }
    return await super.request<TResult>(method, params);
  }
}

const profile: TuiProfile = {
  id: "codex",
  label: "Codex",
  agent: "kestrel",
  sessionPrefix: "codex",
  runtimeId: "codex",
  modelProvider: "openai",
  model: "gpt-5",
};

const binding: RuntimeBindingV1 = {
  version: "runtime_binding_v1",
  bindingId: "binding-1",
  threadId: "thread-1",
  participantId: "runtime:codex",
  runtimeId: "codex",
  environmentId: "local",
  adapterContractVersion: 1,
  capabilityDigest: "digest",
  status: "ready",
  nativeSessionState: "uninitialized",
};

test("Codex resumes the persisted native Thread on an ordinary later turn", async () => {
  binding.nativeSessionState = "uninitialized";
  const store = new InMemoryRuntimeNativeSessionStore();
  const clients: FakeCodexClient[] = [];
  const createClient = (options: CodexAppServerClientOptions) => {
    const client = new FakeCodexClient(options);
    clients.push(client);
    return client;
  };
  const first = new CodexRuntimeAdapter(profile, {}, {}, store, undefined, createClient);
  const initial = await first.execute({
    kind: "start",
    binding,
    turn: {
      sessionId: "thread-1",
      eventType: "user.message",
      message: "second",
      history: [
        { role: "user", text: "first", timestamp: "2026-08-11T00:00:00.000Z" },
      ],
    },
  });
  assert.equal(initial.output.status, "COMPLETED");
  await first.dispose();

  const second = new CodexRuntimeAdapter(profile, {}, {}, store, undefined, createClient);
  const resumed = await second.execute({
    kind: "start",
    binding,
    turn: {
      sessionId: "thread-1",
      eventType: "user.message",
      message: "third",
      history: [
        { role: "user", text: "first", timestamp: "2026-08-11T00:00:00.000Z" },
        { role: "assistant", text: "second", timestamp: "2026-08-11T00:00:01.000Z" },
      ],
    },
  });

  assert.equal(resumed.output.status, "COMPLETED");
  assert.equal(clients[1]?.requests.some((request) => request.method === "thread/resume"), true);
  const turnStart = clients[1]?.requests.find((request) => request.method === "turn/start");
  assert.doesNotMatch(JSON.stringify(turnStart?.params), /first/u);
  assert.match(JSON.stringify(turnStart?.params), /third/u);
});

test("Codex fails a lost live wait without restarting or answering an obsolete request", async () => {
  binding.nativeSessionState = "uninitialized";
  let client: WaitingCodexClient | undefined;
  let clientCount = 0;
  const adapter = new CodexRuntimeAdapter(
    profile,
    {},
    {},
    new InMemoryRuntimeNativeSessionStore(),
    undefined,
    (options) => {
      clientCount += 1;
      client = new WaitingCodexClient(options);
      return client;
    },
  );
  const waiting = await adapter.execute({
    kind: "start",
    binding,
    turn: { sessionId: "thread-1", eventType: "user.message", message: "work" },
  });
  assert.equal(waiting.output.status, "WAITING");
  const requestId = waiting.output.waitFor?.interaction?.requestId;
  assert.equal(typeof requestId, "string");
  assert.notEqual(requestId, "41");
  assert.deepEqual(waiting.output.waitFor?.interaction?.privateRuntimeMetadata, {
    nativeRequestId: "41",
  });
  client!.exit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    (adapter as unknown as { sessions: Map<string, unknown> }).sessions.size,
    0,
  );

  const resumed = await adapter.execute({
    kind: "continue",
    binding,
    turn: {
      sessionId: "thread-1",
      eventType: "runtime.interaction.response",
      message: "Approved",
      resumeBlockedRun: true,
      resumeRequestId: requestId,
      interactionResponse: {
        requestId: requestId!,
        eventType: "runtime.interaction.response",
        message: "Approved",
        approved: true,
      },
    },
  });
  assert.equal(resumed.output.status, "FAILED");
  assert.equal(resumed.output.errors[0]?.code, "RUNTIME_LIVE_WAIT_LOST");
  assert.equal(clientCount, 1);
  assert.equal(client!.responses, 0);
});

test("Codex ordinary process exit is retryable without degrading native state", async () => {
  const ordinaryBinding = {
    ...binding,
    status: "ready" as const,
    nativeSessionState: "uninitialized" as const,
  };
  const store = new InMemoryRuntimeNativeSessionStore();
  const adapter = new CodexRuntimeAdapter(
    profile,
    {},
    {},
    store,
    undefined,
    (options) => new ExitingCodexClient(options, new Error("process exited")),
  );
  const result = await adapter.execute({
    kind: "start",
    binding: ordinaryBinding,
    turn: { sessionId: binding.threadId, eventType: "user.message", message: "work" },
  });
  assert.equal(result.output.status, "FAILED");
  assert.equal(result.output.errors[0]?.code, "CODEX_RUNTIME_FAILED");
  assert.equal(ordinaryBinding.status, "ready");
  assert.equal((await store.load(binding.bindingId))?.status, "ready");
});

test("Codex retries native resume on the original root after a first-turn process exit", async () => {
  const restartBinding = {
    ...binding,
    status: "ready" as const,
    nativeSessionState: "uninitialized" as const,
  };
  const store = new InMemoryRuntimeNativeSessionStore();
  const environment = async () => ({
    env: { CODEX_HOME: "/tmp/kestrel-codex-original-root" },
    credentialFingerprint: "same-root",
  });
  const missingCheckpoint = {
    async capture() {},
    async materialize() { return "missing" as const; },
    async release() {},
  };
  const first = new CodexRuntimeAdapter(
    profile,
    {},
    {},
    store,
    environment,
    (options) => new ExitingCodexClient(options, new Error("process exited")),
    missingCheckpoint,
  );
  const failed = await first.execute({
    kind: "start",
    binding: restartBinding,
    turn: { sessionId: binding.threadId, eventType: "user.message", message: "first" },
  });
  assert.equal(failed.output.errors[0]?.code, "CODEX_RUNTIME_FAILED");
  assert.equal(restartBinding.nativeSessionState, "ready");

  const clients: FakeCodexClient[] = [];
  const restarted = new CodexRuntimeAdapter(
    profile,
    {},
    {},
    store,
    environment,
    (options) => {
      const client = new FakeCodexClient(options);
      clients.push(client);
      return client;
    },
    missingCheckpoint,
  );
  const resumed = await restarted.execute({
    kind: "start",
    binding: restartBinding,
    turn: { sessionId: binding.threadId, eventType: "user.message", message: "second" },
  });
  assert.equal(resumed.output.status, "COMPLETED");
  assert.equal(
    clients[0]?.requests.some((request) => request.method === "thread/resume"),
    true,
  );
});

test("Codex preserves CODEX_PROTOCOL_INVALID for app-server validation failure", async () => {
  const protocolBinding = {
    ...binding,
    status: "ready" as const,
    nativeSessionState: "uninitialized" as const,
  };
  const error = Object.assign(new Error("malformed native payload"), {
    code: "CODEX_PROTOCOL_INVALID",
  });
  const adapter = new CodexRuntimeAdapter(
    profile,
    {},
    {},
    new InMemoryRuntimeNativeSessionStore(),
    undefined,
    (options) => new ExitingCodexClient(options, error),
  );
  const result = await adapter.execute({
    kind: "start",
    binding: protocolBinding,
    turn: { sessionId: binding.threadId, eventType: "user.message", message: "work" },
  });
  assert.equal(result.output.status, "FAILED");
  assert.equal(result.output.errors[0]?.code, "CODEX_PROTOCOL_INVALID");
});

test("Codex maps a failed native resume without a checkpoint to native-session loss", async () => {
  const resumeBinding = {
    ...binding,
    status: "ready" as const,
    nativeSessionState: "ready" as const,
  };
  const store = new InMemoryRuntimeNativeSessionStore();
  await store.save({
    version: "runtime_native_session_v1",
    bindingId: binding.bindingId,
    runtimeId: "codex",
    threadId: binding.threadId,
    participantId: binding.participantId,
    environmentId: binding.environmentId,
    nativeSessionId: "native-thread-missing-checkpoint",
    nativeVersion: "0.147.0",
    status: "ready",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  });
  const clients: FakeCodexClient[] = [];
  const adapter = new CodexRuntimeAdapter(
    profile,
    {},
    {},
    store,
    async () => ({
      env: { CODEX_HOME: "/tmp/kestrel-codex-missing-checkpoint" },
      credentialFingerprint: "credential-root-b",
    }),
    (options) => {
      const client = new MissingResumeCodexClient(options);
      clients.push(client);
      return client;
    },
    {
      async capture() {},
      async materialize() { return "missing"; },
      async release() {},
    },
  );
  const result = await adapter.execute({
    kind: "start",
    binding: resumeBinding,
    turn: { sessionId: binding.threadId, eventType: "user.message", message: "resume" },
  });
  assert.equal(result.output.status, "FAILED");
  assert.equal(result.output.errors[0]?.code, "RUNTIME_NATIVE_SESSION_LOST");
  assert.equal(
    clients[0]?.requests.some((request) => request.method === "thread/resume"),
    true,
  );
  assert.equal((await store.load(binding.bindingId))?.status, "degraded");
});
