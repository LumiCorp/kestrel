import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseDesktopPathTargetInput,
  resolveDesktopProjectRootForWatcherCleanup,
  resolveRegisteredDesktopProjectRoot,
  resolveDesktopPathTarget,
  resolveVerifiedDesktopPathTarget,
} from "../src/fileAccess.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


contractTest("desktop.hermetic", "desktop path targets resolve paths within the selected root", () => {
  const rootPath = path.join(path.sep, "tmp", "project-a");
  const targetPath = path.join(rootPath, "src", "index.ts");

  const parsed = parseDesktopPathTargetInput(
    { rootPath, targetPath },
    {
      methodName: "desktop.readFile",
      invalidInputCode: "desktop.invalid_read_input",
      invalidTargetCode: "desktop.invalid_read_path",
    },
  );
  const resolved = resolveDesktopPathTarget(parsed);

  assert.deepEqual(resolved, {
    rootPath,
    targetPath,
  });
});

contractTest("desktop.hermetic", "desktop path targets preserve a valid runtime thread scope", () => {
  const parsed = parseDesktopPathTargetInput(
    {
      rootPath: "/tmp/project-a",
      targetPath: "/tmp/project-a/src/index.ts",
      threadId: " thread-1 ",
    },
    {
      methodName: "desktop.readFile",
      invalidInputCode: "desktop.invalid_read_input",
      invalidTargetCode: "desktop.invalid_read_path",
    },
  );

  assert.equal(parsed.threadId, "thread-1");
});

contractTest("desktop.hermetic", "desktop path targets reject malformed runtime thread scopes", () => {
  assert.throws(
    () => parseDesktopPathTargetInput(
      {
        rootPath: "/tmp/project-a",
        targetPath: "/tmp/project-a/src/index.ts",
        threadId: 42,
      },
      {
        methodName: "desktop.readFile",
        invalidInputCode: "desktop.invalid_read_input",
        invalidTargetCode: "desktop.invalid_read_path",
      },
    ),
    {
      name: "DesktopError",
      code: "desktop.invalid_operator_thread_id",
    },
  );
});

contractTest("desktop.hermetic", "desktop path targets reject paths outside the selected root", () => {
  const rootPath = path.join(path.sep, "tmp", "project-a");
  const targetPath = path.join(path.sep, "tmp", "project-b", "secret.txt");

  assert.throws(
    () => resolveDesktopPathTarget({ rootPath, targetPath }),
    {
      name: "DesktopError",
      code: "desktop.path_outside_project",
    },
  );
});

contractTest("desktop.hermetic", "desktop path targets reject malformed bridge inputs before use", () => {
  assert.throws(
    () =>
      parseDesktopPathTargetInput(
        { rootPath: "/tmp/project-a" },
        {
          methodName: "desktop.readFile",
          invalidInputCode: "desktop.invalid_read_input",
          invalidTargetCode: "desktop.invalid_read_path",
        },
      ),
    {
      name: "DesktopError",
      code: "desktop.invalid_read_path",
    },
  );
});

contractTest("desktop.hermetic", "desktop path targets reject unregistered project roots", () => {
  const rootPath = path.join(path.sep, "tmp", "project-a");
  const forgedRootPath = path.join(path.sep, "tmp");

  assert.throws(
    () => resolveRegisteredDesktopProjectRoot(forgedRootPath, [rootPath]),
    {
      name: "DesktopError",
      code: "desktop.unregistered_project_root",
    },
  );
});

contractTest("desktop.hermetic", "desktop path targets accept registered roots via realpath equivalence", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "kestrel-desktop-access-"));
  try {
    const projectRoot = path.join(tempRoot, "project-a");
    await mkdir(projectRoot);
    const aliasRoot = path.join(tempRoot, "project-alias");
    await symlink(projectRoot, aliasRoot);

    const resolved = resolveRegisteredDesktopProjectRoot(aliasRoot, [projectRoot]);
    assert.equal(resolved, projectRoot);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

contractTest("desktop.hermetic", "desktop watcher cleanup accepts a now-unregistered active watcher root", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "kestrel-desktop-access-"));
  try {
    const projectRoot = path.join(tempRoot, "project-a");
    await mkdir(projectRoot);

    const resolved = resolveDesktopProjectRootForWatcherCleanup(
      projectRoot,
      [],
      [projectRoot],
    );

    assert.equal(resolved, projectRoot);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

contractTest("desktop.hermetic", "desktop watcher cleanup accepts a removed root as idempotent teardown", () => {
  const removedRootPath = path.join(path.sep, "tmp", "kestrel-removed-project");

  const resolved = resolveDesktopProjectRootForWatcherCleanup(
    removedRootPath,
    [],
    [],
  );

  assert.equal(resolved, removedRootPath);
});

contractTest("desktop.hermetic", "desktop watcher cleanup still rejects existing unknown roots", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "kestrel-desktop-access-"));
  try {
    const rootPath = path.join(tempRoot, "project-a");
    const forgedRootPath = path.join(tempRoot, "project-b");
    await mkdir(rootPath);
    await mkdir(forgedRootPath);

    assert.throws(
      () => resolveDesktopProjectRootForWatcherCleanup(forgedRootPath, [], [rootPath]),
      {
        name: "DesktopError",
        code: "desktop.unregistered_project_root",
      },
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

contractTest("desktop.hermetic", "desktop path targets verify real paths against symlink escapes", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "kestrel-desktop-access-"));
  try {
    const projectRoot = path.join(tempRoot, "project-a");
    const outsideRoot = path.join(tempRoot, "outside");
    await mkdir(projectRoot);
    await mkdir(outsideRoot);
    const outsideFile = path.join(outsideRoot, "secret.txt");
    await writeFile(outsideFile, "secret\n", "utf8");
    const linkedFile = path.join(projectRoot, "linked-secret.txt");
    await symlink(outsideFile, linkedFile);

    await assert.rejects(
      resolveVerifiedDesktopPathTarget(
        { rootPath: projectRoot, targetPath: linkedFile },
        [projectRoot],
      ),
      {
        name: "DesktopError",
        code: "desktop.path_outside_project",
      },
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

contractTest("desktop.hermetic", "desktop path targets verify registered roots for normal files", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "kestrel-desktop-access-"));
  try {
    const projectRoot = path.join(tempRoot, "project-a");
    await mkdir(projectRoot);
    const filePath = path.join(projectRoot, "README.md");
    await writeFile(filePath, "# Project\n", "utf8");

    const resolved = await resolveVerifiedDesktopPathTarget(
      { rootPath: projectRoot, targetPath: filePath },
      [projectRoot],
    );

    assert.equal(resolved.rootPath, projectRoot);
    assert.equal(resolved.targetPath, filePath);
    assert.equal(path.basename(resolved.realRootPath), "project-a");
    assert.equal(path.basename(resolved.realTargetPath), "README.md");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
