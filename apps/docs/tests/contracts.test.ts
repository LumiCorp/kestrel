import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  parseRunnerResultV2,
  RUNNER_RUN_STREAM_EVENT_TYPES,
} from "@kestrel-agents/protocol";

import { getRenderedPageBySlug } from "@/lib/content";
import { DOCS_RELEASE } from "@/lib/release";
import { resolveRepoRoot } from "@/lib/site";

test("terminal-result examples stay backed by the exported parser", async () => {
  const terminalPage = await getRenderedPageBySlug(["reference", "terminal-results"]);
  assert.ok(terminalPage);
  assert.match(terminalPage.rawContent, /assistantText:\s*string\s*\|\s*null/u);
  assert.match(terminalPage.rawContent, /finalizedPayload/u);
  assert.match(terminalPage.rawContent, /operatorAffordance/u);
  assert.match(terminalPage.rawContent, /run\.completed/u);
  assert.match(terminalPage.rawContent, /run\.failed/u);
  assert.match(terminalPage.rawContent, /run\.cancelled/u);
  assert.match(terminalPage.rawContent, /waiting/iu);

  assert.deepEqual(parseRunnerResultV2({ output: { status: "COMPLETED" }, assistantText: " Done. " }), {
    output: { status: "COMPLETED" },
    assistantText: "Done.",
  });
  assert.throws(() => parseRunnerResultV2({ output: {}, assistantText: "" }), /assistantText/u);
  assert.throws(() => parseRunnerResultV2({ output: {} }), /assistantText is required/u);
});

test("event reference lists every exported public stream event", async () => {
  const eventsPage = await getRenderedPageBySlug(["reference", "events"]);
  assert.ok(eventsPage);
  for (const eventType of RUNNER_RUN_STREAM_EVENT_TYPES) {
    assert.match(eventsPage.rawContent, new RegExp(`\\b${eventType.replaceAll(".", "\\.")}\\b`, "u"), eventType);
  }
  assert.match(eventsPage.rawContent, /assistantText/u);
  assert.match(eventsPage.rawContent, /waiting/iu);
});

test("release metadata names only real public packages with reference coverage", async () => {
  const root = resolveRepoRoot();
  const packageFiles = [
    "package.json",
    "packages/protocol/package.json",
    "packages/sdk/package.json",
    "packages/next/package.json",
    "packages/observability/package.json",
  ];
  const names = await Promise.all(packageFiles.map(async (file) => {
    const data = JSON.parse(await fs.readFile(path.join(root, file), "utf8")) as { name: string };
    return data.name;
  }));
  assert.deepEqual(names, [...DOCS_RELEASE.releasedPackageNames]);

  for (const route of ["protocol", "sdk", "nextjs", "observability"]) {
    assert.ok(await getRenderedPageBySlug(["reference", route]), route);
  }
});
