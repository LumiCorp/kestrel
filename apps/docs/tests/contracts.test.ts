import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  parseRunnerCommandV2,
  parseRunnerResultV2,
  RUNNER_RUN_STREAM_EVENT_TYPES,
} from "@kestrel-agents/protocol";

import { getRenderedPageBySlug } from "@/lib/content";
import { pageRegistry } from "@/lib/content-registry";
import { DOCS_RELEASE } from "@/lib/release";
import { resolveRepoRoot } from "@/lib/site";
import { buildCliContractMatrixV1 } from "../../../cli/contractMatrix.js";

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
  const packagesRoot = path.join(root, "packages");
  const packageFiles = ["package.json"];
  for (const directory of await fs.readdir(packagesRoot)) {
    const relative = path.join("packages", directory, "package.json");
    try {
      const data = JSON.parse(await fs.readFile(path.join(root, relative), "utf8")) as {
        publishConfig?: { access?: string };
      };
      if (data.publishConfig?.access === "public") packageFiles.push(relative);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const manifests = await Promise.all(packageFiles.map(async (file) =>
    JSON.parse(await fs.readFile(path.join(root, file), "utf8")) as { name: string; version: string }
  ));
  const names = manifests.map(({ name }) => name);
  names.sort();
  const releasedNames = [...DOCS_RELEASE.releasedPackageNames].sort();
  assert.deepEqual(names, releasedNames);
  assert.deepEqual([...new Set(manifests.map(({ version }) => version))], [DOCS_RELEASE.version]);

  for (const route of ["protocol", "sdk", "nextjs", "ai-sdk", "observability"]) {
    assert.ok(await getRenderedPageBySlug(["reference", route]), route);
  }
});

test("every registered source reference exists", async () => {
  const root = resolveRepoRoot();
  for (const spec of pageRegistry) {
    for (const sourceRef of spec.sourceRefs ?? []) {
      await assert.doesNotReject(
        fs.access(path.join(root, sourceRef)),
        `${spec.slug.join("/") || "/"} references missing ${sourceRef}`,
      );
    }
  }
});

test("CLI reference covers every command-mode family", async () => {
  const commandPage = await getRenderedPageBySlug(["cli", "command-suite"]);
  assert.ok(commandPage);
  const matrix = buildCliContractMatrixV1("2026-07-20T00:00:00.000Z");
  for (const command of matrix.commandMode) {
    assert.match(commandPage.rawContent, new RegExp(`\\b${command.command}\\b`, "u"), command.command);
  }
});

test("runner ping documentation uses a valid canonical command envelope", async () => {
  const command = {
    id: "cmd-health-check",
    type: "runner.ping",
    metadata: {
      actor: {
        actorId: "operator-check",
        actorType: "operator",
        tenantId: "acme",
      },
      tenantId: "acme",
    },
    payload: { nonce: "docs-check" },
  };
  assert.deepEqual(parseRunnerCommandV2(command), command);
  const page = await getRenderedPageBySlug(["operate", "runner-service"]);
  assert.ok(page);
  assert.match(page.rawContent, /"type": "runner\.ping"/u);
  assert.match(page.rawContent, /"metadata": \{/u);
  assert.match(page.rawContent, /"payload": \{/u);
  assert.doesNotMatch(page.rawContent, /curl -I/u);
});

test("resume documentation names the current SDK input", async () => {
  const page = await getRenderedPageBySlug(["build", "waiting-resume-and-cancellation"]);
  assert.ok(page);
  assert.match(page.rawContent, /sessionId:\s*"reference-session-001"/u);
  assert.match(page.rawContent, /requestId:\s*waitingRequestId/u);
  assert.match(page.rawContent, /message:\s*"Approved/u);
  assert.doesNotMatch(page.rawContent, /runId:\s*waitingRunId|event:\s*\{/u);
});
