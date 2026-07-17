import assert from "node:assert/strict";
import test from "node:test";

import { registerAgentReferenceRuntime } from "../../agents/reference-react/src/register.js";
import type { ModelRequest, ModelResponse, ToolGateway } from "../../src/kestrel/contracts/model-io.js";

import { Kestrel } from "../../src/kestrel/Kestrel.js";
import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";

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
  if (kind === "tool_batch") {
    return Array.isArray(record?.items)
      ? record.items.flatMap((item) => {
          const tool = item !== null && typeof item === "object" && !Array.isArray(item)
            ? item as Record<string, unknown>
            : undefined;
          const name = typeof tool?.name === "string" ? tool.name : undefined;
          const input = tool?.input !== null && typeof tool?.input === "object" && !Array.isArray(tool.input)
            ? tool.input as Record<string, unknown>
            : {};
          return name !== undefined ? [{ name: name.replace(/[^A-Za-z0-9_]/gu, "_"), input: { ...input, assistantProgress: `I am using ${name} to continue the requested work.` } }] : [];
        })
      : [];
  }
  if (kind === "finalize") {
    return [{
      name: "kestrel_finalize",
      input: {
        status: typeof record?.status === "string" ? record.status : "goal_satisfied",
        message: typeof record?.message === "string" ? record.message : "Done.",
        assistantProgress: "I have completed the requested work.",
        ...(record?.data !== undefined ? { data: record.data } : {}),
      },
    }];
  }
  return [];
}

