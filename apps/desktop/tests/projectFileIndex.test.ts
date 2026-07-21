import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DESKTOP_FILE_SEARCH_RESULT_LIMIT,
  DesktopProjectFileIndex,
} from "../src/projectFileIndex.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


contractTest("desktop.hermetic", "DesktopProjectFileIndex searches Git tracked and untracked files with deterministic cap metadata", async () => {
  const rootPath = "/tmp/project-a";
  const gitFiles = [
    "src/zeta.ts",
    ...Array.from({ length: DESKTOP_FILE_SEARCH_RESULT_LIMIT + 3 }, (_, index) =>
      `src/file-${String(index).padStart(3, "0")}.ts`
    ),
    "README.md",
  ];
  const index = new DesktopProjectFileIndex({
    gitListFiles: async (requestedRoot) => {
      assert.equal(requestedRoot, rootPath);
      return gitFiles;
    },
  });

  const response = await index.search(rootPath, "file");

  assert.equal(response.fullSearchAvailable, true);
  assert.equal(response.truncated, true);
  assert.equal(response.results.length, DESKTOP_FILE_SEARCH_RESULT_LIMIT);
  assert.equal(response.results[0]?.path, path.join(rootPath, "src/file-000.ts"));
  assert.equal(response.results.at(-1)?.path, path.join(rootPath, "src/file-199.ts"));
});

contractTest("desktop.hermetic", "DesktopProjectFileIndex can be invalidated after watcher events", async () => {
  const rootPath = "/tmp/project-a";
  let gitFiles = ["src/before.ts"];
  const index = new DesktopProjectFileIndex({
    gitListFiles: async () => gitFiles,
  });

  assert.deepEqual(
    (await index.search(rootPath, "after")).results.map((entry) => entry.name),
    [],
  );

  gitFiles = ["src/after.ts"];
  index.invalidate(rootPath);

  assert.deepEqual(
    (await index.search(rootPath, "after")).results.map((entry) => entry.name),
    ["after.ts"],
  );
});

contractTest("desktop.hermetic", "DesktopProjectFileIndex matches repository-relative paths as well as filenames", async () => {
  const rootPath = "/tmp/project-path-search";
  const index = new DesktopProjectFileIndex({
    gitListFiles: async () => ["features/billing/index.ts", "src/app.ts"],
  });

  const response = await index.search(rootPath, "billing");

  assert.deepEqual(response.results.map((entry) => entry.path), [
    path.join(rootPath, "features/billing/index.ts"),
  ]);
});

contractTest("desktop.hermetic", "DesktopProjectFileIndex refreshes a cached non-Git root after project registration retention", async () => {
  const rootPath = "/tmp/project-a";
  let gitFiles: string[] | undefined;
  const index = new DesktopProjectFileIndex({
    gitListFiles: async () => gitFiles,
  });

  const fallbackResponse = await index.search(rootPath, "app");
  assert.equal(fallbackResponse.fullSearchAvailable, false);

  gitFiles = ["src/app.ts"];
  index.retainRoots([rootPath]);

  const gitResponse = await index.search(rootPath, "app");
  assert.equal(gitResponse.fullSearchAvailable, true);
  assert.deepEqual(
    gitResponse.results.map((entry) => entry.name),
    ["app.ts"],
  );
});

contractTest("desktop.hermetic", "DesktopProjectFileIndex falls back to known directory listings for non-Git roots", async () => {
  const rootPath = "/tmp/project-a";
  const index = new DesktopProjectFileIndex({
    gitListFiles: async () => {},
  });
  index.rememberDirectoryListing({
    rootPath,
    directoryPath: rootPath,
    entries: [
      { path: path.join(rootPath, "README.md"), name: "README.md", kind: "file" },
      { path: path.join(rootPath, "src"), name: "src", kind: "directory" },
    ],
  });
  index.rememberDirectoryListing({
    rootPath,
    directoryPath: path.join(rootPath, "src"),
    entries: [
      { path: path.join(rootPath, "src/app.ts"), name: "app.ts", kind: "file" },
    ],
  });

  const response = await index.search(rootPath, "app");

  assert.equal(response.fullSearchAvailable, false);
  assert.equal(response.truncated, false);
  assert.deepEqual(response.results, [{
    path: path.join(rootPath, "src/app.ts"),
    name: "app.ts",
    directoryPath: path.join(rootPath, "src"),
  }]);
});

contractTest("desktop.hermetic", "DesktopProjectFileIndex returns bounded full-text match previews and skips unsafe or unsupported files", async () => {
  const rootPath = await mkdtemp(path.join(tmpdir(), "kestrel-desktop-content-search-"));
  const outsidePath = path.join(path.dirname(rootPath), `${path.basename(rootPath)}-outside.txt`);
  await mkdir(path.join(rootPath, "src"));
  await writeFile(path.join(rootPath, "src/app.ts"), "first line\nconst TargetValue = 'target';\n", "utf8");
  await writeFile(path.join(rootPath, "binary.dat"), Buffer.from([0, 1, 2, 3]));
  await writeFile(outsidePath, "target outside\n", "utf8");
  await symlink(outsidePath, path.join(rootPath, "linked.txt"));
  const index = new DesktopProjectFileIndex({
    gitListFiles: async () => ["src/app.ts", "binary.dat", "linked.txt", "../outside.txt"],
  });

  const response = await index.searchContent(rootPath, "target");

  assert.equal(response.fullSearchAvailable, true);
  assert.equal(response.truncated, false);
  assert.equal(response.scannedFileCount, 1);
  assert.equal(response.skippedFileCount, 3);
  assert.deepEqual(response.results, [7, 22].map((columnNumber) => ({
      path: path.join(rootPath, "src/app.ts"),
      name: "app.ts",
      directoryPath: path.join(rootPath, "src"),
      lineNumber: 2,
      columnNumber,
      preview: "const TargetValue = 'target';",
    })));
});
