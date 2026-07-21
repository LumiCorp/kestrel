import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readWorkspaceFile,
  writeWorkspaceFile,
} from "../src/files.js";
import { WorkspaceRequestError } from "../src/security.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


contractTest("services.hermetic", "Workspace file writes require the revision that was read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-workspace-"));
  try {
    await writeFile(path.join(root, "app.ts"), "version one");
    const opened = await readWorkspaceFile(root, "app.ts");
    const saved = await writeWorkspaceFile({
      workspaceRoot: root,
      requestedPath: "app.ts",
      expectedRevision: opened.revision,
      content: Buffer.from("version two"),
    });
    assert.notEqual(saved.revision, opened.revision);
    assert.equal(await readFile(path.join(root, "app.ts"), "utf8"), "version two");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

contractTest("services.hermetic", "Workspace file writes reject a stale human edit after an agent change", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-workspace-"));
  try {
    const filePath = path.join(root, "app.ts");
    await writeFile(filePath, "opened content");
    const opened = await readWorkspaceFile(root, "app.ts");
    await writeFile(filePath, "agent content");
    await assert.rejects(
      writeWorkspaceFile({
        workspaceRoot: root,
        requestedPath: "app.ts",
        expectedRevision: opened.revision,
        content: Buffer.from("human content"),
      }),
      (error: unknown) =>
        error instanceof WorkspaceRequestError &&
        error.status === 409 &&
        error.code === "WORKSPACE_FILE_REVISION_CONFLICT"
    );
    assert.equal(await readFile(filePath, "utf8"), "agent content");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

contractTest("services.hermetic", "Workspace file writes fail closed without a revision", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-workspace-"));
  try {
    await writeFile(path.join(root, "app.ts"), "content");
    await assert.rejects(
      writeWorkspaceFile({
        workspaceRoot: root,
        requestedPath: "app.ts",
        expectedRevision: undefined,
        content: Buffer.from("replacement"),
      }),
      (error: unknown) =>
        error instanceof WorkspaceRequestError && error.status === 428
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
