import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkspaceValidationService } from "../../src/validation/WorkspaceValidationService.js";

const fp = (value: string) => `sha256:${value.repeat(64)}`;

test("WorkspaceValidationService discovers package scripts and explicit ordered actions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-validation-discovery-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node test.js", bespoke: "node bespoke.js" } }), "utf8");
  await mkdir(path.join(root, ".kestrel"));
  await writeFile(path.join(root, ".kestrel", "validation.json"), JSON.stringify({
    version: 1,
    actions: [{ id: "configured", label: "Configured check", kind: "smoke", command: process.execPath, args: ["-e", "process.exit(0)"], required: true }],
    suites: [{ id: "release", label: "Release", actions: ["configured", "package:test"] }],
  }), "utf8");
  const service = new WorkspaceValidationService(path.join(root, ".kestrel", "results.json"));
  await service.initialize();
  const snapshot = await service.inspect({ sessionId: "session-1", threadId: "thread-1", workspaceRoot: root, candidateFingerprint: fp("a") });
  assert.equal(snapshot.actions.find((action) => action.actionId === "package:test")?.kind, "test");
  assert.equal(snapshot.actions.find((action) => action.actionId === "package:bespoke")?.kind, "custom");
  assert.deepEqual(snapshot.suites.find((suite) => suite.suiteId === "release")?.actionIds, ["configured", "package:test"]);
  assert.equal(snapshot.readiness.state, "not_run");
});

test("WorkspaceValidationService records output, exit evidence, readiness, and candidate staleness", async () => {
  const root = await configuredWorkspace([
    { id: "passing", label: "Passing", kind: "test", command: process.execPath, args: ["-e", "require('fs').writeFileSync('evidence.txt','ok'); require('fs').writeFileSync('locations.json', JSON.stringify([{path:'src/app.ts',line:12,column:4,message:'Type error'}])); console.log('passed output API_TOKEN=supersecretvalue')"], required: true, artifacts: ["evidence.txt"], locationsFile: "locations.json" },
  ]);
  const service = new WorkspaceValidationService(path.join(root, ".kestrel", "results.json"));
  await service.initialize();
  await service.runAction({ sessionId: "session-1", threadId: "thread-1", workspaceRoot: root, candidateFingerprint: fp("a"), actionId: "passing" });
  const settled = await waitFor(service, root, fp("a"));
  assert.equal(settled.results[0]?.outcome, "passed");
  assert.equal(settled.results[0]?.exitCode, 0);
  assert.match(settled.results[0]?.output.map((entry) => entry.text).join("") ?? "", /passed output/u);
  assert.doesNotMatch(settled.results[0]?.output.map((entry) => entry.text).join("") ?? "", /supersecretvalue/u);
  assert.match(settled.results[0]?.output.map((entry) => entry.text).join("") ?? "", /API_TOKEN=\[redacted:env\]/u);
  assert.equal(settled.results[0]?.evidence[0]?.exists, true);
  assert.deepEqual(settled.results[0]?.locations, [{ path: "src/app.ts", line: 12, column: 4, message: "Type error" }]);
  assert.equal(settled.readiness.state, "ready");
  const stale = await service.inspect({ sessionId: "session-1", threadId: "thread-1", workspaceRoot: root, candidateFingerprint: fp("b") });
  assert.equal(stale.results[0]?.outcome, "stale");
  assert.equal(stale.readiness.state, "stale");
});

test("WorkspaceValidationService invalidates and terminates a running result when the candidate changes", async () => {
  const root = await configuredWorkspace([
    { id: "slow", label: "Slow", kind: "test", command: process.execPath, args: ["-e", "setTimeout(() => process.exit(0), 10000)"], required: true },
  ]);
  const service = new WorkspaceValidationService(path.join(root, ".kestrel", "results.json"));
  await service.initialize();
  await service.runAction({ sessionId: "session-1", threadId: "thread-1", workspaceRoot: root, candidateFingerprint: fp("a"), actionId: "slow" });
  const stale = await service.inspect({ sessionId: "session-1", threadId: "thread-1", workspaceRoot: root, candidateFingerprint: fp("b") });
  assert.equal(stale.results[0]?.outcome, "stale");
  assert.equal(stale.readiness.state, "stale");
  assert.match(stale.results[0]?.output.at(-1)?.text ?? "", /cannot be used as evidence/u);
});

test("WorkspaceValidationService stops an ordered suite and records skipped outcomes", async () => {
  const root = await configuredWorkspace([
    { id: "failing", label: "Failing", kind: "lint", command: process.execPath, args: ["-e", "console.error('failed output'); process.exit(2)"], required: true },
    { id: "later", label: "Later", kind: "build", command: process.execPath, args: ["-e", "process.exit(0)"], required: true },
  ], [{ id: "ordered", label: "Ordered", actions: ["failing", "later"], stopOnFailure: true }]);
  const service = new WorkspaceValidationService(path.join(root, ".kestrel", "results.json"));
  await service.initialize();
  await service.runSuite({ sessionId: "session-1", threadId: "thread-1", workspaceRoot: root, candidateFingerprint: fp("a"), suiteId: "ordered" });
  const settled = await waitFor(service, root, fp("a"), 2);
  assert.equal(settled.results.find((result) => result.actionId === "failing")?.outcome, "failed");
  assert.equal(settled.results.find((result) => result.actionId === "failing")?.exitCode, 2);
  assert.equal(settled.results.find((result) => result.actionId === "later")?.outcome, "skipped");
  assert.equal(settled.readiness.state, "blocked");
});

async function configuredWorkspace(actions: object[], suites: object[] = []): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-validation-"));
  await mkdir(path.join(root, ".kestrel"));
  await writeFile(path.join(root, ".kestrel", "validation.json"), JSON.stringify({ version: 1, actions, suites }), "utf8");
  return root;
}

async function waitFor(service: WorkspaceValidationService, workspaceRoot: string, candidateFingerprint: string, resultCount = 1) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = await service.inspect({ sessionId: "session-1", threadId: "thread-1", workspaceRoot, candidateFingerprint });
    if (snapshot.results.length >= resultCount && snapshot.results.every((result) => result.outcome !== "running")) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("validation did not settle");
}
