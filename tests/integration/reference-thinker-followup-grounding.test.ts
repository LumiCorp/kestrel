import assert from "node:assert/strict";

import { registerAgentReferenceRuntime } from "../../agents/reference-react/src/register.js";
import type { ModelRequest, ModelResponse, ToolGateway } from "../../src/kestrel/contracts/model-io.js";

import { Kestrel } from "../../src/kestrel/Kestrel.js";
import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";
import { contractTest } from "../helpers/contract-test.js";


function modelResponse(output: unknown): ModelResponse<unknown> {
  const record = output !== null && typeof output === "object" && !Array.isArray(output)
    ? output as Record<string, unknown>
    : undefined;
  const toolIntents = actionToolIntents(record?.nextAction);
  const normalizedOutput =
    record !== undefined &&
    record.understanding === undefined &&
    record.nextAction !== undefined &&
    typeof record.reason === "string"
      ? {
          understanding: {
            task: "Handle the requested reference recovery task.",
            facts: ["The deterministic test model selected the next agent action."],
            currentGap: "The test run still needs that action to continue.",
            actionBasis: "The selected action advances the deterministic scenario.",
          },
          ...record,
        }
      : output;
  return {
    output: normalizedOutput,
    toolIntents,
    provider: {
      name: "openrouter",
      model: "test-model",
      endpoint: "chat",
    },
  };
}

function actionToolIntents(action: unknown): ModelResponse<unknown>["toolIntents"] {
  const record = action !== null && typeof action === "object" && !Array.isArray(action)
    ? action as Record<string, unknown>
    : undefined;
  const kind = typeof record?.kind === "string" ? record.kind : undefined;
  if (kind === "finalize") {
    return [{
      name: "kestrel_finalize",
      input: {
        status: typeof record?.status === "string" ? record.status : "goal_satisfied",
        message: typeof record?.message === "string" ? record.message : "Done.",
        assistantProgress: "I have completed the requested work.",
      },
    }];
  }
  return [];
}

