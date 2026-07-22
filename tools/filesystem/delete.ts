import { opendir, rm } from "node:fs/promises";

import type { SharedToolModule } from "../contracts.js";
import { createToolInputError, parseObjectInput } from "../helpers.js";
import {
  createFileSystemCapability,
  assertWorkspaceSkillStateMutationAllowed,
  createFileSystemPresentation,
  readBoolean,
  readRequiredPath,
  resolveExistingFileSystemPath,
} from "./shared.js";

export const fsDeleteTool: SharedToolModule = {
  definition: {
    name: "fs.delete",
    description: "Delete a file or directory within the workspace or temp roots.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    capability: createFileSystemCapability("fs.delete", "sandboxed_only"),
    presentation: createFileSystemPresentation({
      displayName: "Delete Files",
      aliases: ["delete files", "filesystem delete", "remove path"],
      keywords: ["delete", "remove", "filesystem", "path"],
    }),
  },
  createHandler(context) {
    return async (input: unknown) => {
      const body = parseObjectInput("fs.delete", input);
      const targetPath = readRequiredPath(body, "path", "fs.delete");
      const recursive = readBoolean(body, "recursive") ?? false;
      const resolved = await resolveExistingFileSystemPath(targetPath, context.fileSystem);
      assertWorkspaceSkillStateMutationAllowed({ absolutePath: resolved.absolutePath, config: context.fileSystem, toolName: "fs.delete", destructive: true });

      if (resolved.stat.isDirectory() && recursive === false) {
        const directory = await opendir(resolved.absolutePath);
        try {
          if (await directory.read() !== null) {
            throw createToolInputError("fs.delete", `Directory is not empty: ${resolved.displayPath}`, {
              path: resolved.displayPath,
            });
          }
        } finally {
          await directory.close();
        }
      }

      await rm(resolved.absolutePath, {
        recursive,
        force: false,
      });

      return {
        path: resolved.displayPath,
        recursive,
      };
    };
  },
};
