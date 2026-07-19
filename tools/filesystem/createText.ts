import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SharedToolModule } from "../contracts.js";
import { createToolInputError, parseObjectInput, readString } from "../helpers.js";
import {
  createFileSystemCapability,
  createFileSystemPresentation,
  ensureParentDirectory,
  readBoolean,
  readRequiredPath,
  resolveTargetFileSystemPath,
} from "./shared.js";
import { textRevision } from "./textRevision.js";

export const fsCreateTextTool: SharedToolModule = {
  definition: {
    name: "fs.create_text",
    description: "Create a new UTF-8 text file. This tool never overwrites or appends to an existing file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        createParents: { type: "boolean" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    capability: createFileSystemCapability("fs.write", "sandboxed_only"),
    presentation: createFileSystemPresentation({
      displayName: "Create Text File",
      aliases: ["create text", "create file"],
      keywords: ["create", "text", "file", "filesystem"],
    }),
  },
  createHandler(context) {
    return async (input: unknown) => {
      const body = parseObjectInput("fs.create_text", input);
      const targetPath = readRequiredPath(body, "path", "fs.create_text");
      const content = readString(body, "content");
      if (content === undefined) {
        throw createToolInputError("fs.create_text", "fs.create_text requires input.content.", { field: "content" });
      }
      const resolved = await resolveTargetFileSystemPath(targetPath, context.fileSystem);
      if (readBoolean(body, "createParents") === true) {
        await mkdir(path.dirname(resolved.absolutePath), { recursive: true });
      } else {
        await ensureParentDirectory(resolved.absolutePath, context.fileSystem);
      }
      try {
        await writeFile(resolved.absolutePath, content, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw createToolInputError("fs.create_text", `Destination already exists: ${resolved.displayPath}`, {
            path: resolved.displayPath,
            recoverable: true,
            nextSuggestedAction: "Use fs.edit_text or fs.apply_patch with the latest file revision.",
          });
        }
        throw error;
      }
      return {
        path: resolved.displayPath,
        created: true,
        bytesWritten: Buffer.byteLength(content, "utf8"),
        revision: textRevision(content),
      };
    };
  },
};
