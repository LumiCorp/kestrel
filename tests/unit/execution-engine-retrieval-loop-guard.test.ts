import test from "node:test";
import assert from "node:assert/strict";

import { Kestrel } from "../../src/kestrel/Kestrel.js";
import type { ModelRequest } from "../../src/kestrel/contracts/model-io.js";

import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import { GuardrailViolationError } from "../../src/engine/Guardrails.js";
import {
  BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS,
  BROAD_RESUME_MAX_INVENTORY_ACTIONS,
} from "../../src/runtime/filesystemResumeBudget.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";

test("ExecutionEngine no longer auto-resumes on filesystem loop guard in act.full_auto", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 30,
      maxStepVisits: 30,
    },
  });

  kestrel.registerStep("bootstrap", async () => ({
    status: "RUNNING",
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        interactionMode: "build",
        actSubmode: "full_auto",
        nextAction: {
          kind: "tool",
          name: "fs.read_text",
          input: {
            path: "src/App.jsx",
          },
        },
        capabilityEvidence: {
          "filesystem.read": {
            tool: "fs.read_text",
            stepIndex: 1,
          },
        },
        postToolVerification: {
          evidenceRecoverySummary: {
            filesystemInspection: {
              inventoryActions: BROAD_RESUME_MAX_INVENTORY_ACTIONS,
              groundedReadActions: BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS,
              budgetExhausted: true,
              inventoryPaths: [".", "src", "src/App.jsx"],
            },
          },
        },
        observations: [],
      },
    },
  }));

  kestrel.registerStep("agent.loop", async () => {
    throw new GuardrailViolationError(
      "LOOP_GUARD_TRIGGERED",
      "Thread is thrashing and should compact before more work continues.",
      {
        guardType: "NO_PROGRESS_REASONING_LOOP",
        retrievalFamily: "filesystem.read_like",
        repeats: BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS,
      },
    );
  });

  const output = await kestrel.run({
    id: "evt-loop-guard-full-auto-auto-resume",
    type: "user.message",
    sessionId: "session-loop-guard-full-auto-auto-resume",
    payload: {
      message: "Keep going",
    },
    stepAgent: "bootstrap",
  });

  assert.equal(output.status, "FAILED");
  assert.equal(output.errors[0]?.code, "LOOP_GUARD_TRIGGERED");
  assert.equal(output.waitFor, undefined);
});

test("ExecutionEngine does not prompt for broad filesystem clarification in safe mode", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 30,
      maxStepVisits: 30,
    },
  });

  kestrel.registerStep("bootstrap", async () => ({
    status: "RUNNING",
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        interactionMode: "build",
        actSubmode: "safe",
        goal: "Create a time travel rental website",
        toolIntent: {
          version: "v1",
          toolUseIntent: "single",
          objective: "Create a time travel rental website",
          candidateTools: ["fs.read_text"],
          confidence: 0.91,
          workflowIntent: {
            kind: "coding_change",
          },
        },
        nextAction: {
          kind: "tool",
          name: "fs.read_text",
          input: {
            path: "src/App.jsx",
          },
        },
        postToolVerification: {
          evidenceRecoverySummary: {
            filesystemInspection: {
              inventoryActions: BROAD_RESUME_MAX_INVENTORY_ACTIONS + 2,
              groundedReadActions: 1,
              budgetExhausted: true,
              inventoryPaths: [".", "src", "src/App.jsx"],
            },
          },
        },
        observations: [],
      },
    },
  }));

  kestrel.registerStep("agent.loop", async () => {
    throw new GuardrailViolationError(
      "LOOP_GUARD_TRIGGERED",
      "Thread is thrashing and should compact before more work continues.",
      {
        guardType: "NO_PROGRESS_REASONING_LOOP",
        retrievalFamily: "filesystem.read_like",
        repeats: BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS,
      },
    );
  });

  const output = await kestrel.run({
    id: "evt-loop-guard-safe-clarification",
    type: "user.message",
    sessionId: "session-loop-guard-safe-clarification",
    payload: {
      message: "Keep going",
    },
    stepAgent: "bootstrap",
  });

  assert.equal(output.status, "FAILED");
  assert.equal(output.errors[0]?.code, "LOOP_GUARD_TRIGGERED");
  assert.equal(output.waitFor, undefined);
});

test("ExecutionEngine exits before filesystem clarification when loop guard metadata omits retrievalFamily", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 30,
      maxStepVisits: 30,
    },
  });

  kestrel.registerStep("bootstrap", async () => ({
    status: "RUNNING",
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        interactionMode: "build",
        actSubmode: "safe",
        goal: "Repair a time machine booking bug",
        nextAction: {
          kind: "tool",
          name: "fs.search_text",
          input: {
            path: "src/App.jsx",
          },
        },
        postToolVerification: {
          evidenceRecoverySummary: {
            filesystemInspection: {
              inventoryActions: BROAD_RESUME_MAX_INVENTORY_ACTIONS,
              groundedReadActions: BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS,
              budgetExhausted: true,
              inventoryPaths: [".", "src", "src/App.jsx"],
            },
          },
        },
        observations: [],
      },
    },
  }));

  kestrel.registerStep("agent.loop", async () => {
    throw new GuardrailViolationError(
      "LOOP_GUARD_TRIGGERED",
      "Thread is thrashing and should compact before more work continues.",
      {
        guardType: "NO_PROGRESS_REASONING_LOOP",
        repeats: BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS,
      },
    );
  });

  const output = await kestrel.run({
    id: "evt-loop-guard-safe-clarification-missing-family",
    type: "user.message",
    sessionId: "session-loop-guard-safe-clarification-missing-family",
    payload: {
      message: "Keep going",
    },
    stepAgent: "bootstrap",
  });

  assert.equal(output.status, "FAILED");
  assert.equal(output.errors[0]?.code, "LOOP_GUARD_TRIGGERED");
  assert.equal(output.waitFor, undefined);
});

test("ExecutionEngine no longer blocks on filesystem loop-guard clarification to wait for continue", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 30,
      maxStepVisits: 30,
    },
  });
  kestrel.registerStep("bootstrap", async () => ({
    status: "RUNNING",
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        interactionMode: "build",
        actSubmode: "safe",
        goal: "Resolve the indexing regression",
        nextAction: {
          kind: "tool",
          name: "fs.read_text",
          input: {
            path: "src/index.html",
          },
        },
        postToolVerification: {
          evidenceRecoverySummary: {
            filesystemInspection: {
              inventoryActions: BROAD_RESUME_MAX_INVENTORY_ACTIONS,
              groundedReadActions: BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS,
              budgetExhausted: true,
              inventoryPaths: [".", "src", "src/index.html"],
            },
          },
        },
        observations: [],
      },
    },
  }));

  kestrel.registerStep("agent.loop", async () => {
    throw new GuardrailViolationError(
      "LOOP_GUARD_TRIGGERED",
      "Thread is thrashing and should compact before more work continues.",
      {
        guardType: "NO_PROGRESS_REASONING_LOOP",
        retrievalFamily: "filesystem.read_like",
        repeats: BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS,
      },
    );
  });

  const clarificationOutput = await kestrel.run({
    id: "evt-loop-guard-clarification-continue-start",
    type: "user.message",
    sessionId: "session-loop-guard-clarification-continue",
    payload: {
      message: "Keep going",
    },
    stepAgent: "bootstrap",
  });

  assert.equal(clarificationOutput.status, "FAILED");
  assert.equal(clarificationOutput.errors[0]?.code, "LOOP_GUARD_TRIGGERED");
  assert.equal(clarificationOutput.waitFor, undefined);
  assert.equal(store.getRunEvents().findIndex((event) => event.type === "run.continuation_requested"), -1);
});

