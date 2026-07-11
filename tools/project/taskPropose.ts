import { randomUUID } from "node:crypto";

import type { TaskPriority } from "../../src/missionControl/contracts.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import type { SharedToolModule } from "../contracts.js";
import { parseObjectInput, readString, requireStringField } from "../helpers.js";

const TOOL_NAME = "task.propose";

export const projectTaskProposeTool: SharedToolModule = {
  definition: {
    name: TOOL_NAME,
    description: "Propose a Mission Control task for durable implementation, validation, cleanup, or follow-up work. Proposed tasks require human approval before agents can claim or run them.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        title: {
          type: "string",
          description: "Short imperative task title, for example 'Add regression test for login timeout'.",
        },
        instructions: {
          type: "string",
          description: "Self-contained task instructions with acceptance or validation expectations.",
        },
        acceptanceCriteria: {
          type: "string",
          description: "Optional concrete acceptance criteria for human review.",
        },
        priority: {
          type: "string",
          enum: ["low", "medium", "high", "urgent"],
          description: "Optional task priority.",
        },
        summary: {
          type: "string",
          description: "Brief reason this task was proposed from the current conversation.",
        },
      },
      required: ["sessionId", "title", "instructions"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "volatile",
      latencyClass: "low",
      costClass: "free",
      executionClass: "external_side_effect",
      capabilityClasses: ["runtime.project.task_queue"],
      approvalCapabilities: ["project.task_queue.write"],
    },
    presentation: {
      displayName: "Propose Task",
      aliases: ["propose task", "add task", "new task"],
      keywords: ["project", "task", "queue", "mission", "follow-up"],
      provider: "kestrel",
      toolFamily: "project",
    },
  },
  createHandler(context) {
    return async (input: unknown) => {
      if (context.projectActions === undefined) {
        throw createRuntimeFailure(
          "TOOL_CONTEXT_INVALID",
          `${TOOL_NAME} requires tool context.projectActions.`,
          {
            subsystem: "tooling",
            toolName: TOOL_NAME,
            classification: "configuration",
            recoverable: false,
          },
        );
      }
      const body = parseObjectInput(TOOL_NAME, input);
      return context.projectActions.apply({
        type: "task.propose",
        actionId: randomUUID(),
        actionTs: new Date().toISOString(),
        sessionId: requireStringField(TOOL_NAME, body, "sessionId"),
        title: requireStringField(TOOL_NAME, body, "title"),
        instructions: requireStringField(TOOL_NAME, body, "instructions"),
        ...(readString(body, "acceptanceCriteria") !== undefined
          ? { acceptanceCriteria: readString(body, "acceptanceCriteria") }
          : {}),
        ...(readTaskPriority(body.priority) !== undefined ? { priority: readTaskPriority(body.priority) } : {}),
        ...(readString(body, "summary") !== undefined ? { summary: readString(body, "summary") } : {}),
      });
    };
  },
};

function readTaskPriority(value: unknown): TaskPriority | undefined {
  return value === "low" || value === "medium" || value === "high" || value === "urgent"
    ? value
    : undefined;
}
