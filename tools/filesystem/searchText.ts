import type { SharedToolModule } from "../contracts.js";
import { assertString, parseObjectInput } from "../helpers.js";
import {
  createFileSystemCapability,
  createFileSystemPresentation,
  DEFAULT_SEARCH_MAX_PREVIEW_CHARS,
  DEFAULT_SEARCH_MAX_RESULTS,
  DEFAULT_SEARCH_MAX_TOTAL_PREVIEW_CHARS,
  MAX_SEARCH_MAX_PREVIEW_CHARS,
  MAX_SEARCH_MAX_TOTAL_PREVIEW_CHARS,
  MIN_SEARCH_MAX_PREVIEW_CHARS,
  MIN_SEARCH_MAX_TOTAL_PREVIEW_CHARS,
  readBoolean,
  readOptionalBoundedPositiveInt,
  readOptionalGlob,
  readOptionalPositiveInt,
  readRequiredPath,
  searchUtf8Text,
} from "./shared.js";

export const fsSearchTextTool: SharedToolModule = {
  definition: {
    name: "fs.search_text",
    description: "Search UTF-8 text files within the workspace or temp roots.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        query: { type: "string" },
        glob: { type: "string" },
        caseSensitive: { type: "boolean" },
        maxResults: { type: "number" },
        maxPreviewChars: { type: "number" },
        maxTotalPreviewChars: { type: "number" },
      },
      required: ["path", "query"],
      additionalProperties: false,
    },
    capability: createFileSystemCapability("fs.search", "read_only"),
    presentation: createFileSystemPresentation({
      displayName: "Search Text",
      aliases: ["search text", "grep files", "filesystem search"],
      keywords: ["search", "text", "grep", "filesystem"],
    }),
  },
  createHandler(context) {
    return async (input: unknown) => {
      const body = parseObjectInput("fs.search_text", input);
      const targetPath = readRequiredPath(body, "path", "fs.search_text");
      const query = assertString(body, "query", "fs.search_text requires input.query");
      const caseSensitive = readBoolean(body, "caseSensitive") ?? false;
      const maxResults = readOptionalPositiveInt(body, "maxResults") ?? DEFAULT_SEARCH_MAX_RESULTS;
      const maxPreviewChars = readOptionalBoundedPositiveInt(
        body,
        "maxPreviewChars",
        MIN_SEARCH_MAX_PREVIEW_CHARS,
        MAX_SEARCH_MAX_PREVIEW_CHARS,
      ) ?? DEFAULT_SEARCH_MAX_PREVIEW_CHARS;
      const maxTotalPreviewChars = readOptionalBoundedPositiveInt(
        body,
        "maxTotalPreviewChars",
        MIN_SEARCH_MAX_TOTAL_PREVIEW_CHARS,
        MAX_SEARCH_MAX_TOTAL_PREVIEW_CHARS,
      ) ?? DEFAULT_SEARCH_MAX_TOTAL_PREVIEW_CHARS;
      const glob = readOptionalGlob(body);
      const searchResult = await searchUtf8Text({
        basePath: targetPath,
        query,
        glob,
        caseSensitive,
        maxResults,
        maxPreviewChars,
        maxTotalPreviewChars,
        config: context.fileSystem,
      });

      return {
        path: targetPath,
        query,
        ...searchResult,
      };
    };
  },
};
