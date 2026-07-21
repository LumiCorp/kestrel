import assert from "node:assert/strict";

import type { ModelRequest, ModelResponse, ToolGateway } from "../../src/kestrel/contracts/model-io.js";

import { Kestrel } from "../../src/kestrel/Kestrel.js";
import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import { registerAgentReferenceRuntime } from "../../agents/reference-react/src/register.js";
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
  if (kind === "tool") {
    const name = typeof record?.name === "string" ? record.name : undefined;
    const input = record?.input !== null && typeof record?.input === "object" && !Array.isArray(record.input)
      ? record.input as Record<string, unknown>
      : {};
    return name !== undefined ? [{ name: name.replace(/[^A-Za-z0-9_]/gu, "_"), input: { ...input, assistantProgress: `I am using ${name} to continue the requested work.` } }] : [];
  }
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

contractTest("runtime.process", "reference harness grounds a prior news headline into internet.extract on follow-up", async () => {
  const store = new InMemorySessionStore();
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const finalized: Record<string, unknown>[] = [];

  const toolGateway: ToolGateway = {
    async call<T>(name: string, input: unknown): Promise<T> {
      toolCalls.push({ name, input });
      if (name === "internet.news") {
        return {
          status: "ok",
          provider: "tavily",
          attempts: 1,
          query: "news headlines for Cincinnati",
          results: [
            {
              title:
                "Ravens pivot to former Bengals end Hendrickson after Crosby deal falls through",
              url: "https://local12.com/sports/bengals/crosby-deal-falls-through",
              source: "WKRC",
              publishedAt: "2026-03-11T00:00:00.000Z",
              snippet: "The Ravens pivoted after the Maxx Crosby deal fell through.",
            },
          ],
        } as T;
      }
      if (name === "internet.search") {
        return {
          status: "ok",
          provider: "tavily",
          attempts: 1,
          query: typeof (input as { query?: string }).query === "string"
            ? (input as { query: string }).query
            : "news headlines for Cincinnati",
          results: [
            {
              title:
                "Ravens pivot to former Bengals end Hendrickson after Crosby deal falls through",
              url: "https://local12.com/sports/bengals/crosby-deal-falls-through",
              source: "WKRC",
              snippet: "The Ravens pivoted after the Maxx Crosby deal fell through.",
            },
            {
              title: "City council approves downtown transit changes",
              url: "https://www.cincinnati.com/story/news/2026/03/11/transit-update/1",
              source: "The Cincinnati Enquirer",
            },
            {
              title: "UC advances to conference tournament semifinal",
              url: "https://www.espn.com/college-basketball/story/_/id/1",
              source: "ESPN",
            },
            {
              title: "Ohio lawmakers debate statewide housing package",
              url: "https://apnews.com/article/ohio-housing-package-1",
              source: "AP News",
            },
            {
              title: "Storm cleanup continues across the region",
              url: "https://www.wlwt.com/article/storm-cleanup-cincinnati/1",
              source: "WLWT",
            },
          ],
        } as T;
      }
      if (name === "internet.extract") {
        return {
          status: "ok",
          provider: "tavily",
          attempts: 1,
          url: "https://local12.com/sports/bengals/crosby-deal-falls-through",
          title:
            "Ravens pivot to former Bengals end Hendrickson after Crosby deal falls through",
          content:
            "The article explains that Baltimore pivoted after a Maxx Crosby trade path collapsed.",
          contentType: "text/html",
          charCount: 1024,
          quality: "high",
          truncated: false,
          contentIssues: [],
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
      const encodedInput = JSON.stringify(request.input);
      const requestInput = (request.input ?? {}) as Record<string, unknown>;
      const visibleRequestText = JSON.stringify(request.messages ?? []);
      const latestUserTurn = typeof requestInput.latestUserTurn === "string" ? requestInput.latestUserTurn : "";
      const taskInstruction = typeof requestInput.taskInstruction === "string" ? requestInput.taskInstruction : "";

    if (schemaName === "kestrel_route_decision") {
      return modelResponse({
        version: "v1",
        executionLane: "tooling",
        needsTools: true,
        requiredToolClasses: ["read_only"],
        reasonCode: "read_only_tooling",
        confidence: 0.99,
      }) as T;
    }

    if (schemaName === "kestrel_extractor_decision") {
      if (encodedInput.includes("Crosby deal")) {
        const extractorInput = request.input as { sourceCandidates?: Array<{ id?: string; title?: string }> };
        const candidateId = extractorInput.sourceCandidates?.find((source) =>
          source.title?.includes("Crosby deal falls through") === true
        )?.id;
        return modelResponse({
          version: "v2",
          toolUseIntent: "single",
          objective: "Get more detail about the Crosby deal falling through",
          candidateTools: ["internet.extract"],
          confidence: 0.88,
          ...(candidateId !== undefined
            ? {
                followUpSourceSelection: {
                  kind: "use_prior_source",
                  candidateId,
                },
              }
            : {}),
          clarification: {
            needed: false,
          },
        }) as T;
      }
      return modelResponse({
        version: "v2",
        toolUseIntent: "single",
        objective: "Get Cincinnati news headlines",
        candidateTools: ["internet.news"],
        confidence: 0.97,
        inputHints: {
          query: "news headlines for Cincinnati",
        },
        clarification: {
          needed: false,
        },
      }) as T;
    }

    if (schemaName === "kestrel_agent_action" || request.metadata?.modelRole === "tool_action") {
      const followUp = latestUserTurn.toLowerCase().includes("deal falling through") ||
        taskInstruction.toLowerCase().includes("deal falling through") ||
        visibleRequestText.toLowerCase().includes("deal falling through");
      if (followUp && toolCalls.some((entry) => entry.name === "internet.extract")) {
        return modelResponse({
          webInference: {
            goalClass: "general_web_research",
            evidenceSufficiency: "sufficient_direct",
            sufficiencyRationale: "The fetched article evidence is ready for finalization.",
            supportingUrls: ["https://local12.com/sports/bengals/crosby-deal-falls-through"],
            keyClaims: ["Baltimore pivoted after the Maxx Crosby trade path collapsed."],
            plannedPivotAssessment: {
              classification: "acceptable",
              reason: "The action finalizes the grounded article answer.",
            },
          },
          nextAction: {
            kind: "finalize",
            status: "goal_satisfied",
            message: "The article says Baltimore pivoted after the Maxx Crosby trade path collapsed.",
          },
          reason: "The fetched article evidence is in the handoff, so this finalizes the grounded follow-up.",
        }) as T;
      }
      if (!followUp && toolCalls.some((entry) => entry.name === "internet.news")) {
        return modelResponse({
          webInference: {
            goalClass: "general_web_research",
            evidenceSufficiency: "sufficient_direct",
            sufficiencyRationale: "The headline evidence is ready for finalization.",
            supportingUrls: [],
            keyClaims: ["Cincinnati headline evidence was collected."],
            plannedPivotAssessment: {
              classification: "acceptable",
              reason: "The action finalizes the grounded headline answer.",
            },
          },
          nextAction: {
            kind: "finalize",
            status: "goal_satisfied",
            message: "Here are the latest Cincinnati headlines.",
          },
          reason: "The headline evidence is in the handoff, so this finalizes the grounded headline answer.",
        }) as T;
      }
      if (followUp) {
        return modelResponse({
          webInference: {
            goalClass: "general_web_research",
            evidenceSufficiency: "insufficient",
            sufficiencyRationale:
              "The user selected a prior source from the previous headline result, so fetching that exact URL is grounded.",
            supportingUrls: ["https://local12.com/sports/bengals/crosby-deal-falls-through"],
            keyClaims: ["The prior headline referenced the Crosby deal falling through."],
            plannedPivotAssessment: {
              classification: "acceptable",
              reason: "The action fetches a concrete URL from prior sourced evidence.",
            },
          },
          nextAction: {
            kind: "tool",
            name: "internet.extract",
            input: {
              url: "https://local12.com/sports/bengals/crosby-deal-falls-through",
            },
          },
          reason: "The follow-up names a prior source, so this fetches the grounded article before answering.",
        }) as T;
      }
      return modelResponse({
        nextAction: {
          kind: "tool",
          name: "internet.news",
          input: {
            query: "news headlines for Cincinnati",
          },
        },
        reason: "This collects current headline evidence before answering.",
      }) as T;
    }

    if (schemaName === "kestrel_resolver_decision") {
      throw new Error("resolver should not run for these concrete extractor handoffs");
    }

    throw new Error(`Unexpected model schema '${schemaName ?? "unknown"}'`);
  });

  const kestrel = new Kestrel({
    store,
    toolGateway,
    modelGateway,
  });

  const registration = registerAgentReferenceRuntime(kestrel, {
    thinkerToolsProvider: () => [
      {
        name: "internet.news",
        description: "News search",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number" },
            freshness: { type: "string" },
            region: { type: "string" },
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
        name: "internet.news",
        description: "News search",
        freshnessClass: "live",
        latencyClass: "medium",
        costClass: "metered",
        executionClass: "read_only",
        capabilityClasses: ["news.search"],
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

  const firstOutput = await kestrel.run({
    id: "evt-news-1",
    type: "user.message",
    sessionId: "session-news-followup-1",
    payload: {
      message: "give me the news headlines for cincinnati",
      modeSystemV2Enabled: true,
      interactionMode: "plan",
      history: [],
    },
    stepAgent: registration.entryStepAgent,
  });

  assert.equal(firstOutput.status, "COMPLETED", JSON.stringify(firstOutput.errors));
  assert.equal(toolCalls[0]?.name, "internet.news");

  const secondOutput = await kestrel.run({
    id: "evt-news-2",
    type: "user.message",
    sessionId: "session-news-followup-1",
    payload: {
      message: "tell me more about the Corsby deal falling through",
      modeSystemV2Enabled: true,
      interactionMode: "plan",
      history: [],
    },
    stepAgent: registration.entryStepAgent,
  });

  assert.equal(secondOutput.status, "COMPLETED", JSON.stringify(secondOutput.errors));
  assert.deepEqual(
    toolCalls.find((entry) => entry.name === "internet.extract"),
    {
    name: "internet.extract",
    input: {
      url: "https://local12.com/sports/bengals/crosby-deal-falls-through",
    },
    },
  );
  assert.equal(
    finalized.some(
      (entry) =>
        entry.message ===
        "The article says Baltimore pivoted after the Maxx Crosby trade path collapsed.",
    ),
    true,
  );

});
