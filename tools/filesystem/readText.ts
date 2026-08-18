import { readFile } from "node:fs/promises";

import {
  isFileTextReadToolName,
  type FileTextReadToolName,
} from "../../src/runtime/fileTextReadTools.js";
import type { SharedToolContext, SharedToolModule } from "../contracts.js";
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

export { isFileTextReadToolName };

export const fsReadTextTool: SharedToolModule = {
  definition: {
    name: "fs.read_text",
    description: "Read the first exact, revisioned UTF-8 page of a file from byte zero. If complete is false, invoke the returned nextPage action exactly to continue with fs.read_text_page.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        maxBytes: { type: "number", minimum: 1, maximum: MAX_FILE_PAGE_BYTES },
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
      if (Object.hasOwn(body, "offsetBytes") || Object.hasOwn(body, "expectedRevision")) {
        throw createToolInputError(
          "fs.read_text",
          "fs.read_text only reads the first page. Continue with fs.read_text_page using the exact returned nextPage.input.",
          {
            nextSuggestedAction: "Call fs.read_text_page with the exact nextPage.input returned by fs.read_text.",
          },
        );
      }
      return readTextPage({
        toolName: "fs.read_text",
        targetPath: readRequiredPath(body, "path", "fs.read_text"),
        maxBytes: readPageSize(body),
        offsetBytes: 0,
        context,
      });
    };
  },
};

export const fsReadTextPageTool: SharedToolModule = {
  definition: {
    name: "fs.read_text_page",
    description: "Continue an incomplete fs.read_text read. Pass the exact path, positive offsetBytes, expectedRevision, and maxBytes from the preceding page's nextPage.input.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offsetBytes: { type: "number", minimum: 1 },
        expectedRevision: {
          type: "string",
          minLength: 1,
          description: "Copy the exact revision from the preceding page's nextPage.input. Do not use placeholders such as \"latest\" or \"initial\".",
        },
        maxBytes: { type: "number", minimum: 1, maximum: MAX_FILE_PAGE_BYTES },
      },
      required: ["path", "offsetBytes", "expectedRevision"],
      additionalProperties: false,
    },
    capability: createFileSystemCapability("fs.read", "read_only"),
    presentation: createFileSystemPresentation({
      displayName: "Continue Reading Text File",
      aliases: ["read text page", "continue read", "filesystem read page"],
      keywords: ["read", "text", "page", "continue", "filesystem"],
    }),
  },
  createHandler(context) {
    return async (input: unknown) => {
      const body = parseObjectInput("fs.read_text_page", input);
      const targetPath = readRequiredPath(body, "path", "fs.read_text_page");
      const offsetValue = readNumber(body, "offsetBytes");
      if (offsetValue === undefined || Number.isFinite(offsetValue) === false || offsetValue < 1) {
        throw createToolInputError(
          "fs.read_text_page",
          "offsetBytes must be a positive nextPage.input offset returned by the preceding page.",
          { path: targetPath, offsetBytes: offsetValue },
        );
      }
      const expectedRevision = readString(body, "expectedRevision");
      if (expectedRevision === undefined || expectedRevision.length === 0) {
        throw createToolInputError(
          "fs.read_text_page",
          "expectedRevision is required and must be copied from the preceding page's nextPage.input.",
          { path: targetPath, offsetBytes: offsetValue },
        );
      }
      return readTextPage({
        toolName: "fs.read_text_page",
        targetPath,
        maxBytes: readPageSize(body),
        offsetBytes: Math.trunc(offsetValue),
        expectedRevision,
        context,
      });
    };
  },
};

interface ReadTextPageInput {
  toolName: FileTextReadToolName;
  targetPath: string;
  maxBytes: number;
  offsetBytes: number;
  expectedRevision?: string | undefined;
  context: SharedToolContext;
}

async function readTextPage(input: ReadTextPageInput): Promise<Record<string, unknown>> {
  const resolved = await resolveExistingFileSystemPath(
    input.targetPath,
    input.context.fileSystem,
  );
  if (resolved.stat.isFile() === false) {
    throw createToolInputError(
      input.toolName,
      `Path is not a file: ${resolved.displayPath}`,
      { path: resolved.displayPath },
    );
  }
  const buffer = await readFile(resolved.absolutePath);
  if (input.offsetBytes > buffer.length) {
    throw createToolInputError(input.toolName, "offsetBytes is beyond the end of the file.", {
      path: resolved.displayPath,
      offsetBytes: input.offsetBytes,
      totalBytes: buffer.length,
    });
  }
  if (
    input.offsetBytes > 0 &&
    input.offsetBytes < buffer.length &&
    (buffer[input.offsetBytes]! & 0xc0) === 0x80
  ) {
    throw createToolInputError(
      input.toolName,
      "offsetBytes must use the exact nextPage.input value returned by the preceding read page.",
      { path: resolved.displayPath, offsetBytes: input.offsetBytes },
    );
  }
  const revision = textRevision(buffer);
  if (input.expectedRevision !== undefined && input.expectedRevision !== revision) {
    throw createToolInputError(
      input.toolName,
      `File revision changed before continuation: ${resolved.displayPath}`,
      {
        path: resolved.displayPath,
        expectedRevision: input.expectedRevision,
        actualRevision: revision,
        nextSuggestedAction: "Restart the read with fs.read_text.",
      },
    );
  }
  const endByte = utf8SafeEnd(
    buffer,
    input.offsetBytes,
    Math.min(buffer.length, input.offsetBytes + input.maxBytes),
  );
  const content = buffer.subarray(input.offsetBytes, endByte).toString("utf8");
  const complete = endByte >= buffer.length;
  const nextPage = complete
    ? undefined
    : {
        tool: "fs.read_text_page" as const,
        input: {
          path: resolved.displayPath,
          offsetBytes: endByte,
          expectedRevision: revision,
          maxBytes: input.maxBytes,
        },
      };

  return {
    path: resolved.displayPath,
    content,
    revision,
    range: { startByte: input.offsetBytes, endByte },
    totalBytes: buffer.length,
    complete,
    hasMore: complete === false,
    ...(nextPage === undefined ? {} : { nextOffsetBytes: endByte, nextPage }),
    truncated: complete === false,
    bytesRead: endByte - input.offsetBytes,
    maxBytes: input.maxBytes,
    encoding: "utf8",
  };
}

function readPageSize(body: Record<string, unknown>): number {
  return clampPositiveInt(
    readOptionalPositiveInt(body, "maxBytes") ?? DEFAULT_FILE_PAGE_BYTES,
    MAX_FILE_PAGE_BYTES,
  );
}

function utf8SafeEnd(buffer: Buffer, start: number, requestedEnd: number): number {
  let end = requestedEnd;
  while (end > start && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  if (end !== start || requestedEnd >= buffer.length) {
    return end;
  }
  end = requestedEnd;
  while (end < buffer.length && (buffer[end]! & 0xc0) === 0x80) {
    end += 1;
  }
  return end;
}
