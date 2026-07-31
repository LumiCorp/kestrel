import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import type { SharedToolModule } from "../contracts.js";
import {
  createToolInputError,
  parseObjectInput,
  readNumber,
  requireStringField,
} from "../helpers.js";

const TOOL_NAME = "task.propose";

export const projectTaskProposeTool: SharedToolModule = {
  definition: {
    name: TOOL_NAME,
    description: "Propose a project-scoped Mission Control work item for durable implementation, validation, cleanup, or follow-up work. The active project is bound by the trusted runtime context, and proposed work requires operator approval before execution.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short imperative task title, for example 'Add regression test for login timeout'.",
        },
        instructions: {
          type: "string",
          description: "Self-contained task instructions with acceptance or validation expectations.",
        },
        order: {
          type: "integer",
          minimum: 1,
          description: "Optional positive one-based position within the Proposed phase.",
        },
      },
      required: ["title", "instructions"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "volatile",
      latencyClass: "low",
      costClass: "free",
      executionClass: "external_side_effect",
      allowedInteractionModes: ["chat", "plan", "build"],
      capabilityClasses: ["runtime.mission_control.work_item"],
      approvalCapabilities: ["mission_control.work_item.write"],
    },
    presentation: {
      displayName: "Propose Task",
      aliases: ["propose task", "add task", "new task"],
      keywords: ["project", "task", "mission", "follow-up"],
      provider: "kestrel",
      toolFamily: "project",
    },
  },
  createHandler(context) {
    return async (input: unknown) => {
      if (context.missionControlActions === undefined) {
        throw createRuntimeFailure(
          "TOOL_CONTEXT_INVALID",
          `${TOOL_NAME} requires tool context.missionControlActions.`,
          {
            subsystem: "tooling",
            toolName: TOOL_NAME,
            classification: "configuration",
            recoverable: false,
          },
        );
      }
      const projectId = context.runtime?.projectId;
      if (projectId === undefined) {
        throw createRuntimeFailure(
          "MISSION_CONTROL_PROJECT_CONTEXT_REQUIRED",
          `${TOOL_NAME} requires an active registered project context.`,
          {
            subsystem: "tooling",
            toolName: TOOL_NAME,
            classification: "input",
            recoverable: true,
          },
        );
      }
      const body = parseObjectInput(TOOL_NAME, input);
      const order = readPositiveOrder(body);
      return context.missionControlActions.propose({
        projectId,
        title: requireStringField(TOOL_NAME, body, "title"),
        instructions: requireStringField(TOOL_NAME, body, "instructions"),
        ...(order !== undefined ? { order } : {}),
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