test("ExecutionEngine no longer blocks on filesystem loop-guard clarification to wait for a file name", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 30,
      maxStepVisits: 30,
    },
  });
  kestrel.registerStep("bootstrap", async () => ({
    status: "RUNNING",
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        interactionMode: "build",
        actSubmode: "safe",
        goal: "Resolve the auth callback bug",
        nextAction: {
          kind: "tool",
          name: "fs.read_text",
          input: {
            path: "src/routes.tsx",
          },
        },
        postToolVerification: {
          evidenceRecoverySummary: {
            filesystemInspection: {
              inventoryActions: BROAD_RESUME_MAX_INVENTORY_ACTIONS,
              groundedReadActions: BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS,
              budgetExhausted: true,
              inventoryPaths: [".", "src", "src/callback.tsx"],
            },
          },
        },
        observations: [],
      },
    },
  }));

  kestrel.registerStep("agent.loop", async () => {
    throw new GuardrailViolationError(
      "LOOP_GUARD_TRIGGERED",
      "Thread is thrashing and should compact before more work continues.",
      {
        guardType: "NO_PROGRESS_REASONING_LOOP",
        retrievalFamily: "filesystem.read_like",
        repeats: BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS,
      },
    );
  });

  const clarificationOutput = await kestrel.run({
    id: "evt-loop-guard-clarification-file-start",
    type: "user.message",
    sessionId: "session-loop-guard-clarification-file",
    payload: {
      message: "Keep going",
    },
    stepAgent: "bootstrap",
  });

  assert.equal(clarificationOutput.status, "FAILED");
  assert.equal(clarificationOutput.errors[0]?.code, "LOOP_GUARD_TRIGGERED");
  assert.equal(clarificationOutput.waitFor, undefined);
});

test("ExecutionEngine continues unattended concrete repair instead of user clarification", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 80,
      maxStepVisits: 80,
    },
  });
  const repairEvidence = {
    id: "ev_repair",
    kind: "tool_result",
    status: "inconclusive",
    summary: "No occurrences matched; file was not changed.",
    targetType: "path",
    targetValue: "/app/maze_controller.py",
    requiresAction: "repair_or_choose_new_action",
    blocks: "/app/maze_controller.py",
  };
  let loopCalls = 0;
  let dispatchCalls = 0;
  let repaired = false;

  kestrel.registerStep("bootstrap", async () => ({
    status: "RUNNING",
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        interactionMode: "build",
        actSubmode: "safe",
        goal: "Repair the controller and write the requested artifact.",
        evidenceLedger: [repairEvidence],
        nextAction: {
          kind: "tool",
          name: "fs.read_text",
          input: {
            path: "/app/maze_controller.py",
          },
        },
        observations: [],
      },
    },
  }));

  kestrel.registerStep("agent.loop", async () => {
    loopCalls += 1;
    if (repaired) {
      return {
        status: "COMPLETED",
        nextStepAgent: "agent.loop",
        statePatch: {
          agent: {
            interactionMode: "build",
            actSubmode: "safe",
            goal: "Repair the controller and write the requested artifact.",
            evidenceLedger: [repairEvidence],
            nextAction: {
              kind: "finalize",
              status: "goal_satisfied",
              message: "Recovered from concrete repair continuation.",
            },
            observations: [],
          },
        },
      };
    }
    throw new GuardrailViolationError(
      "LOOP_GUARD_TRIGGERED",
      "Thread is thrashing while a concrete controller repair is available.",
      {
        guardType: "NO_PROGRESS_REASONING_LOOP",
        retrievalFamily: "filesystem.read_like",
        repeats: BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS,
      },
    );
  });

  kestrel.registerStep("agent.exec.dispatch", async () => {
    dispatchCalls += 1;
    repaired = true;
    return {
      status: "RUNNING",
      nextStepAgent: "agent.loop",
      statePatch: {
        agent: {
          interactionMode: "build",
          actSubmode: "safe",
          goal: "Repair the controller and write the requested artifact.",
          evidenceLedger: [repairEvidence],
          nextAction: {
            kind: "tool",
            name: "fs.read_text",
            input: {
              path: "/app/maze_controller.py",
            },
          },
          lastActionResult: {
            kind: "tool_result",
            status: "ok",
            toolName: "fs.read_text",
            output: {
              path: "/app/maze_controller.py",
              text: "from pathlib import Path\n",
            },
          },
          observations: [],
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-loop-guard-concrete-repair",
    type: "job.run",
    sessionId: "session-loop-guard-concrete-repair",
    payload: {
      message: "Repair the controller without user input.",
    },
    stepAgent: "bootstrap",
  });

  assert.equal(output.status, "COMPLETED");
  assert.notEqual(output.waitFor?.eventType, "user.reply");
  assert.equal(loopCalls, 2);
  assert.equal(dispatchCalls, 1);
  const continuationEvent = store.getRunEvents().find((event) =>
    event.type === "clarification.triggered" &&
    event.metadata?.sourceReason === "concrete_repair_evidence"
  );
  assert.equal(continuationEvent?.metadata?.reason, "concrete_repair_continuation");
  assert.equal(continuationEvent?.metadata?.targetPath, "/app/maze_controller.py");
});

test("ExecutionEngine finalizes best-effort after repeated redundant retrieval pivots", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() =>
      "FC Cincinnati's latest verified evidence points to the club schedule and news pages: https://www.fccincinnati.com/schedule and https://www.fccincinnati.com/news." as T
    ),
    guardrails: {
      maxStepsPerRun: 200,
      maxStepVisits: 200,
    },
  });

  kestrel.registerStep("agent.loop", async (ctx) => {
    const cycle = typeof ctx.session.state.cycle === "number" ? (ctx.session.state.cycle as number) : 0;
    const nextTool = cycle % 2 === 0 ? "internet.search" : "internet.news";
    const react = ctx.session.state.agent as Record<string, unknown> | undefined;
    return {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
      statePatch: {
        cycle: cycle + 1,
        agent: {
          dispatchSequence: typeof react?.dispatchSequence === "number"
            ? (react.dispatchSequence as number)
            : 0,
          goal: "Find FC Cincinnati exact record and next 3 games from today",
          toolIntent: {
            version: "v1",
            toolUseIntent: "single",
            objective: "Find FC Cincinnati exact record and next 3 games from today",
            candidateTools: ["internet.search", "internet.news"],
            confidence: 0.9,
            workflowIntent: {
              kind: "research",
            },
          },
          nextAction: {
            kind: "tool",
            name: nextTool,
            input: {
              query: "FC Cincinnati exact record and next 3 games from today",
            },
          },
          capabilityEvidence: {},
          observations: [
            {
              summary: `Loop cycle ${cycle + 1}`,
              goalMet: false,
            },
          ],
        },
      },
    };
  });

  kestrel.registerStep("agent.exec.dispatch", async (ctx) => {
    const react = ctx.session.state.agent as Record<string, unknown> | undefined;
    const nextAction = react?.nextAction as Record<string, unknown> | undefined;
    const toolName = typeof nextAction?.name === "string" ? nextAction.name : "internet.search";
    const dispatchSequence = typeof react?.dispatchSequence === "number"
      ? (react.dispatchSequence as number)
      : 0;
    return {
      status: "RUNNING",
      nextStepAgent: "agent.loop",
      statePatch: {
        agent: {
          ...((react ?? {}) as Record<string, unknown>),
          dispatchSequence: dispatchSequence + 1,
          goal: typeof react?.goal === "string" ? react.goal : "Find FC Cincinnati exact record and next 3 games from today",
          capabilityEvidence: {
            retrieval: {
              tool: toolName,
              stepIndex: dispatchSequence + 1,
            },
          },
	          lastActionResult: {
	            toolName,
	            results: [
	              {
	                title: "FC Cincinnati schedule",
	                url: "https://www.fccincinnati.com/schedule",
              },
              {
                title: "FC Cincinnati news",
                url: "https://www.fccincinnati.com/news",
	              },
	            ],
	          },
	          postToolVerification: {
	            evidenceRecoverySummary: {
	              objectiveKey: "Find FC Cincinnati exact record and next 3 games from today",
	              family: "web_research",
	              attempts: dispatchSequence + 1,
	              lowSignalAttempts: 0,
	              consecutiveLowSignal: 0,
	              broadenedSearchUsed: false,
	              targetedFetchUsed: false,
	              latest: {
	                family: "web_research",
	                toolName,
	                quality: "high",
	                lowSignal: false,
	                issues: [],
	                resultsCount: 2,
	                domainDiversity: 1,
	                payloadFingerprint: "fc-cincinnati-repeat",
	                repeatedFingerprintCount: 1,
	                candidateUrls: [
	                  "https://www.fccincinnati.com/schedule",
	                  "https://www.fccincinnati.com/news",
	                ],
	              },
	            },
	            webExtractionRetrySummary: {
	              objectiveKey: "Find FC Cincinnati exact record and next 3 games from today",
	              searchFallbackUsed: false,
	              clusters: [],
	            },
	          },
	        },
	      },
	    };
	  });

  const output = await kestrel.run({
    id: "evt-retrieval-loop-guard",
    type: "user.message",
    sessionId: "session-retrieval-loop-guard",
    payload: {
      message: "What is FC Cincinnati's exact record and next 3 games from today?",
    },
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(output.errors.length, 0);

  const session = await store.getSession("session-retrieval-loop-guard");
  const react = (session?.state.agent ?? {}) as Record<string, unknown>;
  const terminal = (react.terminal ?? {}) as Record<string, unknown>;
  const finalOutput = (react.finalOutput ?? {}) as Record<string, unknown>;
  const finalData = (finalOutput.data ?? {}) as Record<string, unknown>;

  assert.equal(terminal.reasonCode, "goal_satisfied");
  assert.notEqual(finalData.researchStalled, true);
  assert.equal(
    finalData.retrievalToolFamily,
    "internet.search_like",
  );
  assert.equal(finalData.lowSignalState, "none");
  assert.equal(finalData.objective, "Find FC Cincinnati exact record and next 3 games from today");
  assert.equal(finalData.stallKind, "redundant_retrieval");
  assert.equal(finalData.guardType, "REPEATED_REDUNDANT_RETRIEVAL_PIVOT");
  assert.match(String(finalData.guardToolName ?? ""), /^internet\./u);
  assert.equal(finalData.guardRepeats, 3);
  assert.equal(finalData.guardThreshold, 3);
  assert.equal(finalData.verifiedEvidenceAvailable, true);
  assert.doesNotMatch(String(finalOutput.message ?? ""), /low-yield|Next if you want me to continue/u);
  assert.match(String(finalOutput.message ?? ""), /FC Cincinnati/u);
  assert.match(String(finalOutput.message ?? ""), /fccincinnati\.com\/schedule/u);
  assert.equal(
    store.getRunEvents().some((event) =>
      event.type === "loop.guard_triggered" &&
      (event.metadata as Record<string, unknown> | undefined)?.details !== undefined
    ),
    true,
  );
});

