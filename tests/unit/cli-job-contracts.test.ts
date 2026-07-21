import assert from "node:assert/strict";

import type { TuiProfile } from "../../cli/contracts.js";
import { parseJobInputV1, type JobOutputV1 } from "../../cli/job/contracts.js";
import { RunnerHost, type RunnerRuntime } from "../../cli/runner/RunnerHost.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "parseJobInputV1 preserves turn metadata externalDeadlineMs", () => {
  const parsed = parseJobInputV1({
    version: "job_input_v1",
    turn: {
      sessionId: "session-deadline",
      message: "finish the task",
      eventType: "job.run",
      metadata: {
        externalDeadlineMs: 160_000,
      },
    },
  });

  assert.equal(parsed.turn.metadata?.externalDeadlineMs, 160_000);
});

contractTest("runtime.hermetic", "parseJobInputV1 preserves canonical turn mode fields", () => {
  const parsed = parseJobInputV1({
    version: "job_input_v1",
    turn: {
      sessionId: "session-build",
      message: "finish the task",
      eventType: "job.run",
      interactionMode: "build",
      actSubmode: "full_auto",
    },
  });

  assert.equal(parsed.turn.interactionMode, "build");
  assert.equal(parsed.turn.actSubmode, "full_auto");
});

contractTest("runtime.hermetic", "parseJobInputV1 rejects invalid turn mode fields", () => {
  assert.throws(
    () => parseJobInputV1({
      version: "job_input_v1",
      turn: {
        sessionId: "session-act",
        message: "finish the task",
        eventType: "job.run",
        interactionMode: "act",
      },
    }),
    /turn\.interactionMode must be one of chat, plan, build/u,
  );

  assert.throws(
    () => parseJobInputV1({
      version: "job_input_v1",
      turn: {
        sessionId: "session-submode",
        message: "finish the task",
        eventType: "job.run",
        interactionMode: "build",
        actSubmode: "full-auto",
      },
    }),
    /turn\.actSubmode must be one of strict, safe, full_auto/u,
  );
});

contractTest("runtime.hermetic", "job output can carry wait continuation details", () => {
  const output: JobOutputV1 = {
    version: "job_output_v1",
    terminalEventType: "job.completed",
    job: {
      version: "job_run_result_v1",
      sessionId: "session-waiting",
      threadId: "thread-waiting",
      runId: "run-waiting",
      status: "WAITING",
      waitFor: {
        kind: "user",
        eventType: "user.reply",
        metadata: {
          reason: "max_model_calls_continuation",
        },
      },
      result: {
        assistantText: null,
        output: {
          status: "WAITING",
          sessionId: "session-waiting",
          runId: "run-waiting",
          waitFor: {
            kind: "user",
            eventType: "user.reply",
            metadata: {
              reason: "max_model_calls_continuation",
            },
          },
          quality: {
            citationCoverage: 0,
            unresolvedClaims: 0,
            reworkRate: 0,
            thrashIndex: 0,
          },
          errors: [],
          telemetry: {
            stepsExecuted: 0,
            toolCalls: 0,
            modelCalls: 0,
            durationMs: 0,
          },
        },
      },
      replay: {
        version: "job_replay_pointer_v1",
        sessionId: "session-waiting",
        threadId: "thread-waiting",
        runId: "run-waiting",
        replayQuery: {
          sessionId: "session-waiting",
          threadId: "thread-waiting",
          runId: "run-waiting",
        },
        commands: {
          replay: "kestrel runtime replay --run-id run-waiting",
          doctor: "kestrel runtime doctor --run-id run-waiting",
          bundle: "kestrel runtime bundle --run-id run-waiting --out <bundle.json>",
        },
      },
    },
  };

  assert.equal(output.job.waitFor?.eventType, "user.reply");
  assert.equal(output.job.waitFor?.metadata?.reason, "max_model_calls_continuation");
});

contractTest("runtime.hermetic", "RunnerHost preserves waitFor in job completed output", async () => {
  const events: Array<{ type: string; payload: unknown }> = [];
  const runtime: RunnerRuntime = {
    async close() {},
    async runTurn(input) {
      return {
        assistantText: null,
        output: {
          status: "WAITING",
          sessionId: input.sessionId,
          runId: "run-waiting",
          waitFor: {
            kind: "user",
            eventType: "user.reply",
            metadata: {
              reason: "max_model_calls_continuation",
            },
          },
          quality: {
            citationCoverage: 0,
            unresolvedClaims: 0,
            reworkRate: 0,
            thrashIndex: 0,
          },
          errors: [],
          telemetry: {
            stepsExecuted: 0,
            toolCalls: 0,
            modelCalls: 0,
            durationMs: 0,
          },
        },
      };
    },
  };
  const host = new RunnerHost(
    {
      emit(type, payload) {
        events.push({ type, payload });
      },
    },
    () => runtime,
  );
  const profile: TuiProfile = {
    id: "job-wait-profile",
    label: "Job Wait Profile",
    agent: "reference-react",
    sessionPrefix: "job-wait",
  };

  await host.jobRun("cmd-job-wait", {
    input: {
      version: "job_input_v1",
      profile,
      turn: {
        sessionId: "session-waiting",
        message: "continue",
        eventType: "job.run",
      },
    },
  });
  await host.close();

  const completed = events.find((event) => event.type === "job.completed");
  assert.ok(completed);
  const payload = completed.payload as { output: { waitFor?: { eventType?: string; metadata?: { reason?: string } } } };
  assert.equal(payload.output.waitFor?.eventType, "user.reply");
  assert.equal(payload.output.waitFor?.metadata?.reason, "max_model_calls_continuation");
});
