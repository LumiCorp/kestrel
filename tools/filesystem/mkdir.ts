import { mkdir } from "node:fs/promises";

import type { SharedToolModule } from "../contracts.js";
import { parseObjectInput } from "../helpers.js";
import {
  createFileSystemCapability,
  assertWorkspaceSkillStateMutationAllowed,
  createFileSystemPresentation,
  readBoolean,
  readRequiredPath,
  resolveTargetFileSystemPath,
} from "./shared.js";

export const fsMkdirTool: SharedToolModule = {
  definition: {
    name: "fs.mkdir",
    description:
      "Create a directory within the workspace or temp roots. Use an explicit child path, not '.' or the already-provisioned workspace root. Returns an acknowledgment with the resolved path and recursion flag; successful completion does not emit a visible artifact.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    capability: createFileSystemCapability("fs.mkdir", "sandboxed_only"),
    presentation: createFileSystemPresentation({
      displayName: "Make Directory",
      aliases: ["make directory", "mkdir", "create folder"],
      keywords: ["mkdir", "directory", "folder", "filesystem"],
    }),
  },
  createHandler(context) {
    return async (input: unknown) => {
      const body = parseObjectInput("fs.mkdir", input);
      const targetPath = readRequiredPath(body, "path", "fs.mkdir");
      const recursive = readBoolean(body, "recursive") ?? true;
      const resolved = await resolveTargetFileSystemPath(targetPath, context.fileSystem);
      assertWorkspaceSkillStateMutationAllowed({ absolutePath: resolved.absolutePath, config: context.fileSystem, toolName: "fs.mkdir" });

      await mkdir(resolved.absolutePath, { recursive });

      return {
        path: resolved.displayPath,
        recursive,
      };
    };
  },
};
