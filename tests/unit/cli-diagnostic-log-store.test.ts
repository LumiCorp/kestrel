import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DiagnosticLogStore } from "../../cli/diagnostics/DiagnosticLogStore.js";

test("DiagnosticLogStore appends readable startup diagnostics entries", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-diagnostics-store-"));
  const store = new DiagnosticLogStore(tempDir);

  await store.append({
    scope: "startup.handshake",
    summary: "Runner process exited with code 1",
    details: "Error: Cannot find module './missing-runner-dependency.js'",
    sessionId: "session-1",
    profileId: "reference",
    workspaceId: "workspace-1",
    cwd: "/tmp/project",
  });

  const raw = await readFile(store.getFilePath(), "utf8");

  assert.match(raw, /\[.+\] startup\.handshake/u);
  assert.match(raw, /summary: Runner process exited with code 1/u);
  assert.match(raw, /sessionId: session-1/u);
  assert.match(raw, /profileId: reference/u);
  assert.match(raw, /workspaceId: workspace-1/u);
  assert.match(raw, /cwd: \/tmp\/project/u);
  assert.match(raw, /details:\nError: Cannot find module '\.\/missing-runner-dependency\.js'/u);
});

test("DiagnosticLogStore defaults under expanded ~/ KESTREL_HOME", () => {
  const previousHome = process.env.KESTREL_HOME;
  process.env.KESTREL_HOME = "~/kestrel-diagnostics-home";
  try {
    const store = new DiagnosticLogStore();
    assert.equal(
      store.getFilePath(),
      path.join(os.homedir(), "kestrel-diagnostics-home", "logs", "tui-diagnostics.log"),
    );
  } finally {
    if (previousHome === undefined) {
      delete process.env.KESTREL_HOME;
    } else {
      process.env.KESTREL_HOME = previousHome;
    }
  }
});
