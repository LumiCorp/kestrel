import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  DESKTOP_FILE_SEARCH_RESULT_LIMIT,
  DesktopProjectFileIndex,
} from "../src/projectFileIndex.js";

test("DesktopProjectFileIndex searches Git tracked and untracked files with deterministic cap metadata", async () => {
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

test("DesktopProjectFileIndex can be invalidated after watcher events", async () => {
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

test("DesktopProjectFileIndex refreshes a cached non-Git root after project registration retention", async () => {
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

test("DesktopProjectFileIndex falls back to known directory listings for non-Git roots", async () => {
  const rootPath = "/tmp/project-a";
  const index = new DesktopProjectFileIndex({
    gitListFiles: async () => undefined,
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
