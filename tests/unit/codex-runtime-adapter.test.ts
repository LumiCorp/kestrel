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
  client!.exit();

  const resumed = await adapter.execute({
    kind: "continue",
    binding,
    turn: {
      sessionId: "thread-1",
      eventType: "runtime.interaction.response",
      message: "Approved",
      resumeBlockedRun: true,
      resumeRequestId: "41",
      interactionResponse: {
        requestId: "41",
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
