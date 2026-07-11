import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SharedToolModule } from "../contracts.js";
import { createToolInputError, parseObjectInput, readString } from "../helpers.js";
import {
  buildPlanDocumentRelativePath,
  isPlanDocumentPath,
  resolvePlanDocumentAbsolutePath,
} from "../../src/runtime/planDocument.js";

export const planningWriteDocumentTool: SharedToolModule = {
  definition: {
    name: "planning.write_document",
    description: "Write the current session's canonical PLAN.md planning document without granting general workspace mutation. The path is optional; omitted path or PLAN.md resolves to the current session PLAN.md.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["content"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "volatile",
      latencyClass: "low",
      costClass: "free",
      executionClass: "planning_write",
      capabilityClasses: ["workspace.write.planning"],
    },
    presentation: {
      displayName: "Write Planning Document",
      aliases: ["write plan", "write planning document", "update plan"],
      keywords: ["plan", "planning", "document", "write"],
      provider: "kestrel",
      toolFamily: "runtime",
    },
  },
  createHandler(context) {
    return async (input: unknown) => {
      const body = parseObjectInput("planning.write_document", input);
      const rawPlanDocumentPath = readString(body, "path")?.trim();
      const content = readString(body, "content");
      if (content === undefined) {
        throw createToolInputError("planning.write_document", "planning.write_document requires input.content.", {
          field: "content",
        });
      }
      const planDocumentPath = resolveRequestedPlanDocumentPath({
        requestedPath: rawPlanDocumentPath,
        sessionId: context.runtime?.sessionId,
      });
      if (
        planDocumentPath === undefined ||
        path.isAbsolute(planDocumentPath) ||
        isPlanDocumentPath(planDocumentPath) === false
      ) {
        throw createToolInputError(
          "planning.write_document",
          "planning.write_document path must be a session-scoped PLAN.md path under ~/.kestrel.",
          { field: "path", path: planDocumentPath },
        );
      }

      const targetPath = resolvePlanDocumentAbsolutePath(planDocumentPath);
      if (targetPath === undefined) {
        throw createToolInputError(
          "planning.write_document",
          "planning.write_document path must resolve inside the Kestrel runtime home.",
          { field: "path", path: planDocumentPath },
        );
      }

      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, content, "utf8");

      return {
        path: planDocumentPath,
        bytesWritten: Buffer.byteLength(content, "utf8"),
      };
    };
  },
};

function resolveRequestedPlanDocumentPath(input: {
  requestedPath: string | undefined;
  sessionId: string | undefined;
}): string | undefined {
  const canonicalSessionPath = buildPlanDocumentRelativePath(input.sessionId);
  if (input.requestedPath === undefined || input.requestedPath.length === 0 || input.requestedPath === "PLAN.md") {
    return canonicalSessionPath;
  }
  if (canonicalSessionPath !== undefined && input.requestedPath !== canonicalSessionPath) {
    throw createToolInputError(
      "planning.write_document",
      "planning.write_document can only write the current session PLAN.md.",
      { field: "path", path: input.requestedPath, expectedPath: canonicalSessionPath },
    );
  }
  return input.requestedPath;
}
