import assert from "node:assert/strict";
import test from "node:test";

import { createAgent, type KestrelMemorySnapshot } from "../src/index.js";

const context = {
  actor: {
    actorId: "sdk-user",
    actorType: "end_user" as const,
    displayName: "SDK User",
    tenantId: "internal",
  },
  tenantId: "internal",
};

test("createAgent runs and resumes with the configured profile", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const agent = createAgent({
    id: "support",
    profileId: "support-profile",
    baseUrl: "http://runner.internal",
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      return new Response(
        `event: run.started\ndata: ${JSON.stringify({
          id: `evt-${body.id}-started`,
          type: "run.started",
          ts: new Date().toISOString(),
          commandId: body.id,
          sessionId: "session-agent-1",
          payload: {
            sessionId: "session-agent-1",
            eventType: "user.message",
          },
        })}\n\n` +
          `event: run.completed\ndata: ${JSON.stringify({
            id: `evt-${body.id}-completed`,
            type: "run.completed",
            ts: new Date().toISOString(),
            commandId: body.id,
            runId: `run-${requests.length}`,
            sessionId: "session-agent-1",
            payload: {
              result: {
                assistantText: null,
                output: {
                  status: "COMPLETED",
                  sessionId: "session-agent-1",
                  runId: `run-${requests.length}`,
                  errors: [],
                },
              },
            },
          })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    },
  });

  const terminal = await agent.run(
    {
      sessionId: "session-agent-1",
      message: "hello",
    },
    context,
  );
  const resumed = await agent.resume(
    {
      sessionId: "session-agent-1",
      message: "continue",
    },
    context,
  );

  assert.equal(terminal.type, "run.completed");
  assert.equal(resumed.type, "run.completed");
  assert.equal((requests[0]?.payload as { profileId?: string })?.profileId, "support-profile");
  assert.equal((requests[1]?.payload as { profileId?: string })?.profileId, "support-profile");
  assert.equal(
    ((requests[1]?.payload as { turn?: { resumeBlockedRun?: boolean } })?.turn?.resumeBlockedRun),
    true,
  );
  await agent.close();
});

test("agent session memory reads and writes through task graph state", async () => {
  let storedMemory: KestrelMemorySnapshot = {
    goal: "Ship the release",
    currentPlan: "Write docs",
    findings: "",
    decisions: "",
    openQuestions: "",
    nextAction: "Publish",
    linkedArtifacts: ["docs/release.md"],
  };
  let lastGraphPayload: Record<string, unknown> | undefined;
  let version = 1;

  const agent = createAgent({
    id: "support",
    profileId: "support-profile",
    baseUrl: "http://runner.internal",
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.type === "session.state") {
        return new Response(
          JSON.stringify({
            id: `evt-${body.id}-session-state`,
            type: "session.state",
            ts: new Date().toISOString(),
            commandId: body.id,
            sessionId: "session-agent-1",
            threadId: "thread-agent-1",
            payload: {
              session: {
                sessionId: "session-agent-1",
                version,
                threadId: "thread-agent-1",
              },
              version,
              graph: {
                version: 1,
                rootTaskIds: ["task:thread:thread-agent-1"],
                tasks: {
                  "task:thread:thread-agent-1": {
                    id: "task:thread:thread-agent-1",
                    title: "Session root",
                    order: 0,
                    status: "active",
                    source: "thread",
                    proposedByAgent: false,
                    linkedSessionId: "session-agent-1",
                    linkedThreadId: "thread-agent-1",
                    activeThreadLineageId: "thread-agent-1",
                    runtime: {},
                    memory: storedMemory,
                    updatedAt: new Date().toISOString(),
                  },
                },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (body.type === "task.graph.update") {
        assert.equal((body.payload as { expectedVersion?: number }).expectedVersion, 1);
        lastGraphPayload = (body.payload as { graph?: Record<string, unknown> }).graph;
        const nextTask = ((lastGraphPayload?.tasks as Record<string, unknown>)?.["task:thread:thread-agent-1"] as {
          memory?: KestrelMemorySnapshot;
        } | undefined);
        storedMemory = nextTask?.memory ?? storedMemory;
        version = 2;
        return new Response(
          JSON.stringify({
            id: `evt-${body.id}-graph-updated`,
            type: "task.graph",
            ts: new Date().toISOString(),
            commandId: body.id,
            sessionId: "session-agent-1",
            threadId: "thread-agent-1",
            payload: {
              sessionId: "session-agent-1",
              version: 2,
              graph: lastGraphPayload,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected command ${(body.type as string) || "unknown"}.`);
    },
  });

  const before = await agent.session("session-agent-1").memory.get(context);
  const after = await agent.session("session-agent-1").memory.update(
    {
      expectedRevision: before.revision,
      patch: {
        findings: "The docs are complete.",
        linkedArtifacts: ["docs/release.md", "CHANGELOG.md"],
      },
    },
    context,
  );
  const session = await agent.session("session-agent-1").get(context);

  assert.equal(before.value.goal, "Ship the release");
  assert.equal(after.value.findings, "The docs are complete.");
  assert.deepEqual(after.value.linkedArtifacts, ["docs/release.md", "CHANGELOG.md"]);
  assert.equal(session.threadId, "thread-agent-1");
  assert.equal(session.memoryRevision, 2);
  assert.equal(session.memory.findings, "The docs are complete.");
  assert.deepEqual(
    ((lastGraphPayload?.tasks as Record<string, unknown>)?.["task:thread:thread-agent-1"] as {
      memory?: { findings?: string };
    } | undefined)?.memory?.findings,
    "The docs are complete.",
  );
  await agent.close();
});
