import type { SharedToolModule } from "../contracts.js";
import { parseObjectInput } from "../helpers.js";
import {
  createFileSystemCapability,
  createFileSystemPresentation,
  DEFAULT_FILE_READ_MAX_BYTES,
  MAX_FILE_READ_BYTES,
  clampPositiveInt,
  readOptionalPositiveInt,
  readRequiredPath,
  readUtf8TextFile,
} from "./shared.js";

export const fsReadTextTool: SharedToolModule = {
  definition: {
    name: "fs.read_text",
    description: "Read a UTF-8 text file from the workspace or temp roots.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        maxBytes: { type: "number" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    capability: createFileSystemCapability("fs.read", "read_only"),
    presentation: createFileSystemPresentation({
      displayName: "Read Text File",
      aliases: ["read text", "read file", "filesystem read"],
      keywords: ["read", "text", "file", "filesystem"],
    }),
  },
  createHandler(context) {
    return async (input: unknown) => {
      const body = parseObjectInput("fs.read_text", input);
      const targetPath = readRequiredPath(body, "path", "fs.read_text");
      const maxBytes = clampPositiveInt(
        readOptionalPositiveInt(body, "maxBytes") ?? DEFAULT_FILE_READ_MAX_BYTES,
        MAX_FILE_READ_BYTES,
      );
      const result = await readUtf8TextFile({
        absolutePath: targetPath,
        config: context.fileSystem,
        maxBytes,
      });

      return {
        path: result.displayPath,
        content: result.content,
        truncated: result.truncated,
        bytesRead: result.bytesRead,
        maxBytes: result.maxBytes,
        encoding: "utf8",
      };
    };
  },
};
