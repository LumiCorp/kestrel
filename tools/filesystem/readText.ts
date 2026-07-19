import { readFile } from "node:fs/promises";

import type { SharedToolModule } from "../contracts.js";
import { createToolInputError, parseObjectInput, readNumber, readString } from "../helpers.js";
import {
  createFileSystemCapability,
  createFileSystemPresentation,
  clampPositiveInt,
  readOptionalPositiveInt,
  readRequiredPath,
  resolveExistingFileSystemPath,
} from "./shared.js";
import { textRevision } from "./textRevision.js";

const DEFAULT_FILE_PAGE_BYTES = 8 * 1024;
const MAX_FILE_PAGE_BYTES = 8 * 1024;

export const fsReadTextTool: SharedToolModule = {
  definition: {
    name: "fs.read_text",
    description: "Read an exact, revisioned UTF-8 page from a file. If complete is false, continue from nextOffsetBytes. A page is mutation evidence only for the returned revision and range.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offsetBytes: { type: "number", minimum: 0 },
        maxBytes: { type: "number", minimum: 1, maximum: MAX_FILE_PAGE_BYTES },
        expectedRevision: { type: "string", minLength: 1 },
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
      const maxBytes = clampPositiveInt(readOptionalPositiveInt(body, "maxBytes") ?? DEFAULT_FILE_PAGE_BYTES, MAX_FILE_PAGE_BYTES);
      const offsetBytes = Math.max(0, Math.trunc(readNumber(body, "offsetBytes") ?? 0));
      const resolved = await resolveExistingFileSystemPath(targetPath, context.fileSystem);
      if (resolved.stat.isFile() === false) {
        throw createToolInputError("fs.read_text", `Path is not a file: ${resolved.displayPath}`, { path: resolved.displayPath });
      }
      const buffer = await readFile(resolved.absolutePath);
      if (offsetBytes > buffer.length) {
        throw createToolInputError("fs.read_text", "offsetBytes is beyond the end of the file.", {
          path: resolved.displayPath,
          offsetBytes,
          totalBytes: buffer.length,
        });
      }
      if (offsetBytes > 0 && offsetBytes < buffer.length && (buffer[offsetBytes]! & 0xc0) === 0x80) {
        throw createToolInputError("fs.read_text", "offsetBytes must use a nextOffsetBytes value returned by fs.read_text.", {
          path: resolved.displayPath,
          offsetBytes,
        });
      }
      const revision = textRevision(buffer);
      const expectedRevision = readString(body, "expectedRevision");
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        throw createToolInputError("fs.read_text", `File revision changed before continuation: ${resolved.displayPath}`, {
          path: resolved.displayPath,
          expectedRevision,
          actualRevision: revision,
          nextSuggestedAction: "Restart the read at offsetBytes 0.",
        });
      }
      const endByte = utf8SafeEnd(buffer, offsetBytes, Math.min(buffer.length, offsetBytes + maxBytes));
      const content = buffer.subarray(offsetBytes, endByte).toString("utf8");
      const complete = endByte >= buffer.length;

      return {
        path: resolved.displayPath,
        content,
        revision,
        range: { startByte: offsetBytes, endByte },
        totalBytes: buffer.length,
        complete,
        hasMore: complete === false,
        ...(complete ? {} : { nextOffsetBytes: endByte }),
        truncated: complete === false,
        bytesRead: endByte - offsetBytes,
        maxBytes,
        encoding: "utf8",
      };
    };
  },
};

function utf8SafeEnd(buffer: Buffer, start: number, requestedEnd: number): number {
  let end = requestedEnd;
  while (end > start && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return end === start && requestedEnd < buffer.length ? requestedEnd : end;
}
