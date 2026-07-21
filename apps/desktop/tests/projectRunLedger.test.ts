import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { DesktopManagedProjectRun } from "../../../src/desktopShell/contracts.js";
import {
  createDesktopProjectRunLedger,
  DesktopProjectRunRegistry,
} from "../src/projectRuns.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


function run(input: Partial<DesktopManagedProjectRun> = {}): DesktopManagedProjectRun {
  return {
    runId: "run-1",
    projectPath: "/repo",
    manifestPath: "/repo/package.json",
    scriptName: "dev",
    packageManager: "pnpm",
    command: "pnpm run dev",
    status: "failed",
    startedAt: "2026-04-29T12:00:00.000Z",
    updatedAt: "2026-04-29T12:00:05.000Z",
    completedAt: "2026-04-29T12:00:05.000Z",
    exitCode: 1,
    stdoutTail: [],
    stderrTail: ["OPENAI_API_KEY=sk-secret123456 failed"],
    ...input,
  };
}

contractTest("desktop.hermetic", "Desktop project run ledger persists bounded redacted runs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kestrel-run-ledger-"));
  const ledgerPath = path.join(dir, "project-runs.json");
  const ledger = createDesktopProjectRunLedger({ ledgerPath, limit: 2 });

  await ledger.writeRuns([
    run({ runId: "run-1", startedAt: "2026-04-29T12:00:00.000Z" }),
    run({ runId: "run-2", startedAt: "2026-04-29T12:01:00.000Z" }),
    run({ runId: "run-3", startedAt: "2026-04-29T12:02:00.000Z" }),
  ]);

  const restored = await ledger.readRuns();
  const raw = await readFile(ledgerPath, "utf8");

  assert.deepEqual(restored.map((entry) => entry.runId), ["run-3", "run-2"]);
  assert.doesNotMatch(raw, /sk-secret/);
  assert.match(raw, /redacted:env/);
});

contractTest("desktop.hermetic", "DesktopProjectRunRegistry hydrates runs from ledger", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kestrel-run-ledger-"));
  const ledger = createDesktopProjectRunLedger({
    ledgerPath: path.join(dir, "project-runs.json"),
    limit: 4,
  });
  await ledger.writeRuns([run({ runId: "run-ledger" })]);

  const registry = new DesktopProjectRunRegistry({ ledger });
  await registry.hydrate();

  assert.deepEqual(registry.listRuns().map((entry) => entry.runId), ["run-ledger"]);
});

contractTest("desktop.hermetic", "Desktop project run ledger restores stale active runs as stopped history", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kestrel-run-ledger-"));
  const ledger = createDesktopProjectRunLedger({
    ledgerPath: path.join(dir, "project-runs.json"),
    limit: 4,
  });
  await ledger.writeRuns([
    run({
      runId: "run-active",
      status: "running",
      completedAt: undefined,
      exitCode: undefined,
      stderrTail: [],
    }),
  ]);

  const restored = await ledger.readRuns();

  assert.equal(restored[0]?.status, "stopped");
  assert.match(restored[0]?.stderrTail.at(-1) ?? "", /Desktop restarted/u);
});
