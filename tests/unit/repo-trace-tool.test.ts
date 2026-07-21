import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { repoTraceTool } from "../../tools/repo/trace.js";
import { contractTest } from "../helpers/contract-test.js";


interface RepoTraceMatch {
  seed: string;
  line: number;
  column: number;
  preview: string;
  contextBefore: string[];
  contextAfter: string[];
}

interface RepoTraceGroup {
  path: string;
  matches: RepoTraceMatch[];
}

interface RepoTraceResult {
  path: string;
  seeds: string[];
  searchedFileCount: number;
  matchedFileCount: number;
  resultCount: number;
  truncated: boolean;
  groups: RepoTraceGroup[];
}

contractTest("runtime.hermetic", "repo.trace finds exact references across source, tests, templates, docs, and config", async () => {
  const workspace = await createTraceWorkspace();
  await writeFile(path.join(workspace, "src", "format.py"), "def format_error():\n    return 'STACK_LIMIT'\n", "utf8");
  await writeFile(path.join(workspace, "tests", "test_format.py"), "def test_error():\n    assert value == 'STACK_LIMIT'\n", "utf8");
  await writeFile(path.join(workspace, "templates", "error.html"), "<p>STACK_LIMIT</p>\n", "utf8");
  await writeFile(path.join(workspace, "README.md"), "Document STACK_LIMIT behavior.\n", "utf8");
  await writeFile(path.join(workspace, "pyproject.toml"), "[tool.demo]\nmessage = 'STACK_LIMIT'\n", "utf8");

  const result = await callRepoTrace(workspace, {
    seeds: ["STACK_LIMIT"],
    contextLines: 1,
  });

  assert.equal(result.path, ".");
  assert.equal(result.resultCount, 5);
  assert.equal(result.matchedFileCount, 5);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.groups.map((group) => group.path).sort(), [
    "README.md",
    "pyproject.toml",
    "src/format.py",
    "templates/error.html",
    "tests/test_format.py",
  ]);
  const sourceMatch = result.groups.find((group) => group.path === "src/format.py")?.matches[0];
  assert.equal(sourceMatch?.line, 2);
  assert.equal(sourceMatch?.column, 13);
  assert.deepEqual(sourceMatch?.contextBefore, ["def format_error():"]);
});

contractTest("runtime.hermetic", "repo.trace honors path, includeGlobs, excludeGlobs, maxResults, and contextLines", async () => {
  const workspace = await createTraceWorkspace();
  await writeFile(path.join(workspace, "src", "a.py"), "before\nTOKEN one\nTOKEN two\nafter\n", "utf8");
  await writeFile(path.join(workspace, "src", "skip.py"), "TOKEN skipped\n", "utf8");
  await writeFile(path.join(workspace, "tests", "a.test"), "TOKEN wrong extension\n", "utf8");

  const result = await callRepoTrace(workspace, {
    path: "src",
    seeds: ["TOKEN"],
    includeGlobs: ["**/*.py"],
    excludeGlobs: ["**/skip.py"],
    maxResults: 1,
    contextLines: 1,
  });

  assert.equal(result.path, "src");
  assert.equal(result.resultCount, 1);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.groups.map((group) => group.path), ["src/a.py"]);
  assert.deepEqual(result.groups[0]?.matches[0]?.contextBefore, ["before"]);
  assert.deepEqual(result.groups[0]?.matches[0]?.contextAfter, ["TOKEN two"]);
});

contractTest("runtime.hermetic", "repo.trace excludes heavy generated directories by default", async () => {
  const workspace = await createTraceWorkspace();
  await writeFile(path.join(workspace, "src", "main.ts"), "const marker = 'VISIBLE_TOKEN';\n", "utf8");
  await mkdir(path.join(workspace, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(workspace, "node_modules", "pkg", "index.js"), "const marker = 'VISIBLE_TOKEN';\n", "utf8");
  await mkdir(path.join(workspace, "dist"), { recursive: true });
  await writeFile(path.join(workspace, "dist", "bundle.js"), "const marker = 'VISIBLE_TOKEN';\n", "utf8");

  const result = await callRepoTrace(workspace, {
    seeds: ["VISIBLE_TOKEN"],
  });

  assert.equal(result.resultCount, 1);
  assert.deepEqual(result.groups.map((group) => group.path), ["src/main.ts"]);
});

contractTest("runtime.hermetic", "repo.trace handles multiple seeds and reports truncation when capped", async () => {
  const workspace = await createTraceWorkspace();
  await writeFile(path.join(workspace, "src", "main.ts"), "ALPHA BETA\nALPHA\nBETA\n", "utf8");

  const result = await callRepoTrace(workspace, {
    seeds: ["ALPHA", "BETA"],
    maxResults: 2,
    contextLines: 0,
  });

  assert.equal(result.resultCount, 2);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.groups[0]?.matches.map((match) => match.seed), ["ALPHA", "BETA"]);
});

async function createTraceWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "kestrel-repo-trace-"));
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(path.join(workspace, "tests"), { recursive: true });
  await mkdir(path.join(workspace, "templates"), { recursive: true });
  return workspace;
}

async function callRepoTrace(workspace: string, input: Record<string, unknown>): Promise<RepoTraceResult> {
  const handler = repoTraceTool.createHandler({
    fileSystem: {
      workspaceRoot: workspace,
      tempRoots: [os.tmpdir()],
    },
  });
  return await handler(input) as RepoTraceResult;
}
