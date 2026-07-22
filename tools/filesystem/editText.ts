import { readFile } from "node:fs/promises";

import type { SharedToolModule } from "../contracts.js";
import { createToolInputError, parseObjectInput, readString } from "../helpers.js";
import {
  MAX_TEXT_EDIT_BYTES,
  assertWorkspaceSkillStateMutationAllowed,
  buildUtf8TextStats,
  createFileSystemCapability,
  createFileSystemPresentation,
  readBoolean,
  readRequiredPath,
  resolveExistingFileSystemPath,
} from "./shared.js";
import {
  assertExpectedRevision,
  buildUnifiedTextDiff,
  textRevision,
  writeTextAtomically,
} from "./textRevision.js";

interface TextEdit {
  find: string;
  replace: string;
  all: boolean;
}

export const fsEditTextTool: SharedToolModule = {
  definition: {
    name: "fs.edit_text",
    description: "Apply exact literal edits to one existing UTF-8 file at a required revision. Each match must be unique unless all is explicitly true.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        expectedRevision: { type: "string", minLength: 1 },
        edits: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              find: { type: "string", minLength: 1 },
              replace: { type: "string" },
              all: { type: "boolean" },
            },
            required: ["find", "replace"],
          },
        },
      },
      required: ["path", "expectedRevision", "edits"],
      additionalProperties: false,
    },
    capability: createFileSystemCapability("fs.patch", "sandboxed_only"),
    presentation: createFileSystemPresentation({
      displayName: "Edit Text",
      aliases: ["edit text", "exact edit", "structured edit"],
      keywords: ["edit", "patch", "revision", "text"],
    }),
  },
  createHandler(context) {
    return async (input: unknown) => {
      const body = parseObjectInput("fs.edit_text", input);
      const targetPath = readRequiredPath(body, "path", "fs.edit_text");
      const expectedRevision = readString(body, "expectedRevision");
      if (expectedRevision === undefined) {
        throw createToolInputError("fs.edit_text", "fs.edit_text requires input.expectedRevision.", { field: "expectedRevision" });
      }
      const edits = parseEdits(body.edits);
      const resolved = await resolveExistingFileSystemPath(targetPath, context.fileSystem);
      assertWorkspaceSkillStateMutationAllowed({ absolutePath: resolved.absolutePath, config: context.fileSystem, toolName: "fs.edit_text" });
      if (resolved.stat.isFile() === false || resolved.stat.size > MAX_TEXT_EDIT_BYTES) {
        throw createToolInputError("fs.edit_text", `File is not an editable UTF-8 file: ${resolved.displayPath}`, {
          path: resolved.displayPath,
          maxBytes: MAX_TEXT_EDIT_BYTES,
        });
      }
      const beforeBuffer = await readFile(resolved.absolutePath);
      const before = beforeBuffer.toString("utf8");
      const beforeRevision = textRevision(beforeBuffer);
      assertExpectedRevision({ toolName: "fs.edit_text", path: resolved.displayPath, expectedRevision, actualRevision: beforeRevision });

      let after = before;
      let replacements = 0;
      for (const edit of edits) {
        const count = countOccurrences(after, edit.find);
        if (count === 0) {
          throw createToolInputError("fs.edit_text", `Edit text was not found in ${resolved.displayPath}.`, {
            path: resolved.displayPath,
            recoverable: true,
          });
        }
        if (edit.all === false && count !== 1) {
          throw createToolInputError("fs.edit_text", `Edit text is ambiguous in ${resolved.displayPath}; found ${count} occurrences.`, {
            path: resolved.displayPath,
            occurrences: count,
            recoverable: true,
            nextSuggestedAction: "Use a larger exact literal or explicitly set all to true.",
          });
        }
        replacements += edit.all ? count : 1;
        after = edit.all ? after.replaceAll(edit.find, edit.replace) : after.replace(edit.find, edit.replace);
      }
      const diff = await buildUnifiedTextDiff({ displayPath: resolved.displayPath, before, after });
      await writeTextAtomically({ absolutePath: resolved.absolutePath, content: after, mode: Number(resolved.lstat.mode) });
      const afterRevision = textRevision(after);
      const beforeStats = buildUtf8TextStats(before);
      const afterStats = buildUtf8TextStats(after);
      return {
        path: resolved.displayPath,
        changed: true,
        replacements,
        beforeRevision,
        afterRevision,
        bytesBefore: beforeStats.bytes,
        bytesAfter: afterStats.bytes,
        lineCountBefore: beforeStats.lines,
        lineCountAfter: afterStats.lines,
        diff,
      };
    };
  },
};

function parseEdits(value: unknown): TextEdit[] {
  if (Array.isArray(value) === false || value.length === 0) {
    throw createToolInputError("fs.edit_text", "fs.edit_text requires a non-empty input.edits array.", { field: "edits" });
  }
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw createToolInputError("fs.edit_text", `edits[${index}] must be an object.`, { field: `edits[${index}]` });
    }
    const record = entry as Record<string, unknown>;
    const find = typeof record.find === "string" ? record.find : undefined;
    const replace = typeof record.replace === "string" ? record.replace : undefined;
    if (find === undefined || find.length === 0 || replace === undefined) {
      throw createToolInputError("fs.edit_text", `edits[${index}] requires non-empty find and string replace.`, { field: `edits[${index}]` });
    }
    return { find, replace, all: readBoolean(record, "all") ?? false };
  });
}

function countOccurrences(content: string, find: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= content.length) {
    const index = content.indexOf(find, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + find.length;
  }
  return count;
}
