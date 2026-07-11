import assert from "node:assert/strict";
import test from "node:test";

import {
  clientSupportsGenerativeUi,
  createTuiClientCapabilities,
  createWebClientCapabilities,
  getSupportedGenerativeUiBlocks,
  normalizeClientCapabilities,
} from "../../src/clientCapabilities.js";

test("web client capabilities enable typed blocks by default", () => {
  const capabilities = createWebClientCapabilities();
  assert.equal(capabilities.surface, "web");
  assert.equal(clientSupportsGenerativeUi(capabilities), true);
  assert.deepEqual(getSupportedGenerativeUiBlocks(capabilities), [
    "summary",
    "steps",
    "comparison",
    "code_preview",
    "status",
    "metric_list",
    "link_list",
    "web_preview",
  ]);
});

test("tui client capabilities disable typed blocks", () => {
  const capabilities = createTuiClientCapabilities();
  assert.equal(capabilities.surface, "tui");
  assert.equal(clientSupportsGenerativeUi(capabilities), false);
  assert.deepEqual(getSupportedGenerativeUiBlocks(capabilities), []);
});

test("normalizeClientCapabilities drops malformed block identifiers", () => {
  const capabilities = normalizeClientCapabilities({
    surface: "web",
    generativeUi: {
      enabled: true,
      supportedBlocks: ["summary", "unknown_block", "status"],
    },
  });

  assert.equal(capabilities?.surface, "web");
  assert.deepEqual(capabilities?.generativeUi?.supportedBlocks, ["summary", "status"]);
});
