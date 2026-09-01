import test from "node:test";
import assert from "node:assert/strict";

import { KestrelChatRuntime } from "../../cli/runtime/KestrelChatRuntime.js";
import { DevShellSupervisor } from "../../src/devshell/DevShellSupervisor.js";

test("request replies resume with the authoritative thread workspace", async () => {
  const thread = {
    threadId: "thread-workspace-resume",
    sessionId: "session-workspace-resume",
  };
  const workspace = {
    kind: "local",
    workspaceId: "local:workspace-a",
    workspaceRoot: "/workspace/a",
  };
  let capturedRuntimeTurn: Record<string, unknown> | undefined;
  const runtime = Object.create(KestrelChatRuntime.prototype) as KestrelChatRuntime;

  Object.assign(runtime, {
    threadRuntime: {
      async getThreadStatus() {
        return {
          thread,
          openRequests: [
            {
              requestId: "request-workspace-resume",
              eventType: "request.clarification",
              metadata: {},
            },
          ],
        };
      },
      async getOperatorThreadView() {
        return { thread, workspace };
      },
      subscribe() {
        return { unsubscribe() {} };
      },
      replyToRequest(input: { runtimeTurn: Record<string, unknown> }) {
        capturedRuntimeTurn = input.runtimeTurn;
        return Promise.resolve({
          assistantText: "Done.",
          output: {
            sessionId: thread.sessionId,
            runId: "run-workspace-resume",
            status: "COMPLETED",
          },
        });
      },
      async listOperatorInbox() {
        return [];
      },
    },
  });

  await runtime.performAcceptedOperatorAction({
    action: "reply",
    threadId: thread.threadId,
    requestId: "request-workspace-resume",
    message: "Continue in build mode.",
  });

  assert.deepEqual(capturedRuntimeTurn?.workspace, workspace);
});

test("developer shell refuses to use the host process directory as workspace authority", async () => {
  const supervisor = Object.create(DevShellSupervisor.prototype) as DevShellSupervisor;

  await assert.rejects(
    supervisor.startProcess({ command: "pwd" }),
    /requires an explicit workspace root/u,
  );
});
