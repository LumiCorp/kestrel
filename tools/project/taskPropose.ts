import { randomUUID } from "node:crypto";

import type { TaskPriority } from "../../src/missionControl/contracts.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import type { SharedToolModule } from "../contracts.js";
import {
  createToolInputError,
  parseObjectInput,
  readNumber,
  readString,
  requireStringField,
} from "../helpers.js";

const TOOL_NAME = "task.propose";

export const projectTaskProposeTool: SharedToolModule = {
  definition: {
    name: TOOL_NAME,
    description: "Propose a Mission Control task or revise an existing agent-authored proposal for durable implementation, validation, cleanup, or follow-up work. Proposed tasks require human approval before agents can claim or run them.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        taskId: {
          type: "string",
          description: "Optional existing agent-authored proposed task id to revise instead of creating a new task.",
        },
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
        order: {
          type: "integer",
          minimum: 1,
          description: "Optional positive one-based queue position for this proposal.",
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
      allowedInteractionModes: ["chat", "plan", "build"],
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
      const taskId = readString(body, "taskId");
      if (taskId !== undefined && taskId.trim().length === 0) {
        throw createToolInputError(TOOL_NAME, "task.propose taskId must be a non-empty string.", {
          field: "taskId",
        });
      }
      const order = readPositiveOrder(body);
      return context.projectActions.apply({
        type: "task.propose",
        actionId: randomUUID(),
        actionTs: new Date().toISOString(),
        sessionId: requireStringField(TOOL_NAME, body, "sessionId"),
        ...(taskId !== undefined ? { taskId: taskId.trim() } : {}),
        title: requireStringField(TOOL_NAME, body, "title"),
        instructions: requireStringField(TOOL_NAME, body, "instructions"),
        ...(readString(body, "acceptanceCriteria") !== undefined
          ? { acceptanceCriteria: readString(body, "acceptanceCriteria") }
          : {}),
        ...(readTaskPriority(body.priority) !== undefined ? { priority: readTaskPriority(body.priority) } : {}),
        ...(order !== undefined ? { order } : {}),
        ...(readString(body, "summary") !== undefined ? { summary: readString(body, "summary") } : {}),
      });
    };
  },
};

function readPositiveOrder(body: Record<string, unknown>): number | undefined {
  const order = readNumber(body, "order");
  if (order === undefined) {
    return ;
  }
  if (Number.isInteger(order) === false || order < 1) {
    throw createToolInputError(TOOL_NAME, "task.propose order must be a positive integer.", {
      field: "order",
      order,
    });
  }
  return order;
}

function readTaskPriority(value: unknown): TaskPriority | undefined {
  return value === "low" || value === "medium" || value === "high" || value === "urgent"
    ? value
    : undefined;
}
