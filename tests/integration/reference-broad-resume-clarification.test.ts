import assert from "node:assert/strict";

import type { ModelRequest, ModelResponse, ToolGateway } from "../../src/kestrel/contracts/model-io.js";

import { Kestrel } from "../../src/kestrel/Kestrel.js";
import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import { registerAgentReferenceRuntime } from "../../agents/reference-react/src/register.js";
import { buildAgentToolSuccessResult } from "../../tools/toolResult.js";
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
  if (kind === "ask_user") {
    return [{
      name: "kestrel_ask_user",
      input: {
        prompt: typeof record?.prompt === "string" ? record.prompt : "Please clarify.",
        assistantProgress: "I need one detail from you before I can continue.",
      },
    }];
  }
  return [];
}

contractTest("runtime.process", "reference harness asks for a narrower slice instead of thrashing on a broad coding resume", async () => {
  const store = new InMemorySessionStore();
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  let thinkerCalls = 0;

  const toolGateway: ToolGateway = {
    async call<T>(name: string, input: unknown): Promise<T> {
      toolCalls.push({ name, input });
      if (name === "fs.list") {
        return buildAgentToolSuccessResult({ toolName: name, input, output: {
          path: ".",
          entries: [
            { path: "app", kind: "directory" },
            { path: "app/page.tsx", kind: "file" },
            { path: "package.json", kind: "file" },
          ],
        } }) as T;
      }
      if (name === "fs.read_text") {
        return buildAgentToolSuccessResult({ toolName: name, input, output: {
          path: "app/page.tsx",
          content: "export default function Page() { return <main>Time Travel Rentals</main>; }\n",
        } }) as T;
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
      const encodedInput = JSON.stringify(request.input);
      assert.equal(encodedInput.includes("\"filesystemResumeGuard\""), false);
      if (thinkerCalls >= 1) {
        return modelResponse({
          nextAction: {
            kind: "ask_user",
            prompt: "Which page, feature, or file should I focus on first?",
            waitFor: {
              kind: "user",
              eventType: "user.reply",
              metadata: {
                prompt: "Which page, feature, or file should I focus on first?",
                reason: "broad_scope",
              },
            },
          },
          reason: "The agent loop state says the broad request is still too open after grounded reads, so this asks for a narrower slice.",
        }) as T;
      }
      thinkerCalls += 1;
      return modelResponse({
        nextAction: {
          kind: "tool",
          name: "fs.read_text",
          input: {
            path: "app/page.tsx",
          },
        },
        reason: thinkerCalls === 1
          ? "This grounds the broad resume request in one concrete file before deciding whether to ask for clarification."
          : "The previous handoff asked for one more grounded read before clarification.",
        ...(thinkerCalls > 1
          ? {
              evidenceExpectations: {
                newEvidence: ["Confirm the same homepage file remains the only grounded resume anchor"],
              },
            }
          : {}),
      }) as T;
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
        name: "fs.list",
        description: "List files",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "fs.read_text",
        description: "Read text",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    ],
    capabilityManifestProvider: () => [
      {
        name: "fs.list",
        description: "List files",
        freshnessClass: "static",
        latencyClass: "low",
        costClass: "free",
        executionClass: "read_only",
        capabilityClasses: ["filesystem.list"],
      },
      {
        name: "fs.read_text",
        description: "Read text",
        freshnessClass: "static",
        latencyClass: "low",
        costClass: "free",
        executionClass: "read_only",
        capabilityClasses: ["filesystem.read"],
      },
    ],
  });

  const output = await kestrel.run({
    id: "evt-broad-resume-clarification",
    type: "user.message",
    sessionId: "session-broad-resume-clarification",
    payload: {
      message: "lets keep working on our time travel machine rental website please",
      modeSystemV2Enabled: true,
      interactionMode: "build",
      actSubmode: "safe",
      history: [],
    },
    stepAgent: registration.entryStepAgent,
  });

  assert.equal(output.status, "WAITING", JSON.stringify(output.errors));
  assert.equal(output.errors.length, 0);
  assert.equal(output.waitFor?.eventType, "user.reply");
  assert.match(String((output.waitFor?.metadata as Record<string, unknown>)?.prompt ?? ""), /which page, feature, or file/i);
  const toolNames = toolCalls.map((entry) => entry.name);
  assert.equal(toolNames.every((name) => name === "fs.read_text"), true);
  assert.equal(toolNames.length >= 1, true);
});
