import assert from "node:assert/strict";

import type {
  DesktopManagedProjectRun,
  DesktopPreviewDiagnostic,
} from "../src/contracts.js";
import {
  defaultPreviewDrawerOpen,
  previewDiagnosticSeverity,
  previewRunSummary,
  presentPreviewLifecycle,
  projectPreviewActivity,
  resolveActivePreviewRuns,
} from "../renderer/src/previewPresentation.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";

function run(
  input: Partial<DesktopManagedProjectRun> = {},
): DesktopManagedProjectRun {
  return {
    runId: "run-1",
    projectPath: "/repo",
    manifestPath: "/repo/package.json",
    scriptName: "dev",
    packageManager: "pnpm",
    command: "pnpm run dev",
    status: "running",
    startedAt: "2026-07-23T12:00:00.000Z",
    updatedAt: "2026-07-23T12:00:01.000Z",
    outputTail: [],
    stdoutTail: [],
    stderrTail: [],
    ...input,
  };
}

function diagnostic(
  input: Partial<DesktopPreviewDiagnostic> = {},
): DesktopPreviewDiagnostic {
  return {
    webContentsId: 1,
    kind: "console",
    message: "diagnostic",
    level: 1,
    at: "2026-07-23T12:00:02.000Z",
    ...input,
  };
}

contractTest(
  "desktop.hermetic",
  "preview lifecycle presentation covers idle, pending, active, and settled states",
  () => {
    assert.deepEqual(
      presentPreviewLifecycle({ scriptName: "dev" }),
      { action: "start", label: "Start dev", disabled: false },
    );
    assert.deepEqual(
      presentPreviewLifecycle({
        scriptName: "dev",
        pendingAction: "start",
      }),
      { action: "start", label: "Starting…", disabled: true },
    );
    assert.deepEqual(
      presentPreviewLifecycle({ scriptName: "dev", run: run() }),
      { action: "stop", label: "Stop", disabled: false },
    );
    assert.deepEqual(
      presentPreviewLifecycle({
        scriptName: "dev",
        run: run({ status: "stopping" }),
      }),
      { action: "stop", label: "Stopping…", disabled: true },
    );
    for (const status of ["stopped", "completed", "failed"] as const) {
      assert.deepEqual(
        presentPreviewLifecycle({
          scriptName: "dev",
          run: run({ status }),
        }),
        { action: "restart", label: "Restart dev", disabled: false },
      );
    }
    assert.equal(
      previewRunSummary(run({ status: "failed", exitCode: 1 })),
      "Failed · exit 1",
    );
    assert.equal(
      previewRunSummary(run({ status: "stopped" }), "start", undefined, "docs"),
      "Starting docs…",
    );
  },
);

contractTest(
  "desktop.hermetic",
  "preview selects the newest active run without hiding other active runs",
  () => {
    const oldest = run({
      runId: "oldest",
      startedAt: "2026-07-23T11:59:00.000Z",
    });
    const newest = run({
      runId: "newest",
      status: "stopping",
      startedAt: "2026-07-23T12:01:00.000Z",
    });
    const settled = run({
      runId: "settled",
      status: "completed",
      startedAt: "2026-07-23T12:02:00.000Z",
    });

    const resolved = resolveActivePreviewRuns([oldest, settled, newest]);

    assert.equal(resolved.activeRun?.runId, "newest");
    assert.deepEqual(
      resolved.otherActiveRuns.map((entry) => entry.runId),
      ["oldest"],
    );
  },
);

contractTest(
  "desktop.hermetic",
  "preview drawer defaults follow explicit run and typed diagnostic state",
  () => {
    assert.equal(defaultPreviewDrawerOpen({ diagnostics: [] }), false);
    assert.equal(
      defaultPreviewDrawerOpen({
        run: run(),
        diagnostics: [],
      }),
      true,
    );
    assert.equal(
      defaultPreviewDrawerOpen({
        run: run({ primaryPreviewUrl: "http://localhost:3000/" }),
        diagnostics: [],
      }),
      false,
    );
    assert.equal(
      defaultPreviewDrawerOpen({
        run: run({
          status: "failed",
          primaryPreviewUrl: "http://localhost:3000/",
        }),
        diagnostics: [],
      }),
      true,
    );
    assert.equal(
      defaultPreviewDrawerOpen({
        run: run({ primaryPreviewUrl: "http://localhost:3000/" }),
        diagnostics: [diagnostic({ level: 2 })],
      }),
      true,
    );
  },
);

contractTest(
  "desktop.hermetic",
  "preview activity uses contract events and typed diagnostic severity only",
  () => {
    const current = run({
      previewUrls: [
        {
          url: "http://localhost:3000/",
          source: "stdout",
          firstSeenAt: "2026-07-23T12:00:01.000Z",
          lastSeenAt: "2026-07-23T12:00:01.000Z",
          line: "ready",
          count: 1,
        },
      ],
      outputTail: [
        {
          source: "stderr",
          line: "warning error failed ready localhost",
          observedAt: "2026-07-23T12:00:01.500Z",
        },
      ],
    });
    const entries = projectPreviewActivity(current, [
      diagnostic({ level: 2 }),
      diagnostic({
        kind: "network_error",
        level: undefined,
        at: "2026-07-23T12:00:03.000Z",
      }),
    ]);

    assert.deepEqual(
      entries.map((entry) => entry.kind),
      ["lifecycle", "preview_url", "browser", "browser"],
    );
    assert.deepEqual(
      entries.map((entry) => entry.severity),
      ["info", "info", "warning", "error"],
    );
    assert.equal(previewDiagnosticSeverity(diagnostic({ level: 1 })), "info");
    assert.equal(previewDiagnosticSeverity(diagnostic({ level: 2 })), "warning");
    assert.equal(previewDiagnosticSeverity(diagnostic({ level: 3 })), "error");
  },
);
