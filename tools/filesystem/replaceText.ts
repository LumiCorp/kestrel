import { writeFile } from "node:fs/promises";

import type { SharedToolModule } from "../contracts.js";
import { createToolInputError, parseObjectInput, readString } from "../helpers.js";
import {
  MAX_TEXT_EDIT_BYTES,
  buildUtf8TextStats,
  createFileSystemCapability,
  createFileSystemPresentation,
  readBoolean,
  readRequiredPath,
  resolveExistingFileSystemPath,
  readUtf8TextFile,
} from "./shared.js";

export const fsReplaceTextTool: SharedToolModule = {
  definition: {
    name: "fs.replace_text",
    description: "Replace literal UTF-8 text in a file within the workspace or temp roots. Prefer this for targeted edits to existing files, especially when the task requires preserving surrounding structure, token count, formatting, or other allowed-change constraints. If the result status is NO_CHANGE or changed is false, the requested replacement did not happen. When editing tests, preserve existing assertions unless the requested behavior requires changing them.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        find: { type: "string" },
        replace: { type: "string" },
        all: { type: "boolean" },
      },
      required: ["path", "find", "replace"],
      additionalProperties: false,
    },
    capability: createFileSystemCapability("fs.patch", "sandboxed_only"),
    presentation: createFileSystemPresentation({
      displayName: "Replace Text",
      aliases: ["replace text", "patch text", "filesystem replace"],
      keywords: ["replace", "patch", "text", "filesystem"],
    }),
  },
  createHandler(context) {
    return async (input: unknown) => {
      const body = parseObjectInput("fs.replace_text", input);
      const targetPath = readRequiredPath(body, "path", "fs.replace_text");
      const find = readString(body, "find");
      if (find === undefined) {
        throw createToolInputError("fs.replace_text", "fs.replace_text requires input.find.", {
          field: "find",
        });
      }
      if (find.length === 0) {
        throw createToolInputError("fs.replace_text", "fs.replace_text input.find must not be empty.", {
          field: "find",
        });
      }
      const replace = readString(body, "replace");
      if (replace === undefined) {
        throw createToolInputError("fs.replace_text", "fs.replace_text requires input.replace.", {
          field: "replace",
        });
      }
      const replaceAll = readBoolean(body, "all") ?? false;
      const resolved = await resolveExistingFileSystemPath(targetPath, context.fileSystem);
      if (Number(resolved.stat.size) > MAX_TEXT_EDIT_BYTES) {
        throw createToolInputError("fs.replace_text", `File is too large for fs.replace_text: ${resolved.displayPath}`, {
          path: resolved.displayPath,
          maxBytes: MAX_TEXT_EDIT_BYTES,
        });
      }
      const current = await readUtf8TextFile({
        absolutePath: resolved.absolutePath,
        config: context.fileSystem,
        maxBytes: MAX_TEXT_EDIT_BYTES,
      });

      let count = 0;
      let nextContent = current.content;
      if (replaceAll) {
        count = countOccurrences(current.content, find);
        nextContent = current.content.replaceAll(find, replace);
      } else {
        const firstIndex = current.content.indexOf(find);
        if (firstIndex >= 0) {
          count = 1;
          nextContent =
            `${current.content.slice(0, firstIndex)}${replace}${current.content.slice(firstIndex + find.length)}`;
        }
      }

      if (count > 0) {
        await writeFile(resolved.absolutePath, nextContent, "utf8");
      }

      const findStats = buildUtf8TextStats(find);
      const replaceStats = buildUtf8TextStats(replace);
      const perReplacementWhitespaceTokenDelta = replaceStats.whitespaceTokens - findStats.whitespaceTokens;
      const baseResult = {
        path: current.displayPath,
        replacements: count,
        changed: count > 0,
        status: count > 0 ? "OK" : "NO_CHANGE",
        message: count > 0
          ? `Replaced ${count} occurrence${count === 1 ? "" : "s"}.`
          : "No occurrences matched; file was not changed.",
        findWhitespaceTokenCount: findStats.whitespaceTokens,
        replaceWhitespaceTokenCount: replaceStats.whitespaceTokens,
        perReplacementWhitespaceTokenDelta,
      };
      if (count === 0) {
        return baseResult;
      }
      const beforeStats = buildUtf8TextStats(current.content);
      const afterStats = buildUtf8TextStats(nextContent);
      return {
        ...baseResult,
        bytesBefore: beforeStats.bytes,
        bytesAfter: afterStats.bytes,
        lineCountBefore: beforeStats.lines,
        lineCountAfter: afterStats.lines,
        whitespaceTokenCountBefore: beforeStats.whitespaceTokens,
        whitespaceTokenCountAfter: afterStats.whitespaceTokens,
        lineCountDelta: afterStats.lines - beforeStats.lines,
        whitespaceTokenCountDelta: afterStats.whitespaceTokens - beforeStats.whitespaceTokens,
      };
    };
  },
};

function countOccurrences(content: string, find: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= content.length) {
    const index = content.indexOf(find, offset);
    if (index < 0) {
      return count;
    }
    count += 1;
    offset = index + find.length;
  }
  return count;
}