test("ExecutionEngine resumes coding work after verified redundant retrieval instead of synthesizing completion", async () => {
  const store = new InMemorySessionStore();
  let modelCalls = 0;
  let dispatchCalls = 0;
  let loopCalls = 0;
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => {
      modelCalls += 1;
      return "This synthesis should not be used for coding workflows." as T;
    }),
    guardrails: {
      maxStepsPerRun: 200,
      maxStepVisits: 200,
    },
  });

  kestrel.registerStep("agent.loop", async (ctx) => {
    loopCalls += 1;
    const react = ctx.session.state.agent as Record<string, unknown> | undefined;
    const observations = Array.isArray(react?.observations) ? react.observations : [];
    const resumedFromVerifiedRetrieval = observations.some((entry) => {
      const record = entry as Record<string, unknown> | undefined;
      return typeof record?.summary === "string" &&
        record.summary.includes("Verified retrieval evidence is already available.");
    });
    if (resumedFromVerifiedRetrieval) {
      return {
        status: "COMPLETED",
        nextStepAgent: "agent.loop",
        statePatch: {
          agent: {
            ...((react ?? {}) as Record<string, unknown>),
            nextAction: {
              kind: "finalize",
              status: "goal_satisfied",
              message: "Continued the coding workflow after verified retrieval evidence was available.",
            },
            observations,
          },
        },
      };
    }

    const dispatchSequence = typeof react?.dispatchSequence === "number"
      ? (react.dispatchSequence as number)
      : 0;
    const nextTool = dispatchSequence % 2 === 0 ? "internet.news" : "internet.search_advanced";
    return {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
      statePatch: {
        agent: {
          ...((react ?? {}) as Record<string, unknown>),
          dispatchSequence,
          goal: "Build the requested newsletter app from verified news research.",
          visibleTodos: {
            objective: "Build the requested newsletter app from verified news research.",
            items: [
              {
                id: "research-news",
                text: "Collect verified news research",
                status: "done",
              },
              {
                id: "build-newsletter",
                text: "Build and verify the newsletter app",
                status: "in_progress",
              },
            ],
          },
          toolIntent: {
            version: "v1",
            toolUseIntent: "single",
            objective: "Build the requested newsletter app from verified news research.",
            candidateTools: ["internet.news", "internet.search_advanced", "fs.write_text"],
            confidence: 0.91,
            workflowIntent: {
              kind: "research",
            },
          },
          nextAction: {
            kind: "tool",
            name: nextTool,
            input: {
              query: "top U.S. business and technology stories today",
            },
          },
          capabilityEvidence: {},
          observations: [
            {
              summary: `Loop cycle ${dispatchSequence + 1}`,
              goalMet: false,
            },
          ],
        },
      },
    };
  });

  kestrel.registerStep("agent.exec.dispatch", async (ctx) => {
    dispatchCalls += 1;
    const react = ctx.session.state.agent as Record<string, unknown> | undefined;
    const nextAction = react?.nextAction as Record<string, unknown> | undefined;
    const toolName = typeof nextAction?.name === "string" ? nextAction.name : "internet.news";
    const dispatchSequence = typeof react?.dispatchSequence === "number"
      ? (react.dispatchSequence as number)
      : 0;
    return {
      status: "RUNNING",
      nextStepAgent: "agent.loop",
      statePatch: {
        agent: {
          ...((react ?? {}) as Record<string, unknown>),
          dispatchSequence: dispatchSequence + 1,
          capabilityEvidence: {
            retrieval: {
              tool: toolName,
              stepIndex: dispatchSequence + 1,
            },
          },
          lastActionResult: {
            kind: "tool",
            toolName,
            status: "ok",
            output: {
              results: [
                {
                  title: "AI leaders race to IPO after Nvidia earnings",
                  url: "https://www.cnbc.com/2026/05/21/cnbc-daily-open-nvidia-posts-strong-quarter-ai-leaders-race-to-ipo-.html",
                  source: "CNBC",
                },
                {
                  title: "SpaceX IPO case strengthens after Starship test",
                  url: "https://www.reuters.com/business/aerospace-defense/spacexs-starship-test-strengthens-ipo-case-though-hurdles-remain-2026-05-27/",
                  source: "Reuters",
                },
              ],
            },
          },
          postToolVerification: {
            evidenceRecoverySummary: {
              objectiveKey: "build the requested newsletter app from verified news research",
              family: "web_research",
              attempts: dispatchSequence + 1,
              lowSignalAttempts: 0,
              consecutiveLowSignal: 0,
              broadenedSearchUsed: false,
              targetedFetchUsed: false,
              latest: {
                family: "web_research",
                toolName,
                quality: "high",
                lowSignal: false,
                issues: [],
                resultsCount: 2,
                domainDiversity: 2,
                payloadFingerprint: "newsletter-verified-repeat",
                repeatedFingerprintCount: 1,
                candidateUrls: [
                  "https://www.cnbc.com/2026/05/21/cnbc-daily-open-nvidia-posts-strong-quarter-ai-leaders-race-to-ipo-.html",
                  "https://www.reuters.com/business/aerospace-defense/spacexs-starship-test-strengthens-ipo-case-though-hurdles-remain-2026-05-27/",
                ],
              },
            },
            webExtractionRetrySummary: {
              objectiveKey: "build the requested newsletter app from verified news research",
              searchFallbackUsed: false,
              clusters: [],
            },
          },
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-verified-retrieval-coding-continuation",
    type: "user.message",
    sessionId: "session-verified-retrieval-coding-continuation",
    payload: {
      message: "Build the requested newsletter app from verified news research.",
      interactionMode: "build",
    },
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "COMPLETED");
  assert.ok(modelCalls >= 0);
  assert.ok(dispatchCalls >= 1);
  assert.ok(loopCalls >= 2);

  const continuationEvent = store.getRunEvents().find((event) =>
    event.type === "loop.stall_resumed" &&
    (event.metadata as Record<string, unknown> | undefined)?.reason === "verified_retrieval_continuation"
  );
  assert.notEqual(continuationEvent, undefined);
  assert.equal((continuationEvent?.metadata as Record<string, unknown> | undefined)?.guardToolName !== undefined, true);
});

test("ExecutionEngine resumes build-mode workspace work after verified redundant retrieval even without a work plan", async () => {
  const store = new InMemorySessionStore();
  let loopCalls = 0;
  let dispatchCalls = 0;
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ("This synthesis would prematurely complete the build task." as T)),
    guardrails: {
      maxStepsPerRun: 200,
      maxStepVisits: 200,
    },
  });

  kestrel.registerStep("agent.loop", async (ctx) => {
    loopCalls += 1;
    const react = ctx.session.state.agent as Record<string, unknown> | undefined;
    const observations = Array.isArray(react?.observations) ? react.observations : [];
    const resumedFromVerifiedRetrieval = observations.some((entry) => {
      const record = entry as Record<string, unknown> | undefined;
      return typeof record?.summary === "string" &&
        record.summary.includes("Verified retrieval evidence is already available.");
    });
    if (resumedFromVerifiedRetrieval) {
      return {
        status: "COMPLETED",
        nextStepAgent: "agent.loop",
        statePatch: {
          agent: {
            ...((react ?? {}) as Record<string, unknown>),
            nextAction: {
              kind: "finalize",
              status: "goal_satisfied",
              message: "Continued the build workflow after verified retrieval evidence was available.",
            },
            observations,
          },
        },
      };
    }

    const dispatchSequence = typeof react?.dispatchSequence === "number"
      ? (react.dispatchSequence as number)
      : 0;
    return {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
      statePatch: {
        agent: {
          ...((react ?? {}) as Record<string, unknown>),
          interactionMode: "build",
          dispatchSequence,
          goal:
            "Create a Next.js newsletter app from verified news research, write newsletter-report.json, implement the page, and run validation.",
          toolIntent: {
            version: "v1",
            toolUseIntent: "single",
            objective:
              "Create a Next.js newsletter app from verified news research, write newsletter-report.json, implement the page, and run validation.",
            candidateTools: ["internet.news", "internet.search_advanced", "fs.write_text", "dev.shell.run"],
            confidence: 0.91,
            workflowIntent: {
              kind: "research",
            },
          },
          nextAction: {
            kind: "tool",
            name: "internet.news",
            input: {
              query: "top U.S. business and technology stories today",
            },
          },
          capabilityEvidence: {},
          observations: [
            {
              summary: `Loop cycle ${dispatchSequence + 1}`,
              goalMet: false,
            },
          ],
        },
      },
    };
  });

  kestrel.registerStep("agent.exec.dispatch", async (ctx) => {
    dispatchCalls += 1;
    const react = ctx.session.state.agent as Record<string, unknown> | undefined;
    const dispatchSequence = typeof react?.dispatchSequence === "number"
      ? (react.dispatchSequence as number)
      : 0;
    return {
      status: "RUNNING",
      nextStepAgent: "agent.loop",
      statePatch: {
        agent: {
          ...((react ?? {}) as Record<string, unknown>),
          dispatchSequence: dispatchSequence + 1,
          capabilityEvidence: {
            retrieval: {
              tool: "internet.news",
              stepIndex: dispatchSequence + 1,
            },
          },
          lastActionResult: {
            kind: "tool",
            toolName: "internet.news",
            status: "ok",
            output: {
              results: [
                {
                  title: "AI leaders race to IPO after Nvidia earnings",
                  url: "https://www.cnbc.com/2026/05/21/cnbc-daily-open-nvidia-posts-strong-quarter-ai-leaders-race-to-ipo-.html",
                  source: "CNBC",
                },
                {
                  title: "SpaceX IPO case strengthens after Starship test",
                  url: "https://www.reuters.com/business/aerospace-defense/spacexs-starship-test-strengthens-ipo-case-though-hurdles-remain-2026-05-27/",
                  source: "Reuters",
                },
              ],
            },
          },
          postToolVerification: {
            evidenceRecoverySummary: {
              objectiveKey:
                "create a next.js newsletter app from verified news research, write newsletter-report.json, implement the page, and run validation",
              family: "web_research",
              attempts: dispatchSequence + 1,
              lowSignalAttempts: 0,
              consecutiveLowSignal: 0,
              broadenedSearchUsed: false,
              targetedFetchUsed: false,
              latest: {
                family: "web_research",
                toolName: "internet.news",
                quality: "high",
                lowSignal: false,
                issues: [],
                resultsCount: 2,
                domainDiversity: 2,
                payloadFingerprint: "newsletter-build-verified-repeat",
                repeatedFingerprintCount: 1,
                candidateUrls: [
                  "https://www.cnbc.com/2026/05/21/cnbc-daily-open-nvidia-posts-strong-quarter-ai-leaders-race-to-ipo-.html",
                  "https://www.reuters.com/business/aerospace-defense/spacexs-starship-test-strengthens-ipo-case-though-hurdles-remain-2026-05-27/",
                ],
              },
            },
            webExtractionRetrySummary: {
              objectiveKey:
                "create a next.js newsletter app from verified news research, write newsletter-report.json, implement the page, and run validation",
              searchFallbackUsed: false,
              clusters: [],
            },
          },
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-build-mode-verified-retrieval-continuation",
    type: "user.message",
    sessionId: "session-build-mode-verified-retrieval-continuation",
    payload: {
      message:
        "Create a Next.js newsletter app from verified news research, write newsletter-report.json, implement the page, and run validation.",
      interactionMode: "build",
      workspace: {
        workspaceRoot: "/tmp/newsletter-app",
        managedWorktreeRequired: false,
      },
    },
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "COMPLETED");
  assert.ok(dispatchCalls >= 1);
  assert.ok(loopCalls >= 2);

  const continuationEvent = store.getRunEvents().find((event) =>
    event.type === "loop.stall_resumed" &&
    (event.metadata as Record<string, unknown> | undefined)?.reason === "verified_retrieval_continuation"
  );
  assert.notEqual(continuationEvent, undefined);

  const session = await store.getSession("session-build-mode-verified-retrieval-continuation");
  const finalOutput = ((session?.state.agent as Record<string, unknown> | undefined)?.finalOutput ?? {}) as Record<
    string,
    unknown
  >;
  assert.doesNotMatch(String(finalOutput.message ?? ""), /prematurely complete/u);
});

test("ExecutionEngine reports redundant retrieval accurately after high-quality news evidence", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() =>
      "Trump's China visit evidence is ready to synthesize: AP reported current coverage of the trip, including Trump-Xi trade and diplomacy updates, with source URLs from the collected news results." as T
    ),
    guardrails: {
      maxStepsPerRun: 20,
      maxStepVisits: 20,
    },
  });

  await store.ensureSession("session-news-redundant-retrieval-regression", "agent.loop");
  await store.commitStep({
    runId: "seed-news-redundant-retrieval-regression",
    event: {
      id: "seed-news-redundant-retrieval-regression",
      type: "user.message",
      sessionId: "session-news-redundant-retrieval-regression",
      payload: {
        message: "give me the latest news on Trump's visit to China",
      },
    },
    sessionId: "session-news-redundant-retrieval-regression",
    expectedVersion: 0,
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        goal: "give me the latest news on Trump's visit to China",
        toolIntent: {
          version: "v1",
          toolUseIntent: "single",
          objective: "give me the latest news on Trump's visit to China",
          candidateTools: ["internet.news"],
          confidence: 0.9,
          workflowIntent: {
            kind: "research",
          },
        },
        nextAction: {
          kind: "tool",
          name: "internet.news",
          input: {
            query: "Trump visit to China latest news",
            region: "us",
            freshness: "1d",
            limit: 5,
          },
        },
        lastActionResult: {
          kind: "tool",
          toolName: "internet.news",
          status: "ok",
          results: [
            {
              title: "Takeaways from Trump's trip to China",
              url: "https://apnews.com/article/trump-xi-china-trade-iran-taiwan-f6c59000412653e445acbf9672ac7f47",
              source: "apnews.com",
            },
            {
              title: "Trump insists US-China relations are in a good place",
              url: "https://apnews.com/article/trump-xi-taiwan-iran-trade-e7a3cdf161c608de152ac1c6e5755452",
              source: "apnews.com",
            },
          ],
        },
        postToolVerification: {
          evidenceRecoverySummary: {
            objectiveKey: "give me the latest news on trump's visit to china",
            family: "web_research",
            attempts: 3,
            duplicateEvents: 3,
            lowSignalAttempts: 0,
            consecutiveLowSignal: 0,
            broadenedSearchUsed: false,
            targetedFetchUsed: false,
            latest: {
              family: "web_research",
              toolName: "internet.news",
              quality: "high",
              lowSignal: false,
              issues: [],
              resultsCount: 5,
              domainDiversity: 1,
              payloadFingerprint: "trump-china-ap-repeat",
              repeatedFingerprintCount: 1,
              candidateUrls: [
                "https://apnews.com/article/trump-xi-china-trade-iran-taiwan-f6c59000412653e445acbf9672ac7f47",
                "https://apnews.com/article/trump-xi-taiwan-iran-trade-e7a3cdf161c608de152ac1c6e5755452",
              ],
            },
          },
          webExtractionRetrySummary: {
            objectiveKey: "give me the latest news on trump's visit to china",
            searchFallbackUsed: false,
            clusters: [],
          },
        },
        capabilityEvidence: {
          "news.search": {
            tool: "internet.news",
            stepIndex: 5,
          },
          "web.search": {
            tool: "internet.news",
            stepIndex: 5,
          },
        },
        observations: [
          {
            summary: "Used internet.news and found current AP reporting on the China visit.",
            goalMet: false,
          },
        ],
        loopGuard: {
          history: [
            {
              stepName: "agent.loop",
              fingerprint: "{\"stepName\":\"agent.loop\",\"attempt\":1}",
              evidenceHash: "{\"capabilities\":[\"news.search\",\"web.search\"],\"lastActionResultKind\":\"tool\",\"lastActionResultStatus\":\"ok\",\"lastActionTool\":\"internet.news\"}",
              actionSignature: "{\"kind\":\"tool\",\"name\":\"internet.news\"}",
              observationMarker: "",
              cycleKind: "reasoning",
              waitToken: "",
              pendingExecutionHash: "{\"exec\":{}}",
            },
            {
              stepName: "agent.loop",
              fingerprint: "{\"stepName\":\"agent.loop\",\"attempt\":2}",
              evidenceHash: "{\"capabilities\":[\"news.search\",\"web.search\"],\"lastActionResultKind\":\"tool\",\"lastActionResultStatus\":\"ok\",\"lastActionTool\":\"internet.news\"}",
              actionSignature: "{\"kind\":\"tool\",\"name\":\"internet.news\"}",
              observationMarker: "",
              cycleKind: "reasoning",
              waitToken: "",
              pendingExecutionHash: "{\"exec\":{\"substate\":\"collect\"}}",
            },
            {
              stepName: "agent.loop",
              fingerprint: "{\"stepName\":\"agent.loop\",\"attempt\":3}",
              evidenceHash: "{\"capabilities\":[\"news.search\",\"web.search\"],\"lastActionResultKind\":\"tool\",\"lastActionResultStatus\":\"ok\",\"lastActionTool\":\"internet.news\"}",
              actionSignature: "{\"kind\":\"tool\",\"name\":\"internet.news\"}",
              observationMarker: "",
              cycleKind: "reasoning",
              waitToken: "",
              pendingExecutionHash: "{\"exec\":{\"substate\":\"collect\"}}",
            },
          ],
        },
      },
    },
    effects: [],
    emitEvents: [],
    stepIndex: 0,
  });

  kestrel.registerStep("agent.loop", async () => {
    throw new GuardrailViolationError(
      "LOOP_GUARD_TRIGGERED",
      "Loop guard triggered for step 'agent.loop' after repeated redundant retrieval pivots for 'internet.news'.",
      {
        guardType: "REPEATED_REDUNDANT_RETRIEVAL_PIVOT",
        toolName: "internet.news",
        retrievalFamily: "internet.search_like",
        repeats: 3,
        threshold: 3,
      },
    );
  });

  const output = await kestrel.run({
    id: "evt-news-redundant-retrieval-regression",
    type: "system.meta_reasoning",
    sessionId: "session-news-redundant-retrieval-regression",
    payload: {
      reason: "resume_redundant_retrieval",
    },
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(output.errors.length, 0);

  const session = await store.getSession("session-news-redundant-retrieval-regression");
  const react = (session?.state.agent ?? {}) as Record<string, unknown>;
  const terminal = (react.terminal ?? {}) as Record<string, unknown>;
  const finalOutput = (react.finalOutput ?? {}) as Record<string, unknown>;
  const finalData = (finalOutput.data ?? {}) as Record<string, unknown>;

  assert.equal(terminal.reasonCode, "goal_satisfied");
  assert.notEqual(finalData.researchStalled, true);
  assert.equal(finalData.stallKind, "redundant_retrieval");
  assert.equal(finalData.guardType, "REPEATED_REDUNDANT_RETRIEVAL_PIVOT");
  assert.equal(finalData.guardToolName, "internet.news");
  assert.equal(finalData.guardRepeats, 3);
  assert.equal(finalData.guardThreshold, 3);
  assert.equal(finalData.verifiedEvidenceAvailable, true);
  assert.equal(finalData.lowSignalState, "none");
  assert.doesNotMatch(
    String(finalOutput.message ?? ""),
    /low-yield|without adding new verified evidence|Next if you want me to continue/u,
  );
  assert.match(String(finalOutput.message ?? ""), /Trump's China visit evidence is ready to synthesize/u);
  assert.equal(
    store.getRunEvents().filter((event) => event.type === "loop.guard_triggered").length,
    1,
  );
});

test("ExecutionEngine rehydrates compacted tool artifacts for verified retrieval synthesis", async () => {
  const store = new InMemorySessionStore();
  let capturedEvidence: Record<string, unknown> | undefined;
  let capturedSystemPrompt = "";
  let capturedUserPrompt = "";
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>(input: ModelRequest) => {
      capturedEvidence = (input.input as Record<string, unknown> | undefined)?.evidence as
        | Record<string, unknown>
        | undefined;
      capturedSystemPrompt = typeof input.messages?.[0]?.content === "string" ? input.messages[0].content : "";
      capturedUserPrompt = typeof input.messages?.[1]?.content === "string" ? input.messages[1].content : "";
      return "Cincinnati evidence is ready: FOX19 reported Theetge's legal action at https://www.fox19.com/theetge." as T;
    }),
    guardrails: {
      maxStepsPerRun: 20,
      maxStepVisits: 20,
    },
  });

  await store.ensureSession("session-compacted-artifact-rehydration", "agent.loop");
  await store.appendArtifacts("seed-artifacts", "session-compacted-artifact-rehydration", 5, [
    {
      id: "artifact-tool-output",
      type: "tool-output",
      payload: {
        toolName: "internet.news",
        output: {
          results: [
            {
              title: "Former police chief Theetge responds to firing, attorney announces legal action",
              url: "https://www.fox19.com/theetge",
              source: "FOX19 | Cincinnati",
            },
          ],
        },
      },
    },
  ]);
  await store.commitStep({
    runId: "seed-compacted-artifact-rehydration",
    event: {
      id: "seed-compacted-artifact-rehydration",
      type: "user.message",
      sessionId: "session-compacted-artifact-rehydration",
      payload: {
        message: "final answer",
      },
    },
    sessionId: "session-compacted-artifact-rehydration",
    expectedVersion: 0,
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        goal: "produce final answer about Cincinnati local government news",
        toolIntent: {
          version: "v1",
          toolUseIntent: "single",
          objective: "produce final answer about Cincinnati local government news",
          candidateTools: ["internet.news"],
          confidence: 0.9,
          workflowIntent: {
            kind: "research",
          },
        },
        lastActionResult: {
          kind: "tool",
          toolName: "internet.news",
          output: {
            summary: "Large news output persisted as artifact.",
            truncated: true,
            artifactIds: ["artifact-tool-output"],
            digestArtifactId: "artifact-tool-output-digest",
          },
        },
        postToolVerification: {
          evidenceRecoverySummary: {
            objectiveKey: "produce final answer about Cincinnati local government news",
            family: "web_research",
            attempts: 3,
            lowSignalAttempts: 0,
            consecutiveLowSignal: 0,
            latest: {
              family: "web_research",
              toolName: "internet.news",
              quality: "high",
              lowSignal: false,
              issues: [],
              resultsCount: 1,
              domainDiversity: 1,
              payloadFingerprint: "cincinnati-theetge-repeat",
              repeatedFingerprintCount: 1,
              candidateUrls: ["https://www.fox19.com/theetge"],
            },
          },
          webExtractionRetrySummary: {
            objectiveKey: "produce final answer about Cincinnati local government news",
            searchFallbackUsed: false,
            clusters: [],
          },
        },
        capabilityEvidence: {
          "news.search": {
            tool: "internet.news",
            stepIndex: 5,
          },
        },
        observations: [
          {
            summary: "Used internet.news and found Cincinnati local reporting.",
            goalMet: false,
          },
        ],
      },
    },
    effects: [],
    emitEvents: [],
    stepIndex: 0,
  });

  kestrel.registerStep("agent.loop", async () => {
    throw new GuardrailViolationError(
      "LOOP_GUARD_TRIGGERED",
      "Loop guard triggered after repeated redundant retrieval pivots for 'internet.news'.",
      {
        guardType: "REPEATED_REDUNDANT_RETRIEVAL_PIVOT",
        toolName: "internet.news",
        retrievalFamily: "internet.search_like",
        repeats: 3,
        threshold: 3,
      },
    );
  });

  const output = await kestrel.run({
    id: "evt-compacted-artifact-rehydration",
    type: "system.meta_reasoning",
    sessionId: "session-compacted-artifact-rehydration",
    payload: {
      reason: "resume_redundant_retrieval",
    },
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "COMPLETED");
  const recoveredArtifacts = capturedEvidence?.recoveredToolArtifacts as unknown[] | undefined;
  assert.equal(recoveredArtifacts?.length, 1);
  assert.match(capturedSystemPrompt, /Kestrel's Retrieval Finalizer/u);
  assert.match(capturedSystemPrompt, /Use only the verified evidence/u);
  assert.match(capturedUserPrompt, /Write the final answer from the verified retrieval evidence/u);
  assert.match(capturedUserPrompt, /<context_guide>/u);
  assert.match(capturedUserPrompt, /<answer_rule>/u);
  assert.match(capturedUserPrompt, /<context_json>/u);
  assert.match(capturedUserPrompt, /"objective":"produce final answer about Cincinnati local government news"/u);
  assert.match(capturedUserPrompt, /"verifiedEvidence":/u);
  assert.match(JSON.stringify(recoveredArtifacts), /Former police chief Theetge responds/u);
  const sourceIndex = capturedEvidence?.sourceIndex as Array<Record<string, unknown>> | undefined;
  assert.deepEqual(sourceIndex, [
    {
      artifactId: "artifact-tool-output",
      title: "Former police chief Theetge responds to firing, attorney announces legal action",
      url: "https://www.fox19.com/theetge",
      source: "FOX19 | Cincinnati",
      toolName: "internet.news",
    },
  ]);
  const session = await store.getSession("session-compacted-artifact-rehydration");
  const finalOutput = ((session?.state.agent as Record<string, unknown> | undefined)?.finalOutput ?? {}) as Record<
    string,
    unknown
  >;
  assert.match(String(finalOutput.message ?? ""), /FOX19/u);
});

