import assert from "node:assert/strict";

import { defaultToolCatalog } from "../../tools/catalog.js";
import {
  BUILT_IN_TOOL_INPUT_CONTRACTS,
  validateBuiltInToolInputContract,
} from "../../tools/runtime/builtInToolInputContracts.js";
import { RuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { sanitizeToolInputForSchema } from "../../tools/runtime/normalizeToolInput.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "strict built-in tool schemas strip unexpected top-level keys in the audit pass", () => {
  const strictTools = defaultToolCatalog.list().filter((tool) =>
    tool.inputSchema.type === "object" && tool.inputSchema.additionalProperties === false,
  );

  for (const tool of strictTools) {
    const sanitized = sanitizeToolInputForSchema(tool.inputSchema, {
      unexpected: true,
    });
    assert.equal(
      Object.hasOwn(sanitized as Record<string, unknown>, "unexpected"),
      false,
      `strict schema sanitizer leaked unexpected field for ${tool.name}`,
    );
  }
});

contractTest("runtime.hermetic", "every built-in tool has an explicit input contract entry", () => {
  const toolNames = defaultToolCatalog.list().map((tool) => tool.name).sort();
  const contractNames = Object.keys(BUILT_IN_TOOL_INPUT_CONTRACTS).sort();

  assert.deepEqual(contractNames, toolNames);
});

contractTest("runtime.hermetic", "internet catalog exposes canonical Tavily tools and removes old semantic names", () => {
  const toolNames = new Set(defaultToolCatalog.list().map((tool) => tool.name));

  for (const name of [
    "internet.search",
    "internet.search_advanced",
    "internet.news",
    "internet.images",
    "internet.extract",
    "internet.crawl",
    "internet.map",
    "internet.research",
    "internet.research_status",
    "internet.usage",
  ]) {
    assert.equal(toolNames.has(name), true, `${name} should be registered`);
  }

  for (const name of [
    "internet.get_url",
    "internet.scrape",
    "internet.headlines",
    "internet.deep_report",
  ]) {
    assert.equal(toolNames.has(name), false, `${name} should not be registered`);
  }
});

contractTest("runtime.hermetic", "internet.search_advanced contract still validates dates when country is ignored for non-general topics", () => {
  assert.throws(
    () => validateBuiltInToolInputContract("internet.search_advanced", {
      query: "TCS latest revenue and headcount",
      topic: "news",
      country: "india",
      startDate: "2026-02-31",
    }),
    (error: unknown) => {
      assert.equal(error instanceof RuntimeFailure, true);
      const failure = error as RuntimeFailure;
      assert.equal(failure.code, "TOOL_INPUT_INVALID");
      assert.equal(failure.details?.field, "startDate");
      assert.deepEqual(failure.details?.invalidValues, ["2026-02-31"]);
      return true;
    },
  );
});

const workspaceRootMutationCases = [
  ["fs.mkdir", "."],
  ["fs.mkdir", "./"],
  ["fs.delete", "."],
] as const;

const assertWorkspaceRootMutationRejected = (
  [toolName, inputPath]: (typeof workspaceRootMutationCases)[number],
) => {
  assert.throws(
    () => validateBuiltInToolInputContract(toolName, { path: inputPath }),
    (error: unknown) => {
      assert.equal(error instanceof RuntimeFailure, true);
      const failure = error as RuntimeFailure;
      assert.equal(failure.code, "TOOL_INPUT_INVALID");
      assert.equal(failure.details?.field, "path");
      assert.deepEqual(failure.details?.invalidValues, [inputPath]);
      return true;
    },
  );
};

contractTest("runtime.hermetic", "fs.mkdir rejects the dot workspace-root mutation target", () =>
  assertWorkspaceRootMutationRejected(workspaceRootMutationCases[0]));
contractTest("runtime.hermetic", "fs.mkdir rejects the dot-slash workspace-root mutation target", () =>
  assertWorkspaceRootMutationRejected(workspaceRootMutationCases[1]));
contractTest("runtime.hermetic", "fs.delete rejects the dot workspace-root mutation target", () =>
  assertWorkspaceRootMutationRejected(workspaceRootMutationCases[2]));
