import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildPlanDocumentRelativePath,
  isPlanDocumentPath,
  resolvePlanDocumentAbsolutePath,
  sanitizePlanDocumentSessionSegment,
} from "../../src/runtime/planDocument.js";
import { planningWriteDocumentTool } from "../../tools/runtime/planningWriteDocument.js";

test("buildPlanDocumentRelativePath returns a session-scoped PLAN.md path", () => {
  assert.equal(
    buildPlanDocumentRelativePath("session-1"),
    "~/.kestrel/sessions/session-1/PLAN.md",
  );
});

test("buildPlanDocumentRelativePath sanitizes unsafe session path characters", () => {
  assert.equal(
    buildPlanDocumentRelativePath("../bad/session"),
    "~/.kestrel/sessions/bad_session/PLAN.md",
  );
});

test("resolvePlanDocumentAbsolutePath maps the model-facing path into Kestrel home", () => {
  assert.equal(
    resolvePlanDocumentAbsolutePath("~/.kestrel/sessions/session-1/PLAN.md", "/tmp/kestrel-home"),
    "/tmp/kestrel-home/sessions/session-1/PLAN.md",
  );
  assert.equal(isPlanDocumentPath(".kestrel/sessions/session-1/PLAN.md"), false);
});

test("sanitizePlanDocumentSessionSegment rejects empty or unsafe-only session ids", () => {
  assert.equal(sanitizePlanDocumentSessionSegment(".."), undefined);
  assert.equal(sanitizePlanDocumentSessionSegment("///"), undefined);
});

test("planning.write_document writes only session-scoped PLAN.md files", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "kestrel-plan-"));
  const previous = process.env.KESTREL_HOME;
  process.env.KESTREL_HOME = home;
  try {
    const handler = planningWriteDocumentTool.createHandler({});
    const result = await handler({
      path: "~/.kestrel/sessions/session-1/PLAN.md",
      content: "# Plan\n\nBuild the app.",
    });

    assert.deepEqual(result, {
      path: "~/.kestrel/sessions/session-1/PLAN.md",
      bytesWritten: 22,
    });
    assert.equal(
      await readFile(path.join(home, "sessions/session-1/PLAN.md"), "utf8"),
      "# Plan\n\nBuild the app.",
    );
    const runtimeScopedHandler = planningWriteDocumentTool.createHandler({
      runtime: {
        runId: "run-1",
        sessionId: "session-2",
      },
    });
    assert.deepEqual(
      await runtimeScopedHandler({
        path: "PLAN.md",
        content: "# Plan\n\nUse the canonical session path.",
      }),
      {
        path: "~/.kestrel/sessions/session-2/PLAN.md",
        bytesWritten: 39,
      },
    );
    assert.equal(
      await readFile(path.join(home, "sessions/session-2/PLAN.md"), "utf8"),
      "# Plan\n\nUse the canonical session path.",
    );
    await assert.rejects(
      () =>
        runtimeScopedHandler({
          path: "~/.kestrel/sessions/session-1/PLAN.md",
          content: "wrong session",
        }),
      /current session PLAN\.md/u,
    );
    await assert.rejects(
      () => handler({ path: "/tmp/not-plan.md", content: "bad" }),
      /session-scoped PLAN\.md path/u,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.KESTREL_HOME;
    } else {
      process.env.KESTREL_HOME = previous;
    }
    await rm(home, { force: true, recursive: true });
  }
});