contractTest("runtime.process", "reference thinker avoids ungrounded fetch actions when follow-up grounding is insufficient", async () => {
  const store = new InMemorySessionStore();
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const finalized: Record<string, unknown>[] = [];
  let deliberatorInput: Record<string, unknown> | undefined;

  await store.ensureSession("session-thinker-followup-1", "agent.loop");
  await store.patchSessionState({
    sessionId: "session-thinker-followup-1",
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        goal: "Tell me more about the Crosby deal falling through",
        lastActionResult: {
          kind: "tool",
          name: "internet.search",
          output: {
            query: "latest Cincinnati sports headlines",
            results: [
              {
                title: "Ravens pivot to former Bengals end Hendrickson after Crosby deal falls through",
                url: "https://local12.com/sports/bengals/crosby-deal-falls-through",
                source: "WKRC",
                snippet: "Baltimore pivoted after the Maxx Crosby trade path collapsed.",
              },
            ],
          },
        },
      },
    },
  });

  const toolGateway: ToolGateway = {
    async call<T>(name: string, input: unknown): Promise<T> {
      toolCalls.push({ name, input });
      if (name === "internet.search") {
        return {
          status: "ok",
          provider: "tavily",
          attempts: 1,
          query:
            typeof (input as { query?: string }).query === "string"
              ? (input as { query: string }).query
              : "Crosby deal falls through details",
          results: [
            {
              title: "Ravens pivot to former Bengals end Hendrickson after Crosby deal falls through",
              url: "https://local12.com/sports/bengals/crosby-deal-falls-through",
              source: "WKRC",
              snippet: "Baltimore pivoted after the Maxx Crosby trade path collapsed.",
            },
          ],
        } as T;
      }
      if (name === "FinalizeAnswer") {
        finalized.push(input as Record<string, unknown>);
        return {
          accepted: true,
          payload: input,
        } as T;
      }
      throw new Error(`Unexpected tool call '${name}'`);
    },
    async preRun(): Promise<void> {
      // no-op
    },
  };

  const modelGateway = new RetryingModelGateway(async <T>(request: ModelRequest) => {
    const schemaName = request.providerOptions?.openrouter?.responseSchemaName;
    const requestInput = (request.input ?? {}) as Record<string, unknown>;

    if (schemaName === "kestrel_agent_action" || request.metadata?.modelRole === "tool_action") {
      deliberatorInput = requestInput;
      return modelResponse({
        webInference: {
          goalClass: "general_web_research",
          evidenceSufficiency: "insufficient",
          sufficiencyRationale:
            "The prior-source grounding failed, so another search is needed before any fetch or summary.",
          supportingUrls: ["https://local12.com/sports/bengals/crosby-deal-falls-through"],
          keyClaims: ["The prior search result suggests the Crosby deal detail but needs a grounded follow-up search."],
          plannedPivotAssessment: {
            classification: "acceptable",
            reason: "The follow-up search is a grounded recovery step after prior-source selection failed.",
          },
        },
        nextAction: {
          kind: "finalize",
          status: "out_of_scope",
          message:
            "I do not have enough grounded source evidence to safely fetch or summarize the Crosby deal follow-up.",
        },
        reason:
          "The current situation says the prior-source grounding failed, so this reports that a grounded source choice is needed instead of fetching an ungrounded URL.",
        evidenceExpectations: {
          blockedBy: ["prior_source_selection_missing"],
        },
      }) as T;
    }

    if (
      schemaName === "kestrel_route_decision" ||
      schemaName === "kestrel_extractor_decision" ||
      schemaName === "kestrel_resolver_decision"
    ) {
      throw new Error(`Unexpected model schema '${schemaName}'`);
    }

    throw new Error(`Unexpected model schema '${schemaName ?? request.metadata?.modelRole ?? "unknown"}'`);
  });

  const kestrel = new Kestrel({
    store,
    toolGateway,
    modelGateway,
  });

  registerAgentReferenceRuntime(kestrel, {
    thinkerToolsProvider: () => [
      {
        name: "internet.search",
        description: "Search the web",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      {
        name: "internet.extract",
        description: "Fetch a URL",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
            maxChars: { type: "number" },
          },
          required: ["url"],
          additionalProperties: false,
        },
      },
    ],
    capabilityManifestProvider: () => [
      {
        name: "internet.search",
        description: "Search the web",
        freshnessClass: "live",
        latencyClass: "medium",
        costClass: "metered",
        executionClass: "read_only",
        capabilityClasses: ["web.search"],
      },
      {
        name: "internet.extract",
        description: "Fetch a URL",
        freshnessClass: "live",
        latencyClass: "medium",
        costClass: "metered",
        executionClass: "read_only",
        capabilityClasses: ["web.fetch"],
      },
    ],
  });

  const output = await kestrel.run({
    id: "evt-thinker-followup-1",
    type: "user.message",
    sessionId: "session-thinker-followup-1",
    payload: {
      message: "tell me more about the Crosby deal falling through",
      resumeBlockedRun: true,
      modeSystemV2Enabled: true,
      interactionMode: "plan",
      history: [],
    },
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "COMPLETED", JSON.stringify(output.errors));
  assert.equal(Object.hasOwn(deliberatorInput ?? {}, "currentTurnSummary"), false);
  assert.equal(Object.hasOwn(deliberatorInput ?? {}, "currentSituation"), false);
  assert.equal(Object.hasOwn(deliberatorInput ?? {}, "transcript"), true);
  assert.match(`${String(deliberatorInput?.taskInstruction)}`, /Crosby deal falling through/u);
  assert.equal(Object.hasOwn(deliberatorInput ?? {}, "followUpGrounding"), false);
  assert.equal(Object.hasOwn(deliberatorInput ?? {}, "priorSources"), false);
  assert.equal(
    toolCalls.some((entry) => entry.name === "internet.extract" || entry.name === "internet.extract"),
    false,
  );
  assert.equal(
    toolCalls.some((entry) => entry.name === "internet.search"),
    false,
  );
  assert.equal(
    finalized.some(
      (entry) =>
        String(entry.message ?? "").includes("not have enough grounded source evidence"),
    ),
    true,
  );
});