test("ExecutionEngine reports missing compacted tool artifacts without synthesizing", async () => {
  const store = new InMemorySessionStore();
  let modelCalls = 0;
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => {
      modelCalls += 1;
      return "This should not be called when compacted artifacts are missing." as T;
    }),
    guardrails: {
      maxStepsPerRun: 20,
      maxStepVisits: 20,
    },
  });

  await store.ensureSession("session-missing-compacted-artifact", "agent.loop");
  await store.commitStep({
    runId: "seed-missing-compacted-artifact",
    event: {
      id: "seed-missing-compacted-artifact",
      type: "user.message",
      sessionId: "session-missing-compacted-artifact",
      payload: {
        message: "final answer",
      },
    },
    sessionId: "session-missing-compacted-artifact",
    expectedVersion: 0,
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        goal: "produce final answer about Cincinnati local government news",
        toolIntent: {
          version: "v1",
          toolUseIntent: "single",
          objective: "produce final answer about Cincinnati local government news",
          candidateTools: ["internet.news"],
          confidence: 0.9,
          workflowIntent: {
            kind: "research",
          },
        },
        lastActionResult: {
          kind: "tool",
          toolName: "internet.news",
          output: {
            summary: "Large news output persisted as artifact.",
            truncated: true,
            artifactIds: ["missing-tool-output"],
            digestArtifactId: "missing-tool-output-digest",
          },
        },
        postToolVerification: {
          evidenceRecoverySummary: {
            objectiveKey: "produce final answer about Cincinnati local government news",
            family: "web_research",
            attempts: 3,
            lowSignalAttempts: 0,
            consecutiveLowSignal: 0,
            latest: {
              family: "web_research",
              toolName: "internet.news",
              quality: "high",
              lowSignal: false,
              issues: [],
              resultsCount: 1,
              domainDiversity: 1,
              payloadFingerprint: "cincinnati-missing-artifact-repeat",
              repeatedFingerprintCount: 1,
              candidateUrls: ["https://www.fox19.com/theetge"],
            },
          },
          webExtractionRetrySummary: {
            objectiveKey: "produce final answer about Cincinnati local government news",
            searchFallbackUsed: false,
            clusters: [],
          },
        },
        capabilityEvidence: {
          "news.search": {
            tool: "internet.news",
            stepIndex: 5,
          },
        },
        observations: [
          {
            summary: "Used internet.news and compacted the retrieved local reporting.",
            goalMet: false,
          },
        ],
      },
    },
    effects: [],
    emitEvents: [],
    stepIndex: 0,
  });

  kestrel.registerStep("agent.loop", async () => {
    throw new GuardrailViolationError(
      "LOOP_GUARD_TRIGGERED",
      "Loop guard triggered after repeated redundant retrieval pivots for 'internet.news'.",
      {
        guardType: "REPEATED_REDUNDANT_RETRIEVAL_PIVOT",
        toolName: "internet.news",
        retrievalFamily: "internet.search_like",
        repeats: 3,
        threshold: 3,
      },
    );
  });

  const output = await kestrel.run({
    id: "evt-missing-compacted-artifact",
    type: "system.meta_reasoning",
    sessionId: "session-missing-compacted-artifact",
    payload: {
      reason: "resume_redundant_retrieval",
    },
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(modelCalls, 0);
  const session = await store.getSession("session-missing-compacted-artifact");
  const finalOutput = ((session?.state.agent as Record<string, unknown> | undefined)?.finalOutput ?? {}) as Record<
    string,
    unknown
  >;
  const finalData = (finalOutput.data ?? {}) as Record<string, unknown>;
  assert.equal(finalData.completionState, "artifact_evidence_unavailable");
  assert.equal(finalData.finalizeReason, "tool_unavailable");
  assert.equal(finalData.verifiedEvidenceAvailable, false);
  assert.match(String(finalOutput.message ?? ""), /missing-tool-output/u);
  assert.doesNotMatch(String(finalOutput.message ?? ""), /Next if you want|continue/u);
  const agentState = (session?.state.agent ?? {}) as Record<string, unknown>;
  const nextAction = (agentState.nextAction ?? {}) as Record<string, unknown>;
  const terminal = (agentState.terminal ?? {}) as Record<string, unknown>;
  assert.equal(nextAction.finalizeReason, "tool_unavailable");
  assert.equal(terminal.reasonCode, "artifact_evidence_unavailable");
});

