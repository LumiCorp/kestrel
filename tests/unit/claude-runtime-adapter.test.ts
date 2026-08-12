import assert from "node:assert/strict";
import test from "node:test";

import type {
  Options,
  PermissionResult,
  Query,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { TuiProfile } from "../../cli/contracts.js";
import { ClaudeRuntimeAdapter } from "../../src/runtimes/claude/ClaudeRuntimeAdapter.js";
import { InMemoryRuntimeNativeSessionStore } from "../../src/runtimes/contracts.js";
import type { RuntimeBindingV1 } from "../../src/runtimes/contracts.js";

const profile: TuiProfile = {
  id: "claude",
  label: "Claude",
  agent: "kestrel",
  sessionPrefix: "claude",
  runtimeId: "claude",
  modelProvider: "anthropic",
  model: "claude-sonnet-4-5",
};

const binding: RuntimeBindingV1 = {
  version: "runtime_binding_v1",
  bindingId: "binding-claude",
  threadId: "thread-claude",
  participantId: "runtime:claude",
  runtimeId: "claude",
  environmentId: "local",
  adapterContractVersion: 1,
  capabilityDigest: "digest",
  status: "ready",
  nativeSessionState: "uninitialized",
};

function completedQuery(): Query {
  const iterator = (async function* () {
    yield {
      type: "result",
      subtype: "success",
      session_id: "native",
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as SDKMessage;
  })();
  return Object.assign(iterator, {
    close() {},
    initializationResult: async () => ({}),
    accountInfo: async () => ({ email: "test@example.com" }),
    supportedModels: async () => [{ value: "claude-sonnet-4-5" }],
  }) as unknown as Query;
}

test("Claude resumes the persisted native session on an ordinary later turn", async () => {
  binding.nativeSessionState = "uninitialized";
  const store = new InMemoryRuntimeNativeSessionStore();
  const options: Options[] = [];
  const runQuery = ((input: { options?: Options }) => {
    options.push(input.options ?? {});
    return completedQuery();
  }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
  const first = new ClaudeRuntimeAdapter(profile, {}, { ANTHROPIC_API_KEY: "secret" }, store, undefined, undefined, runQuery);
  assert.equal((await first.execute({
    kind: "start",
    binding,
    turn: { sessionId: binding.threadId, eventType: "user.message", message: "first" },
  })).output.status, "COMPLETED");

  const second = new ClaudeRuntimeAdapter(profile, {}, { ANTHROPIC_API_KEY: "secret" }, store, undefined, undefined, runQuery);
  assert.equal((await second.execute({
    kind: "start",
    binding,
    turn: { sessionId: binding.threadId, eventType: "user.message", message: "second" },
  })).output.status, "COMPLETED");
  assert.equal(options[0]?.sessionId !== undefined, true);
  assert.equal(options[1]?.resume, options[0]?.sessionId);
  assert.equal(options[1]?.sessionId, undefined);
});

test("Claude maps structured question answers and acknowledges after callback resolution", async () => {
  binding.nativeSessionState = "uninitialized";
  const events: string[] = [];
  let permissionResult: PermissionResult | null | undefined;
  const runQuery = ((input: { options?: Options }) => {
    const iterator = (async function* () {
      permissionResult = await input.options!.canUseTool!(
        "AskUserQuestion",
        {
          questions: [{
            question: "Which workspace?",
            header: "Workspace",
            options: [{ label: "A", description: "Workspace A" }, { label: "B", description: "Workspace B" }],
            multiSelect: false,
          }],
        },
        {
          signal: new AbortController().signal,
          suggestions: [],
          toolUseID: "tool-1",
          title: "Choose a workspace",
          description: "Choose a workspace",
          requestId: "request-1",
        },
      );
      events.push("permission-resolved");
      yield {
        type: "assistant",
        session_id: "native",
        message: { content: [{ type: "text", text: "Continuing" }] },
      } as unknown as SDKMessage;
    })();
    return Object.assign(iterator, {
      close() {},
      initializationResult: async () => ({}),
      accountInfo: async () => ({ email: "test@example.com" }),
      supportedModels: async () => [{ value: "claude-sonnet-4-5" }],
    }) as unknown as Query;
  }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
  const adapter = new ClaudeRuntimeAdapter(
    profile,
    { onInteractionDelivered: () => events.push("delivered") },
    { ANTHROPIC_API_KEY: "secret" },
    new InMemoryRuntimeNativeSessionStore(),
    undefined,
    undefined,
    runQuery,
  );
  const waiting = await adapter.execute({
    kind: "start",
    binding,
    turn: { sessionId: binding.threadId, eventType: "user.message", message: "work" },
  });
  assert.equal(waiting.output.status, "WAITING");
  const completed = await adapter.execute({
    kind: "continue",
    binding,
    turn: {
      sessionId: binding.threadId,
      eventType: "runtime.interaction.response",
      message: "A",
      resumeBlockedRun: true,
      resumeRequestId: "request-1",
      interactionResponse: {
        requestId: "request-1",
        eventType: "runtime.interaction.response",
        message: "A",
        answers: { "question-1": ["A"] },
      },
    },
  });
  assert.equal(completed.output.status, "COMPLETED");
  assert.deepEqual(events, ["permission-resolved", "delivered"]);
  assert.deepEqual(
    permissionResult?.behavior === "allow" ? permissionResult.updatedInput : undefined,
    {
      questions: [{
        question: "Which workspace?",
        header: "Workspace",
        options: [{ label: "A", description: "Workspace A" }, { label: "B", description: "Workspace B" }],
        multiSelect: false,
      }],
      answers: { "Which workspace?": ["A"] },
    },
  );
});
