import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
    outputTail: [
      {
        source: "stderr",
        line: "OPENAI_API_KEY=sk-secret123456 failed",
        observedAt: "2026-04-29T12:00:04.000Z",
      },
    ],
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
  assert.match(restored[0]?.outputTail?.[0]?.line ?? "", /redacted:env/u);
});

contractTest("desktop.hermetic", "Desktop project run ledger bounds ordered output during persistence and parsing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kestrel-run-ledger-"));
  const ledgerPath = path.join(dir, "project-runs.json");
  const ledger = createDesktopProjectRunLedger({ ledgerPath, limit: 2 });
  const outputTail = Array.from({ length: 162 }, (_, index) => ({
    source: index % 2 === 0 ? "stdout" as const : "stderr" as const,
    line: `line-${index}`,
    observedAt: new Date(Date.UTC(2026, 3, 29, 12, 0, index)).toISOString(),
  }));

  await ledger.writeRuns([run({ outputTail })]);

  const restored = await ledger.readRuns();
  assert.equal(restored[0]?.outputTail?.length, 160);
  assert.equal(restored[0]?.outputTail?.[0]?.line, "line-2");
  assert.equal(restored[0]?.outputTail?.at(-1)?.line, "line-161");

  const raw = JSON.parse(await readFile(ledgerPath, "utf8")) as {
    runs: Array<{ outputTail?: unknown[] | undefined }>;
  };
  assert.equal(raw.runs[0]?.outputTail?.length, 160);
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
  assert.match(restored[0]?.outputTail?.at(-1)?.line ?? "", /Desktop restarted/u);
});

contractTest("desktop.hermetic", "Desktop project run ledger accepts legacy runs without ordered output", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kestrel-run-ledger-"));
  const ledgerPath = path.join(dir, "project-runs.json");
  const legacy = run();
  delete legacy.outputTail;
  await writeFile(
    ledgerPath,
    `${JSON.stringify({ version: 1, runs: [legacy] }, null, 2)}\n`,
    "utf8",
  );

  const restored = await createDesktopProjectRunLedger({
    ledgerPath,
    limit: 4,
  }).readRuns();

  assert.equal(restored[0]?.outputTail, undefined);
  assert.deepEqual(restored[0]?.stderrTail, [
    "OPENAI_API_KEY=sk-secret123456 failed",
  ]);
});
