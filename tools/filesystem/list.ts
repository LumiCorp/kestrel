import type { SharedToolModule } from "../contracts.js";
import { parseObjectInput } from "../helpers.js";
import {
  createFileSystemCapability,
  createFileSystemPresentation,
  DEFAULT_LIST_MAX_DEPTH,
  listFileSystemDirectory,
  readBoolean,
  readOptionalNonNegativeInt,
  readRequiredPath,
} from "./shared.js";

export const fsListTool: SharedToolModule = {
  definition: {
    name: "fs.list",
    description: "List files and directories within the workspace or temp roots.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean" },
        maxDepth: { type: "number" },
        includeHidden: { type: "boolean" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    capability: createFileSystemCapability("fs.list", "read_only"),
    presentation: createFileSystemPresentation({
      displayName: "List Files",
      aliases: ["list files", "filesystem list", "directory listing"],
      keywords: ["list", "filesystem", "directory", "files"],
    }),
  },
  createHandler(context) {
    return async (input: unknown) => {
      const body = parseObjectInput("fs.list", input);
      const targetPath = readRequiredPath(body, "path", "fs.list");
      const recursive = readBoolean(body, "recursive") ?? false;
      const includeHidden = readBoolean(body, "includeHidden") ?? false;
      const maxDepth = readOptionalNonNegativeInt(body, "maxDepth") ?? DEFAULT_LIST_MAX_DEPTH;

      return listFileSystemDirectory({
        absolutePath: targetPath,
        config: context.fileSystem,
        recursive,
        maxDepth,
        includeHidden,
      });
    };
  },
};