test("ExecutionEngine loop-guards repeated filesystem retrieval pivots", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 200,
      maxStepVisits: 200,
    },
  });

  kestrel.registerStep("agent.loop", async (ctx) => {
    const cycle = typeof ctx.session.state.cycle === "number" ? (ctx.session.state.cycle as number) : 0;
    const nextTool = cycle % 2 === 0 ? "fs.list" : "fs.read_text";
    const react = ctx.session.state.agent as Record<string, unknown> | undefined;
    return {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
      statePatch: {
        cycle: cycle + 1,
        agent: {
          dispatchSequence: typeof react?.dispatchSequence === "number"
            ? (react.dispatchSequence as number)
            : 0,
          goal: "Read the FC Cincinnati note from disk",
          toolIntent: {
            version: "v1",
            toolUseIntent: "single",
            objective: "Read the FC Cincinnati note from disk",
            candidateTools: ["fs.list", "fs.read_text"],
            confidence: 0.9,
            workflowIntent: {
              kind: "research",
            },
            operationIntent: {
              kind: "read_file",
            },
          },
          nextAction: {
            kind: "tool",
            name: nextTool,
            input: {
              path: "notes/fc-cincinnati.md",
            },
          },
          capabilityEvidence: {},
          observations: [
            {
              summary: `Loop cycle ${cycle + 1}`,
              goalMet: false,
            },
          ],
        },
      },
    };
  });

  kestrel.registerStep("agent.exec.dispatch", async (ctx) => {
    const react = ctx.session.state.agent as Record<string, unknown> | undefined;
    const nextAction = react?.nextAction as Record<string, unknown> | undefined;
    const dispatchSequence = typeof react?.dispatchSequence === "number"
      ? (react.dispatchSequence as number)
      : 0;
    const toolName = typeof nextAction?.name === "string" ? nextAction.name : "fs.read_text";
    return {
      status: "RUNNING",
      nextStepAgent: "agent.loop",
      statePatch: {
        agent: {
          ...((react ?? {}) as Record<string, unknown>),
          dispatchSequence: dispatchSequence + 1,
          goal: typeof react?.goal === "string" ? react.goal : "Read the FC Cincinnati note from disk",
          capabilityEvidence: {
            retrieval: {
              tool: toolName,
              stepIndex: dispatchSequence + 1,
            },
          },
          lastActionResult: {
            toolName,
            path: "notes/fc-cincinnati.md",
            content: "FC Cincinnati exact record and next 3 games from today.",
          },
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-retrieval-loop-guard-filesystem",
    type: "user.message",
    sessionId: "session-retrieval-loop-guard-filesystem",
    payload: {
      message: "Read the FC Cincinnati note from disk",
    },
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "FAILED");
  assert.equal(output.errors[0]?.code, "LOOP_GUARD_TRIGGERED");
  assert.equal(output.waitFor, undefined);
  assert.equal(store.getRunEvents().some((event) => event.type === "loop.guard_triggered"), true);
});

test("ExecutionEngine allows fs.list inventory to progress into a grounded fs.read_text", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 20,
      maxStepVisits: 20,
    },
  });

  kestrel.registerStep("agent.loop", async (ctx) => {
    const react = ctx.session.state.agent as Record<string, unknown> | undefined;
    const reads = typeof ctx.session.state.reads === "number" ? (ctx.session.state.reads as number) : 0;
    const dispatchSequence = typeof react?.dispatchSequence === "number"
      ? (react.dispatchSequence as number)
      : 0;

    if (reads >= 2) {
      return {
        status: "COMPLETED",
        statePatch: {
          completed: true,
          agent: {
            ...((react ?? {}) as Record<string, unknown>),
            terminal: {
              status: "COMPLETED",
              reasonCode: "grounded_filesystem_progress",
              finalStepAgent: "agent.loop",
            },
          },
        },
      };
    }

    const nextAction = reads === 0
      ? {
        kind: "tool" as const,
        name: "fs.list",
        input: {
          path: "app",
        },
      }
      : {
        kind: "tool" as const,
        name: "fs.read_text",
        input: {
          path: "app/page.tsx",
        },
      };

    return {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
      statePatch: {
        reads,
        agent: {
          dispatchSequence,
          goal: "Inspect the app directory and then ground the homepage file",
          toolIntent: {
            version: "v1",
            toolUseIntent: "single",
            objective: "Inspect the app directory and then ground the homepage file",
            candidateTools: ["fs.list", "fs.read_text"],
            confidence: 0.9,
            workflowIntent: {
              kind: "research",
            },
            operationIntent: {
              kind: "read_file",
            },
          },
          nextAction,
          capabilityEvidence: {},
          observations: [
            {
              summary: reads === 0 ? "Listed the app directory first." : "Read the grounded homepage file.",
              goalMet: false,
            },
          ],
        },
      },
    };
  });

  kestrel.registerStep("agent.exec.dispatch", async (ctx) => {
    const react = ctx.session.state.agent as Record<string, unknown> | undefined;
    const nextAction = react?.nextAction as Record<string, unknown> | undefined;
    const toolName = typeof nextAction?.name === "string" ? nextAction.name : "fs.list";
    const dispatchSequence = typeof react?.dispatchSequence === "number"
      ? (react.dispatchSequence as number)
      : 0;
    const reads = typeof ctx.session.state.reads === "number" ? (ctx.session.state.reads as number) : 0;
    const toolLog = Array.isArray(ctx.session.state.toolLog) ? [...(ctx.session.state.toolLog as string[])] : [];
    const lastActionResult = toolName === "fs.list"
      ? {
        toolName,
        path: "app",
        entries: [
          { path: "app/page.tsx", kind: "file" },
          { path: "app/layout.tsx", kind: "file" },
        ],
      }
      : {
        toolName,
        path: "app/page.tsx",
        content: "export default function Page() { return <main>Time Travel Rentals</main>; }",
      };
    return {
      status: "RUNNING",
      nextStepAgent: "agent.loop",
      statePatch: {
        reads: reads + 1,
        toolLog: [...toolLog, toolName],
        agent: {
          ...((react ?? {}) as Record<string, unknown>),
          dispatchSequence: dispatchSequence + 1,
          goal: "Inspect the app directory and then ground the homepage file",
          capabilityEvidence: {
            retrieval: {
              tool: toolName,
              stepIndex: dispatchSequence + 1,
            },
          },
          lastActionResult,
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-retrieval-loop-guard-grounded-filesystem-progress",
    type: "user.message",
    sessionId: "session-retrieval-loop-guard-grounded-filesystem-progress",
    payload: {
      message: "Inspect the app directory and then ground the homepage file",
    },
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(output.errors.length, 0);
  assert.equal(output.telemetry.stepsExecuted, 5);

  const session = await store.getSession("session-retrieval-loop-guard-grounded-filesystem-progress");
  assert.equal(session?.state.completed, true);
  assert.deepEqual(session?.state.toolLog, ["fs.list", "fs.read_text"]);
  const react = (session?.state.agent ?? {}) as Record<string, unknown>;
  const terminal = (react.terminal ?? {}) as Record<string, unknown>;

  assert.equal(terminal.reasonCode, "completed");
});

test("ExecutionEngine loop-guards redundant fs.read_text pivots", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 200,
      maxStepVisits: 200,
    },
  });

  kestrel.registerStep("agent.loop", async (ctx) => {
    const react = ctx.session.state.agent as Record<string, unknown> | undefined;
    const reads = typeof ctx.session.state.reads === "number" ? (ctx.session.state.reads as number) : 0;
    const path = reads % 2 === 0 ? "notes/release.md" : "./notes/release.md";
    return {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
      statePatch: {
        reads,
        agent: {
          dispatchSequence: typeof react?.dispatchSequence === "number"
            ? (react.dispatchSequence as number)
            : 0,
          goal: "Read the release note from disk",
          toolIntent: {
            version: "v1",
            toolUseIntent: "single",
            objective: "Read the release note from disk",
            candidateTools: ["fs.read_text"],
            confidence: 0.9,
            workflowIntent: {
              kind: "research",
            },
            operationIntent: {
              kind: "read_file",
            },
          },
          nextAction: {
            kind: "tool",
            name: "fs.read_text",
            input: {
              path,
            },
          },
          capabilityEvidence: {},
          observations: [
            {
              summary: `Loop read attempt ${reads + 1}`,
              goalMet: false,
            },
          ],
        },
      },
    };
  });

  kestrel.registerStep("agent.exec.dispatch", async (ctx) => {
    const react = ctx.session.state.agent as Record<string, unknown> | undefined;
    const dispatchSequence = typeof react?.dispatchSequence === "number"
      ? (react.dispatchSequence as number)
      : 0;
    const reads = typeof ctx.session.state.reads === "number" ? (ctx.session.state.reads as number) : 0;
    return {
      status: "RUNNING",
      nextStepAgent: "agent.loop",
      statePatch: {
        reads: reads + 1,
        agent: {
          ...((react ?? {}) as Record<string, unknown>),
          dispatchSequence: dispatchSequence + 1,
          goal: "Read the release note from disk",
          capabilityEvidence: {
            retrieval: {
              tool: "fs.read_text",
              stepIndex: dispatchSequence + 1,
            },
          },
          lastActionResult: {
            toolName: "fs.read_text",
            path: "notes/release.md",
            content: "Release note content did not change.",
          },
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-retrieval-loop-guard-same-file",
    type: "user.message",
    sessionId: "session-retrieval-loop-guard-same-file",
    payload: {
      message: "Read the release note from disk",
    },
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "FAILED");
  assert.equal(output.errors[0]?.code, "LOOP_GUARD_TRIGGERED");
  assert.equal(output.waitFor, undefined);
  assert.equal(store.getRunEvents().some((event) => event.type === "loop.guard_triggered"), true);

  const session = await store.getSession("session-retrieval-loop-guard-same-file");
  assert.ok(Number(session?.state.reads ?? 0) >= 1);
});

test("ExecutionEngine loop-guards coding filesystem repeats without clarification wait", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: {
      call: async () => null as never,
    },
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    guardrails: {
      maxStepsPerRun: 200,
      maxStepVisits: 200,
    },
  });

  kestrel.registerStep("agent.loop", async (ctx) => {
    const react = ctx.session.state.agent as Record<string, unknown> | undefined;
    const reads = typeof ctx.session.state.reads === "number" ? (ctx.session.state.reads as number) : 0;
    const path = reads % 2 === 0 ? "app/page.tsx" : "./app/page.tsx";
    return {
      status: "RUNNING",
      nextStepAgent: "agent.exec.dispatch",
      statePatch: {
        reads,
        agent: {
          dispatchSequence: typeof react?.dispatchSequence === "number"
            ? (react.dispatchSequence as number)
            : 0,
          goal: "Keep working on the time travel rental website",
          toolIntent: {
            version: "v1",
            toolUseIntent: "single",
            objective: "Keep working on the time travel rental website",
            candidateTools: ["fs.read_text"],
            confidence: 0.9,
            workflowIntent: {
              kind: "coding_change",
            },
            operationIntent: {
              kind: "read_file",
            },
          },
          nextAction: {
            kind: "tool",
            name: "fs.read_text",
            input: {
              path,
            },
          },
          capabilityEvidence: {
            "filesystem.read": {
              tool: "fs.read_text",
              stepIndex: reads + 1,
            },
          },
          requiredCapabilities: ["filesystem.read"],
          observations: [
            {
              summary: `Loop coding read attempt ${reads + 1}`,
              goalMet: false,
            },
          ],
        },
      },
    };
  });

  kestrel.registerStep("agent.exec.dispatch", async (ctx) => {
    const react = ctx.session.state.agent as Record<string, unknown> | undefined;
    const dispatchSequence = typeof react?.dispatchSequence === "number"
      ? (react.dispatchSequence as number)
      : 0;
    const reads = typeof ctx.session.state.reads === "number" ? (ctx.session.state.reads as number) : 0;
    return {
      status: "RUNNING",
      nextStepAgent: "agent.loop",
      statePatch: {
        reads: reads + 1,
        agent: {
          ...((react ?? {}) as Record<string, unknown>),
          dispatchSequence: dispatchSequence + 1,
          goal: "Keep working on the time travel rental website",
          lastActionResult: {
            toolName: "fs.read_text",
            path: "app/page.tsx",
            content: "export default function Page() { return <main>Time Travel Rentals</main>; }",
          },
          postToolVerification: {
            evidenceRecoverySummary: {
              objectiveKey: "keep working on the time travel rental website",
              family: "filesystem_retrieval",
              filesystemInspection: {
                inventoryActions: BROAD_RESUME_MAX_INVENTORY_ACTIONS,
                groundedReadActions: BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS,
                budgetExhausted: true,
                inventoryPaths: [".", "app", "app/page.tsx"],
              },
            },
          },
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-retrieval-loop-guard-coding-filesystem",
    type: "user.message",
    sessionId: "session-retrieval-loop-guard-coding-filesystem",
    payload: {
      message: "Keep working on the time travel rental website",
    },
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "FAILED");
  assert.equal(output.errors[0]?.code, "LOOP_GUARD_TRIGGERED");
  assert.equal(output.waitFor, undefined);
  assert.equal(store.getRunEvents().some((event) => event.type === "loop.guard_triggered"), true);

  const session = await store.getSession("session-retrieval-loop-guard-coding-filesystem");
  assert.ok(Number(session?.state.reads ?? 0) >= 1);
  const react = (session?.state.agent ?? {}) as Record<string, unknown>;
  assert.equal(react.waitingFor, undefined);
});
