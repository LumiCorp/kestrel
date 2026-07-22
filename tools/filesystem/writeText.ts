import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SharedToolModule } from "../contracts.js";
import { createToolInputError, parseObjectInput, readString } from "../helpers.js";
import {
  MAX_FILE_READ_BYTES,
  assertWorkspaceSkillStateMutationAllowed,
  buildUtf8TextStats,
  createFileSystemCapability,
  createFileSystemPresentation,
  ensureParentDirectory,
  pathExists,
  readBoolean,
  readRequiredPath,
  resolveTargetFileSystemPath,
} from "./shared.js";

export const fsWriteTextTool: SharedToolModule = {
  definition: {
    name: "fs.write_text",
    description: "Write or append UTF-8 text within the workspace or temp roots. Use for explicit file creation, generated whole-file artifacts, or replacing an entire file only when the task calls for whole-file output. For existing files with structure, token, formatting, or allowed-change constraints, prefer fs.replace_text or a bounded script that preserves unchanged content. For requested framework/project scaffolds, prefer the normal shell generator command when available. When editing tests, preserve existing assertions unless the requested behavior requires changing them.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        mode: { type: "string", enum: ["overwrite", "append"] },
        createParents: { type: "boolean" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    capability: createFileSystemCapability("fs.write", "sandboxed_only"),
    presentation: createFileSystemPresentation({
      displayName: "Write Text File",
      aliases: ["write text", "write file", "filesystem write"],
      keywords: ["write", "text", "file", "filesystem"],
    }),
  },
  createHandler(context) {
    return async (input: unknown) => {
      const body = parseObjectInput("fs.write_text", input);
      const targetPath = readRequiredPath(body, "path", "fs.write_text");
      const content = readString(body, "content");
      if (content === undefined) {
        throw createToolInputError("fs.write_text", "fs.write_text requires input.content.", {
          field: "content",
        });
      }
      const mode = readString(body, "mode") ?? "overwrite";
      if (mode !== "overwrite" && mode !== "append") {
        throw createToolInputError("fs.write_text", "fs.write_text input.mode must be 'overwrite' or 'append'.", {
          field: "mode",
          receivedValue: mode,
        });
      }

      const createParents = readBoolean(body, "createParents") ?? false;
      const resolved = await resolveTargetFileSystemPath(targetPath, context.fileSystem);
      assertWorkspaceSkillStateMutationAllowed({ absolutePath: resolved.absolutePath, config: context.fileSystem, toolName: "fs.write_text" });

      if (createParents) {
        await mkdir(path.dirname(resolved.absolutePath), { recursive: true });
      } else {
        await ensureParentDirectory(resolved.absolutePath, context.fileSystem);
      }

      if (mode === "append" && (await pathExists(resolved.absolutePath)) === false) {
        await ensureParentDirectory(resolved.absolutePath, context.fileSystem);
      }

      const existed = await pathExists(resolved.absolutePath);
      const bytesWritten = Buffer.byteLength(content, "utf8");
      const beforeFileStats = existed ? await stat(resolved.absolutePath) : undefined;
      const bytesBefore = beforeFileStats !== undefined ? Number(beforeFileStats.size) : undefined;
      const beforeContent = existed && mode === "overwrite" && (bytesBefore ?? 0) <= MAX_FILE_READ_BYTES
        ? await readFile(resolved.absolutePath, "utf8")
        : undefined;

      await writeFile(resolved.absolutePath, content, {
        encoding: "utf8",
        flag: mode === "append" ? "a" : "w",
      });

      const bytesAfter = mode === "append" && bytesBefore !== undefined
        ? bytesBefore + bytesWritten
        : bytesWritten;
      const baseResult = {
        path: resolved.displayPath,
        mode,
        bytesWritten,
        existed,
      };
      if (mode === "append") {
        if (existed && bytesAfter <= MAX_FILE_READ_BYTES) {
          const afterContent = await readFile(resolved.absolutePath, "utf8");
          return {
            ...baseResult,
            ...buildAppendFacts(afterContent),
          };
        }
        return {
          ...baseResult,
          ...(existed
            ? {
              bytesAfter,
              statsTruncated: true,
            }
            : {}),
        };
      }

      if (beforeContent === undefined) {
        return existed
          ? {
            ...baseResult,
            ...(bytesBefore !== undefined ? { bytesBefore } : {}),
            bytesAfter,
            ...(bytesBefore !== undefined && bytesBefore !== bytesAfter ? { changed: true } : {}),
            statsTruncated: true,
          }
          : baseResult;
      }

      const afterContent = content;
      if (bytesWritten > MAX_FILE_READ_BYTES) {
        return {
          ...baseResult,
          bytesBefore,
          bytesAfter,
          changed: beforeContent !== afterContent,
          statsTruncated: true,
        };
      }

      const beforeStats = buildUtf8TextStats(beforeContent);
      const afterStats = buildUtf8TextStats(afterContent);
      return {
        ...baseResult,
        changed: beforeContent !== afterContent,
        bytesBefore: beforeStats.bytes,
        bytesAfter: afterStats.bytes,
        lineCountBefore: beforeStats.lines,
        lineCountAfter: afterStats.lines,
        whitespaceTokenCountBefore: beforeStats.whitespaceTokens,
        whitespaceTokenCountAfter: afterStats.whitespaceTokens,
        diffPreview: buildDiffPreview(beforeContent, afterContent),
      };
    };
  },
};

function buildAppendFacts(content: string): Record<string, unknown> {
  const stats = buildUtf8TextStats(content);
  return {
    bytesAfter: stats.bytes,
    lineCountAfter: stats.lines,
    whitespaceTokenCountAfter: stats.whitespaceTokens,
  };
}

function buildDiffPreview(before: string, after: string): {
  before: string;
  after: string;
  truncated: boolean;
} {
  if (before === after) {
    return {
      before: "",
      after: "",
      truncated: false,
    };
  }
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  const maxSuffix = Math.min(before.length - prefix, after.length - prefix);
  while (
    suffix < maxSuffix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const contextChars = 160;
  const beforeStart = Math.max(0, prefix - contextChars);
  const afterStart = Math.max(0, prefix - contextChars);
  const beforeEnd = Math.min(before.length, before.length - suffix + contextChars);
  const afterEnd = Math.min(after.length, after.length - suffix + contextChars);
  const beforePreview = before.slice(beforeStart, beforeEnd);
  const afterPreview = after.slice(afterStart, afterEnd);
  return {
    before: beforePreview,
    after: afterPreview,
    truncated: beforeStart > 0 ||
      afterStart > 0 ||
      beforeEnd < before.length ||
      afterEnd < after.length,
  };
}