test("reference harness pivots from weak headlines to soft handoff without looping", async () => {
  const store = new InMemorySessionStore();
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const finalized: Record<string, unknown>[] = [];
  let thinkerCalls = 0;

  const toolGateway: ToolGateway = {
    async call<T>(name: string, input: unknown): Promise<T> {
      toolCalls.push({ name, input });
      if (name === "internet.news") {
        return {
          status: "ok",
          provider: "tavily",
          query: "top us news headlines today",
          region: "us",
          attempts: 1,
          results: [
            {
              title: "Editorial Roundup: United States",
              url: "https://washingtonpost.example.com/editorial-roundup",
              source: "Washington Post",
            },
            {
              title: "Powerful storm system slams Midwest as East Coast braces for impact",
              url: "https://nbc.example.com/story-1",
              source: "NBC News",
            },
            {
              title: "Headlines from latest remarks on the Iran war",
              url: "https://ap.example.com/story-2",
              source: "AP",
            },
          ],
        } as T;
      }
      if (name === "internet.news") {
        return {
          status: "ok",
          provider: "tavily",
          query: "top us news headlines today",
          region: "us",
          attempts: 1,
          results: [
            {
              title: "Powerful storm system slams Midwest as East Coast braces for impact",
              url: "https://nbc.example.com/story-1",
              source: "NBC News",
            },
            {
              title: "Headlines from latest remarks on the Iran war",
              url: "https://ap.example.com/story-2",
              source: "AP",
            },
            {
              title: "Gas prices jump after Strait of Hormuz tension",
              url: "https://reuters.example.com/story-3",
              source: "Reuters",
            },
            {
              title: "Open: This is Face the Nation",
              url: "https://cbs.example.com/face-the-nation-open",
              source: "CBS News",
            },
          ],
        } as T;
      }
      if (name === "internet.extract") {
        return {
          status: "ok",
          provider: "tavily",
          url: (input as { url: string }).url,
          quality: "low",
          truncated: true,
          contentIssues: ["low_text_density"],
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

    if (schemaName === "kestrel_agent_action" || request.tools !== undefined) {
      if (toolCalls.filter((entry) => entry.name === "internet.extract").length >= 3) {
        return modelResponse({
          nextAction: {
            kind: "finalize",
            status: "out_of_scope",
            message:
              "I tried multiple current-news retrieval paths but could not gather enough high-signal evidence to safely draft a full monologue. If you want, narrow the scope or specify preferred outlets.",
            data: {
              completionState: "blocked",
            },
          },
          reason: "The agent loop state says the retrieval paths remained low-signal, so this finalizes with a clear blocker.",
          evidenceExpectations: {
            blockedBy: ["insufficient_high_signal_evidence"],
          },
        }) as T;
      }

      thinkerCalls += 1;
      if (thinkerCalls === 1) {
        return modelResponse({
          nextAction: {
            kind: "tool",
            name: "internet.news",
            input: {
              query: "top us news headlines today",
              region: "us",
              limit: 20,
            },
          },
          reason: "This pulls a broader headline set to see whether enough distinct current stories are available.",
          evidenceExpectations: {
            newEvidence: ["Additional distinct headline candidates from the same provider"],
          },
        }) as T;
      }
      if (thinkerCalls === 2) {
        return modelResponse({
          webInference: {
            goalClass: "general_web_research",
            evidenceSufficiency: "insufficient",
            sufficiencyRationale:
              "The headlines evidence is still noisy and needs broader news search before a grounded monologue.",
            supportingUrls: [
              "https://nbc.example.com/story-1",
              "https://ap.example.com/story-2",
            ],
            keyClaims: ["The current evidence still lacks a clean enough lead-story set."],
            plannedPivotAssessment: {
              classification: "acceptable",
              reason: "Broadening from headlines to news search is the next grounded retrieval step.",
            },
          },
          nextAction: {
            kind: "tool",
            name: "internet.news",
            input: {
              query: "top us news headlines today",
              limit: 15,
              freshness: "day",
              region: "us",
            },
          },
          reason: "The headline roundup was noisy, so this broadens to news search for cleaner topic clustering.",
          evidenceExpectations: {
            newEvidence: ["A new domain cluster beyond the noisy headline roundup"],
          },
        }) as T;
      }
      return modelResponse({
        webInference: {
          goalClass: "general_web_research",
          evidenceSufficiency: "insufficient",
          sufficiencyRationale:
            "The current headlines and news-search results identify candidates but need article-body evidence.",
          supportingUrls: [
            "https://nbc.example.com/story-1",
            "https://ap.example.com/story-2",
            "https://reuters.example.com/story-3",
          ],
          keyClaims: ["Current evidence identifies candidate lead stories but not enough article-body detail."],
          plannedPivotAssessment: {
            classification: "acceptable",
            reason: "Fetching the top candidate article bodies is the next grounded step.",
          },
        },
        nextAction: {
          kind: "tool_batch",
          items: [
            { name: "internet.extract", input: { url: "https://nbc.example.com/story-1", maxChars: 12_000 } },
            { name: "internet.extract", input: { url: "https://ap.example.com/story-2", maxChars: 12_000 } },
            { name: "internet.extract", input: { url: "https://reuters.example.com/story-3", maxChars: 12_000 } },
          ],
        },
        reason: "The current results identify candidate stories but need article-body evidence before drafting.",
        evidenceExpectations: {
          newEvidence: ["Article body text from the strongest three candidate URLs"],
        },
      }) as T;
    }

    if (schemaName === "kestrel_resolver_decision") {
      throw new Error("resolver should not run for this concrete extractor handoff");
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
        description: "Headlines",
        inputSchema: {
          type: "object",
          properties: {
            scope: { type: "string" },
            limit: { type: "number" },
          },
          additionalProperties: false,
        },
      },
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
        name: "internet.search",
        description: "Internet search",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number" },
            freshness: { type: "string" },
            domainAllow: {
              type: "array",
              items: { type: "string" },
            },
            domainDeny: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      {
        name: "internet.extract",
        description: "Fetch URL",
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
        description: "Headlines",
        freshnessClass: "live",
        latencyClass: "medium",
        costClass: "metered",
        executionClass: "read_only",
        capabilityClasses: ["news.headlines"],
      },
      {
        name: "internet.news",
        description: "News search",
        freshnessClass: "live",
        latencyClass: "medium",
        costClass: "metered",
        executionClass: "read_only",
        capabilityClasses: ["news.search", "web.search"],
      },
      {
        name: "internet.search",
        description: "Internet search",
        freshnessClass: "live",
        latencyClass: "medium",
        costClass: "metered",
        executionClass: "read_only",
        capabilityClasses: ["web.search"],
      },
      {
        name: "internet.extract",
        description: "Fetch URL",
        freshnessClass: "live",
        latencyClass: "medium",
        costClass: "metered",
        executionClass: "read_only",
        capabilityClasses: ["web.fetch"],
      },
    ],
  });

  const output = await kestrel.run({
    id: "evt-news-recovery-1",
    type: "user.message",
    sessionId: "session-news-recovery-1",
    payload: {
      message: "give me the top us news headlines and write a nightly news monologue",
      modeSystemV2Enabled: true,
      interactionMode: "plan",
      history: [],
    },
    stepAgent: registration.entryStepAgent,
  });

  assert.equal(output.status, "COMPLETED", JSON.stringify(output, null, 2));
  assert.equal(toolCalls[0]?.name, "internet.news");
  assert.equal(toolCalls.some((entry) => entry.name === "internet.news"), true);
  assert.equal(toolCalls.filter((entry) => entry.name === "internet.extract").length >= 3, true);
  assert.equal(finalized.length, 1);
  assert.equal(String(finalized[0]?.message).includes("narrow the scope"), true);
  assert.equal(
    store.getRunEvents().some((event) => event.type === "loop.guard_triggered"),
    false,
  );
});
