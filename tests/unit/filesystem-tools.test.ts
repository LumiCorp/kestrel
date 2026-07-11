import test from "node:test";
import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isToolClassAllowed } from "../../src/mode/contracts.js";
import type { AgentToolResult } from "../../src/kestrel/contracts/model-io.js";
import { defaultToolCatalog, FILESYSTEM_TOOL_NAMES } from "../../tools/index.js";
import { isAgentToolResult, unwrapAgentToolOutput } from "../../tools/toolResult.js";

interface FsTestHandlers {
  "fs.list": (input: unknown) => Promise<unknown>;
  "fs.read_text": (input: unknown) => Promise<unknown>;
  "fs.verify_json": (input: unknown) => Promise<unknown>;
  "fs.search_text": (input: unknown) => Promise<unknown>;
  "fs.write_text": (input: unknown) => Promise<unknown>;
  "fs.replace_text": (input: unknown) => Promise<unknown>;
  "fs.mkdir": (input: unknown) => Promise<unknown>;
  "fs.copy": (input: unknown) => Promise<unknown>;
  "fs.move": (input: unknown) => Promise<unknown>;
  "fs.delete": (input: unknown) => Promise<unknown>;
}

test("filesystem tools allow workspace-relative and temp-root paths and reject escapes", async () => {
  const { handlers, policyRoots } = await createFsHarness();
  await writeFile(path.join(policyRoots.workspaceRoot, "notes.txt"), "workspace data", "utf8");
  await writeFile(path.join(policyRoots.tempRoot, "cache.txt"), "temp data", "utf8");
  await writeFile(path.join(policyRoots.outsideRoot, "secret.txt"), "forbidden", "utf8");

  const workspaceRead = await rawToolOutput<{
    path: string;
    content: string;
  }>(handlers["fs.read_text"]({ path: "notes.txt" }));
  assert.equal(workspaceRead.path, "notes.txt");
  assert.equal(workspaceRead.content, "workspace data");

  const tempRead = await rawToolOutput<{ path: string; content: string }>(handlers["fs.read_text"]({
    path: path.join(policyRoots.tempRoot, "cache.txt"),
  }));
  assert.equal(tempRead.path, path.join(policyRoots.tempRoot, "cache.txt"));
  assert.equal(tempRead.content, "temp data");

  await assert.rejects(
    () => handlers["fs.read_text"]({ path: path.join(policyRoots.outsideRoot, "secret.txt") }),
    /outside allowed roots/,
  );
});

test("filesystem tools reject symlink escapes outside allowed roots", async () => {
  const { handlers, policyRoots } = await createFsHarness();
  const outsideFile = path.join(policyRoots.outsideRoot, "linked-secret.txt");
  const linkPath = path.join(policyRoots.workspaceRoot, "escape-link.txt");

  await writeFile(outsideFile, "do not read", "utf8");
  await symlink(outsideFile, linkPath);

  await assert.rejects(
    () => handlers["fs.read_text"]({ path: "escape-link.txt" }),
    /outside allowed roots/,
  );
});

test("filesystem read_text returns bounded content and read metadata", async () => {
  const { handlers, policyRoots } = await createFsHarness();
  await writeFile(path.join(policyRoots.workspaceRoot, "large-read.txt"), "abcdefghij", "utf8");

  const result = await rawToolOutput<{
    content: string;
    truncated: boolean;
    bytesRead: number;
    maxBytes: number;
  }>(handlers["fs.read_text"]({
    path: "large-read.txt",
    maxBytes: 5,
  }));

  assert.equal(result.content, "abcde");
  assert.equal(result.truncated, true);
  assert.equal(result.bytesRead, 5);
  assert.equal(result.maxBytes, 5);
});

test("filesystem list semantic facts do not follow hidden control symlinks outside allowed roots", async () => {
  const { handlers, policyRoots } = await createFsHarness();
  await mkdir(path.join(policyRoots.workspaceRoot, "hidden-symlink"), { recursive: true });
  await mkdir(path.join(policyRoots.outsideRoot, "external-git"), { recursive: true });
  await writeFile(path.join(policyRoots.outsideRoot, "external-git/HEAD"), "ref: refs/heads/main\n", "utf8");
  await symlink(path.join(policyRoots.outsideRoot, "external-git"), path.join(policyRoots.workspaceRoot, "hidden-symlink/.git"));

  const result = await rawToolOutput<{
    entries: Array<{ path: string }>;
    directoryFacts?: {
      hasGitRepository?: boolean;
      gitRepository?: unknown;
      classification?: string;
    };
    message?: string;
  }>(handlers["fs.list"]({
    path: "hidden-symlink",
    includeHidden: false,
  }));

  assert.deepEqual(result.entries, []);
  assert.equal(result.directoryFacts?.hasGitRepository, true);
  assert.equal(result.directoryFacts?.gitRepository, undefined);
  assert.equal(result.directoryFacts?.classification, "empty_git_repository");
  assert.equal(result.message, "This directory contains Git repository metadata and no visible project files.");
});

test("filesystem text tools honor overwrite, append, replace, and delete defaults", async () => {
  const { handlers, policyRoots } = await createFsHarness();
  await handlers["fs.write_text"]({
    path: "nested/empty.txt",
    content: "",
    createParents: true,
  });
  assert.equal(await readFile(path.join(policyRoots.workspaceRoot, "nested/empty.txt"), "utf8"), "");

  await handlers["fs.write_text"]({
    path: "nested/empty.txt",
    content: "first",
  });
  await handlers["fs.write_text"]({
    path: "nested/empty.txt",
    content: "-second",
    mode: "append",
  });
  assert.equal(
    await readFile(path.join(policyRoots.workspaceRoot, "nested/empty.txt"), "utf8"),
    "first-second",
  );

  const replaceResult = await rawToolOutput<{ replacements: number; changed: boolean; status: string; message: string }>(handlers["fs.replace_text"]({
    path: "nested/empty.txt",
    find: "first",
    replace: "",
  }));
  assert.equal(replaceResult.replacements, 1);
  assert.equal(replaceResult.changed, true);
  assert.equal(replaceResult.status, "OK");
  assert.match(replaceResult.message, /Replaced 1 occurrence/u);
  assert.equal(await readFile(path.join(policyRoots.workspaceRoot, "nested/empty.txt"), "utf8"), "-second");

  const noOpReplaceResult = await rawToolOutput<{ replacements: number; changed: boolean; status: string; message: string }>(handlers["fs.replace_text"]({
    path: "nested/empty.txt",
    find: "not present",
    replace: "replacement",
  }));
  assert.equal(noOpReplaceResult.replacements, 0);
  assert.equal(noOpReplaceResult.changed, false);
  assert.equal(noOpReplaceResult.status, "NO_CHANGE");
  assert.equal(noOpReplaceResult.message, "No occurrences matched; file was not changed.");
  assert.equal(await readFile(path.join(policyRoots.workspaceRoot, "nested/empty.txt"), "utf8"), "-second");

  const mkdirResult = await rawToolOutput<{
    path: string;
    recursive: boolean;
  }>(handlers["fs.mkdir"]({ path: "nested/deeper/path" }));
  assert.deepEqual(mkdirResult, {
    path: "nested/deeper/path",
    recursive: true,
  });
  const createdDir = await lstat(path.join(policyRoots.workspaceRoot, "nested/deeper/path"));
  assert.equal(createdDir.isDirectory(), true);

  await writeFile(path.join(policyRoots.workspaceRoot, "nested/deeper/path/file.txt"), "x", "utf8");
  const nonRecursiveDelete = await failedToolResult(
    handlers["fs.delete"]({ path: "nested/deeper", recursive: false }),
  );
  assert.match(String((nonRecursiveDelete.auditRecord.error as { message?: unknown }).message), /Directory is not empty/u);
  await handlers["fs.delete"]({ path: "nested/deeper", recursive: true });
  await assert.rejects(
    () => lstat(path.join(policyRoots.workspaceRoot, "nested/deeper")),
    /ENOENT/,
  );
});

test("filesystem write_text reports compact overwrite facts for existing files", async () => {
  const { handlers, policyRoots } = await createFsHarness();
  await writeFile(path.join(policyRoots.workspaceRoot, "constrained.txt"), "alpha beta gamma\nsecond line\n", "utf8");

  const result = await rawToolOutput<{
    path: string;
    mode: string;
    existed: boolean;
    changed: boolean;
    bytesBefore: number;
    bytesAfter: number;
    lineCountBefore: number;
    lineCountAfter: number;
    whitespaceTokenCountBefore: number;
    whitespaceTokenCountAfter: number;
    diffPreview: { before: string; after: string; truncated: boolean };
  }>(handlers["fs.write_text"]({
    path: "constrained.txt",
    content: "alpha gamma\nsecond line\n",
  }));

  assert.equal(result.path, "constrained.txt");
  assert.equal(result.mode, "overwrite");
  assert.equal(result.existed, true);
  assert.equal(result.changed, true);
  assert.equal(result.bytesBefore, Buffer.byteLength("alpha beta gamma\nsecond line\n", "utf8"));
  assert.equal(result.bytesAfter, Buffer.byteLength("alpha gamma\nsecond line\n", "utf8"));
  assert.equal(result.lineCountBefore, 3);
  assert.equal(result.lineCountAfter, 3);
  assert.equal(result.whitespaceTokenCountBefore, 5);
  assert.equal(result.whitespaceTokenCountAfter, 4);
  assert.match(result.diffPreview.before, /beta/u);
  assert.doesNotMatch(result.diffPreview.after, /beta/u);
  assert.equal(result.diffPreview.truncated, false);
  assert.equal(await readFile(path.join(policyRoots.workspaceRoot, "constrained.txt"), "utf8"), "alpha gamma\nsecond line\n");
});

test("filesystem write_text keeps new-file and append outputs simple", async () => {
  const { handlers, policyRoots } = await createFsHarness();

  const created = await rawToolOutput<Record<string, unknown>>(handlers["fs.write_text"]({
    path: "new.txt",
    content: "hello world\n",
  }));
  assert.equal(created.existed, false);
  assert.equal(created.changed, undefined);
  assert.equal(created.bytesBefore, undefined);
  assert.equal(created.diffPreview, undefined);

  const appended = await rawToolOutput<Record<string, unknown>>(handlers["fs.write_text"]({
    path: "new.txt",
    content: "again\n",
    mode: "append",
  }));
  assert.equal(appended.existed, true);
  assert.equal(appended.changed, undefined);
  assert.equal(appended.bytesBefore, undefined);
  assert.equal(appended.diffPreview, undefined);
  assert.equal(appended.whitespaceTokenCountAfter, 3);
  assert.equal(await readFile(path.join(policyRoots.workspaceRoot, "new.txt"), "utf8"), "hello world\nagain\n");
});

test("filesystem write_text reports bounded facts for large existing appends", async () => {
  const { handlers, policyRoots } = await createFsHarness();
  const largeContent = "x".repeat(1024 * 1024 + 1);
  await writeFile(path.join(policyRoots.workspaceRoot, "large-append.txt"), largeContent, "utf8");

  const appended = await rawToolOutput<Record<string, unknown>>(handlers["fs.write_text"]({
    path: "large-append.txt",
    content: "tail",
    mode: "append",
  }));

  assert.equal(appended.existed, true);
  assert.equal(appended.bytesAfter, Buffer.byteLength(largeContent, "utf8") + Buffer.byteLength("tail", "utf8"));
  assert.equal(appended.statsTruncated, true);
  assert.equal(appended.whitespaceTokenCountAfter, undefined);
  assert.equal((await stat(path.join(policyRoots.workspaceRoot, "large-append.txt"))).size, appended.bytesAfter);
});

test("filesystem replace_text reports compact token and line deltas", async () => {
  const { handlers, policyRoots } = await createFsHarness();
  const filePath = path.join(policyRoots.workspaceRoot, "replace.txt");
  await writeFile(filePath, "alpha a great deal more omega\nsecond line\n", "utf8");

  const tokenLosing = await rawToolOutput<Record<string, unknown>>(handlers["fs.replace_text"]({
    path: "replace.txt",
    find: "a great deal more",
    replace: "a lot more",
  }));
  assert.equal(tokenLosing.changed, true);
  assert.equal(tokenLosing.replacements, 1);
  assert.equal(tokenLosing.findWhitespaceTokenCount, 4);
  assert.equal(tokenLosing.replaceWhitespaceTokenCount, 3);
  assert.equal(tokenLosing.perReplacementWhitespaceTokenDelta, -1);
  assert.equal(tokenLosing.whitespaceTokenCountDelta, -1);
  assert.equal(tokenLosing.lineCountDelta, 0);
  assert.equal(tokenLosing.whitespaceTokenCountBefore, 8);
  assert.equal(tokenLosing.whitespaceTokenCountAfter, 7);

  const tokenPreserving = await rawToolOutput<Record<string, unknown>>(handlers["fs.replace_text"]({
    path: "replace.txt",
    find: "second line",
    replace: "third row",
  }));
  assert.equal(tokenPreserving.changed, true);
  assert.equal(tokenPreserving.perReplacementWhitespaceTokenDelta, 0);
  assert.equal(tokenPreserving.whitespaceTokenCountDelta, 0);
  assert.equal(tokenPreserving.lineCountDelta, 0);

  await writeFile(filePath, "red blue\nred blue\n", "utf8");
  const replaceAll = await rawToolOutput<Record<string, unknown>>(handlers["fs.replace_text"]({
    path: "replace.txt",
    find: "red blue",
    replace: "purple",
    all: true,
  }));
  assert.equal(replaceAll.replacements, 2);
  assert.equal(replaceAll.perReplacementWhitespaceTokenDelta, -1);
  assert.equal(replaceAll.whitespaceTokenCountDelta, -2);

  const noMatch = await rawToolOutput<Record<string, unknown>>(handlers["fs.replace_text"]({
    path: "replace.txt",
    find: "missing phrase",
    replace: "replacement phrase",
  }));
  assert.equal(noMatch.changed, false);
  assert.equal(noMatch.replacements, 0);
  assert.equal(noMatch.findWhitespaceTokenCount, 2);
  assert.equal(noMatch.replaceWhitespaceTokenCount, 2);
  assert.equal(noMatch.perReplacementWhitespaceTokenDelta, 0);
  assert.equal(noMatch.bytesBefore, undefined);
  assert.equal(noMatch.whitespaceTokenCountDelta, undefined);
});

test("filesystem replace_text rejects empty needles and oversized files", async () => {
  const { handlers, policyRoots } = await createFsHarness();
  await writeFile(path.join(policyRoots.workspaceRoot, "replace-small.txt"), "alpha", "utf8");

  const emptyNeedle = await failedToolResult(handlers["fs.replace_text"]({
    path: "replace-small.txt",
    find: "",
    replace: "beta",
  }));
  assert.match(String((emptyNeedle.auditRecord.error as { message?: unknown }).message), /must not be empty/u);

  await writeFile(path.join(policyRoots.workspaceRoot, "replace-large.txt"), "x".repeat(1024 * 1024 + 1), "utf8");
  const oversized = await failedToolResult(handlers["fs.replace_text"]({
    path: "replace-large.txt",
    find: "x",
    replace: "y",
  }));
  assert.match(String((oversized.auditRecord.error as { message?: unknown }).message), /too large/u);
});

test("filesystem search and list outputs are bounded and deterministic", async () => {
  const { handlers, policyRoots } = await createFsHarness();
  await mkdir(path.join(policyRoots.workspaceRoot, "search"), { recursive: true });
  await mkdir(path.join(policyRoots.workspaceRoot, "search/nested"), { recursive: true });
  await writeFile(path.join(policyRoots.workspaceRoot, "search/a.txt"), "needle alpha\nneedle beta\n", "utf8");
  await writeFile(path.join(policyRoots.workspaceRoot, "search/b.txt"), "Needle gamma\n", "utf8");
  await writeFile(path.join(policyRoots.workspaceRoot, "search/nested/inner.txt"), "needle nested\n", "utf8");
  await writeFile(path.join(policyRoots.workspaceRoot, "search/.hidden.txt"), "needle hidden\n", "utf8");

  const shallowListResult = await rawToolOutput<{ entries: Array<{ path: string }> }>(handlers["fs.list"]({
    path: "search",
    includeHidden: false,
  }));
  assert.deepEqual(
    shallowListResult.entries.map((entry) => entry.path),
    ["search/a.txt", "search/b.txt", "search/nested"],
  );

  const zeroDepthListResult = await rawToolOutput<{ entries: Array<{ path: string }>; message?: string; empty?: boolean }>(handlers["fs.list"]({
    path: "search",
    recursive: true,
    maxDepth: 0,
    includeHidden: false,
  }));
  assert.deepEqual(
    zeroDepthListResult.entries.map((entry) => entry.path),
    [],
  );
  assert.equal(zeroDepthListResult.empty, true);
  assert.equal(
    zeroDepthListResult.message,
    "No entries were returned because recursive listing was limited to maxDepth 0.",
  );

  const oneDepthListResult = await rawToolOutput<{ entries: Array<{ path: string }> }>(handlers["fs.list"]({
    path: "search",
    recursive: true,
    maxDepth: 1,
    includeHidden: false,
  }));
  assert.deepEqual(
    oneDepthListResult.entries.map((entry) => entry.path),
    ["search/a.txt", "search/b.txt", "search/nested"],
  );

  const listResult = await rawToolOutput<{ entries: Array<{ path: string }> }>(handlers["fs.list"]({
    path: "search",
    recursive: true,
    maxDepth: 2,
    includeHidden: false,
  }));
  assert.deepEqual(
    listResult.entries.map((entry) => entry.path),
    ["search/a.txt", "search/b.txt", "search/nested", "search/nested/inner.txt"],
  );

  const searchResult = await rawToolOutput<{ matches: Array<{ path: string; line: number; column: number; preview: string }> }>(handlers["fs.search_text"]({
    path: "search",
    query: "needle",
    caseSensitive: false,
    maxResults: 2,
  }));
  assert.equal(searchResult.matches.length, 2);
  assert.deepEqual(
    searchResult.matches.map((match) => `${match.path}:${match.line}:${match.column}`),
    ["search/a.txt:1:1", "search/a.txt:2:1"],
  );
  assert.equal(searchResult.matches[0]?.preview, "needle alpha");
});

test("filesystem search clips previews and total returned preview payload", async () => {
  const { handlers, policyRoots } = await createFsHarness();
  await mkdir(path.join(policyRoots.workspaceRoot, "maps"), { recursive: true });
  const longLine = `${"x".repeat(2_000)} FIXME ${"y".repeat(2_000)}`;
  for (let index = 0; index < 10; index += 1) {
    await writeFile(path.join(policyRoots.workspaceRoot, "maps", `bundle-${index}.js.map`), longLine, "utf8");
  }

  const result = await rawToolOutput<{
    matches: Array<{ preview: string; previewTruncated?: boolean; previewChars?: number }>;
    matchCount: number;
    returnedMatchCount: number;
    truncated: boolean;
    previewTruncatedCount: number;
    totalPreviewChars: number;
    maxPreviewChars: number;
    maxTotalPreviewChars: number;
  }>(handlers["fs.search_text"]({
    path: "maps",
    query: "FIXME",
    glob: "**/*.map",
    maxResults: 10,
    maxPreviewChars: 80,
    maxTotalPreviewChars: 240,
  }));

  assert.equal(result.maxPreviewChars, 80);
  assert.equal(result.maxTotalPreviewChars, 1_000);
  assert.equal(result.matches.length, 10);
  assert.equal(result.matchCount, 10);
  assert.equal(result.returnedMatchCount, 10);
  assert.equal(result.truncated, true);
  assert.equal(result.previewTruncatedCount, 10);
  assert.equal(result.totalPreviewChars, 800);
  assert.equal(result.matches.every((match) => match.preview.length <= 80), true);
  assert.equal(result.matches.every((match) => match.previewTruncated === true), true);
  assert.equal(result.matches.every((match) => match.previewChars === match.preview.length), true);
});

test("filesystem search total preview budget stops result accumulation", async () => {
  const { handlers, policyRoots } = await createFsHarness();
  await mkdir(path.join(policyRoots.workspaceRoot, "budget"), { recursive: true });
  const longLine = `${"a".repeat(300)} TODO ${"b".repeat(300)}`;
  for (let index = 0; index < 8; index += 1) {
    await writeFile(path.join(policyRoots.workspaceRoot, "budget", `file-${index}.txt`), longLine, "utf8");
  }

  const result = await rawToolOutput<{
    matches: Array<{ preview: string }>;
    truncated: boolean;
    totalPreviewChars: number;
    maxTotalPreviewChars: number;
  }>(handlers["fs.search_text"]({
    path: "budget",
    query: "TODO",
    maxResults: 8,
    maxPreviewChars: 240,
    maxTotalPreviewChars: 1_000,
  }));

  assert.equal(result.matches.length, 4);
  assert.equal(result.truncated, true);
  assert.equal(result.totalPreviewChars, 960);
  assert.equal(result.maxTotalPreviewChars, 1_000);
});

test("filesystem search glob narrows without widening into ignored roots", async () => {
  const { handlers, policyRoots } = await createFsHarness();
  await writeFile(path.join(policyRoots.workspaceRoot, ".gitignore"), "node_modules/\n.next/\n", "utf8");
  await mkdir(path.join(policyRoots.workspaceRoot, "src"), { recursive: true });
  await mkdir(path.join(policyRoots.workspaceRoot, "src/routes/home"), { recursive: true });
  await mkdir(path.join(policyRoots.workspaceRoot, "node_modules/pkg"), { recursive: true });
  await mkdir(path.join(policyRoots.workspaceRoot, ".next/server"), { recursive: true });
  await writeFile(path.join(policyRoots.workspaceRoot, "src/app.ts"), "needle source\n", "utf8");
  await writeFile(path.join(policyRoots.workspaceRoot, "src/page.ts"), "needle page\n", "utf8");
  await writeFile(path.join(policyRoots.workspaceRoot, "src/routes/home/page.tsx"), "needle route\n", "utf8");
  await writeFile(path.join(policyRoots.workspaceRoot, "src/routes/home/view.ts"), "needle view\n", "utf8");
  await writeFile(path.join(policyRoots.workspaceRoot, "node_modules/pkg/index.ts"), "needle dependency\n", "utf8");
  await writeFile(path.join(policyRoots.workspaceRoot, ".next/server/chunk.ts"), "needle generated\n", "utf8");

  const broad = await rawToolOutput<{ matches: Array<{ path: string; preview: string }> }>(handlers["fs.search_text"]({
    path: ".",
    query: "needle",
    glob: "**/*",
    maxResults: 10,
  }));
  assert.deepEqual(
    broad.matches.map((match) => `${match.path}:${match.preview}`),
    [
      "src/app.ts:needle source",
      "src/page.ts:needle page",
      "src/routes/home/page.tsx:needle route",
      "src/routes/home/view.ts:needle view",
    ],
  );

  const narrowed = await rawToolOutput<{ matches: Array<{ path: string; preview: string }> }>(handlers["fs.search_text"]({
    path: ".",
    query: "needle",
    glob: "**/*.ts",
    maxResults: 10,
  }));
  assert.deepEqual(
    narrowed.matches.map((match) => `${match.path}:${match.preview}`),
    [
      "src/app.ts:needle source",
      "src/page.ts:needle page",
      "src/routes/home/view.ts:needle view",
    ],
  );

  const basenameGlob = await rawToolOutput<{ matches: Array<{ path: string; preview: string }> }>(handlers["fs.search_text"]({
    path: ".",
    query: "needle",
    glob: "*.ts",
    maxResults: 10,
  }));
  assert.deepEqual(
    basenameGlob.matches.map((match) => `${match.path}:${match.preview}`),
    [
      "src/app.ts:needle source",
      "src/page.ts:needle page",
      "src/routes/home/view.ts:needle view",
    ],
  );

  const interiorGlobstar = await rawToolOutput<{ matches: Array<{ path: string; preview: string }> }>(handlers["fs.search_text"]({
    path: ".",
    query: "needle",
    glob: "src/**/*.ts",
    maxResults: 10,
  }));
  assert.deepEqual(
    interiorGlobstar.matches.map((match) => `${match.path}:${match.preview}`),
    [
      "src/app.ts:needle source",
      "src/page.ts:needle page",
      "src/routes/home/view.ts:needle view",
    ],
  );

  const braceGlob = await rawToolOutput<{ matches: Array<{ path: string; preview: string }> }>(handlers["fs.search_text"]({
    path: ".",
    query: "needle",
    glob: "**/*.{ts,tsx}",
    maxResults: 10,
  }));
  assert.deepEqual(
    braceGlob.matches.map((match) => `${match.path}:${match.preview}`),
    [
      "src/app.ts:needle source",
      "src/page.ts:needle page",
      "src/routes/home/page.tsx:needle route",
      "src/routes/home/view.ts:needle view",
    ],
  );

  const midPathGlobstar = await rawToolOutput<{ matches: Array<{ path: string; preview: string }> }>(handlers["fs.search_text"]({
    path: ".",
    query: "needle",
    glob: "src/**/page.{ts,tsx}",
    maxResults: 10,
  }));
  assert.deepEqual(
    midPathGlobstar.matches.map((match) => `${match.path}:${match.preview}`),
    [
      "src/page.ts:needle page",
      "src/routes/home/page.tsx:needle route",
    ],
  );

  const pathGlob = await rawToolOutput<{ matches: Array<{ path: string; preview: string }> }>(handlers["fs.search_text"]({
    path: ".",
    query: "needle",
    glob: "src/*.ts",
    maxResults: 10,
  }));
  assert.deepEqual(
    pathGlob.matches.map((match) => `${match.path}:${match.preview}`),
    [
      "src/app.ts:needle source",
      "src/page.ts:needle page",
    ],
  );
});

test("filesystem search requires ripgrep for directory fallback but allows direct file fallback", async () => {
  const { handlers, policyRoots } = await createFsHarness();
  await mkdir(path.join(policyRoots.workspaceRoot, "no-rg"), { recursive: true });
  await writeFile(path.join(policyRoots.workspaceRoot, "no-rg/file.txt"), "needle direct\n", "utf8");
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const direct = await rawToolOutput<{ matches: Array<{ path: string; preview: string }> }>(handlers["fs.search_text"]({
      path: "no-rg/file.txt",
      query: "needle",
    }));
    assert.deepEqual(
      direct.matches.map((match) => `${match.path}:${match.preview}`),
      ["no-rg/file.txt:needle direct"],
    );

    const directBasenameGlob = await rawToolOutput<{ matches: Array<{ path: string; preview: string }> }>(handlers["fs.search_text"]({
      path: "no-rg/file.txt",
      query: "needle",
      glob: "*.txt",
    }));
    assert.deepEqual(
      directBasenameGlob.matches.map((match) => `${match.path}:${match.preview}`),
      ["no-rg/file.txt:needle direct"],
    );

    const failed = await failedToolResult(handlers["fs.search_text"]({
      path: "no-rg",
      query: "needle",
    }));
    assert.equal(failed.status, "FAILED");
    assert.match(String((failed.auditRecord.error as { message?: unknown }).message), /requires ripgrep/u);

    await writeFile(path.join(policyRoots.workspaceRoot, "no-rg/large.txt"), `${"x".repeat(1024 * 1024 + 1)}needle`, "utf8");
    const largeFailed = await failedToolResult(handlers["fs.search_text"]({
      path: "no-rg/large.txt",
      query: "needle",
    }));
    assert.match(String((largeFailed.auditRecord.error as { message?: unknown }).message), /limited to 1048576 bytes/u);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("filesystem list reports truncation at the entry cap", async () => {
  const { handlers, policyRoots } = await createFsHarness();
  await mkdir(path.join(policyRoots.workspaceRoot, "many"), { recursive: true });
  for (let index = 0; index < 1001; index += 1) {
    await writeFile(path.join(policyRoots.workspaceRoot, "many", `file-${String(index).padStart(4, "0")}.txt`), "", "utf8");
  }

  const result = await rawToolOutput<{
    entries: Array<{ path: string }>;
    entryCount: number;
    truncated: boolean;
    maxEntries: number;
  }>(handlers["fs.list"]({ path: "many" }));

  assert.equal(result.entries.length, 1000);
  assert.equal(result.entryCount, 1000);
  assert.equal(result.truncated, true);
  assert.equal(result.maxEntries, 1000);
});

test("filesystem JSON verifier returns structured artifact verification results", async () => {
  const { handlers, policyRoots } = await createFsHarness();
  await writeFile(
    path.join(policyRoots.workspaceRoot, "newsletter-report.json"),
    JSON.stringify({
      stories: [
        {
          title: "Story 1",
          publisher: "Publisher 1",
          url: "https://example.com/story-1",
          category: "technology",
          summary: "Grounded summary 1.",
        },
        {
          title: "Story 2",
          publisher: "Publisher 2",
          url: "https://example.com/story-2",
          category: "business",
          summary: "Grounded summary 2.",
        },
      ],
    }),
    "utf8",
  );

  const passed = await rawToolOutput<{
    status: string;
    verificationToken: string;
    artifactVerification: { status: string; requirements: Array<{ status: string }> };
  }>(handlers["fs.verify_json"]({
    path: "newsletter-report.json",
    arrayPath: "stories",
    minLength: 2,
    requiredStringFields: ["title", "publisher", "url", "category", "summary"],
    requiredAbsoluteUrlFields: ["url"],
    forbiddenStringLiterals: ["[to be researched]"],
  }));
  assert.equal(passed.status, "passed");
  assert.equal(passed.verificationToken, "verify:newsletter-report.json::stories");
  assert.equal(passed.artifactVerification.status, "passed");
  assert.equal(passed.artifactVerification.requirements.some((item) => item.status === "failed"), false);

  await writeFile(
    path.join(policyRoots.workspaceRoot, "newsletter-report.json"),
    JSON.stringify({
      stories: [
        {
          title: "Story 1",
          publisher: "",
          url: "notaurl",
          category: "technology",
          summary: "[to be researched]",
        },
      ],
    }),
    "utf8",
  );

  const failed = await rawToolOutput<{
    status: string;
    artifactVerification: { status: string; failures?: string[] };
  }>(handlers["fs.verify_json"]({
    path: "newsletter-report.json",
    arrayPath: "stories",
    minLength: 2,
    requiredStringFields: ["title", "publisher", "url", "category", "summary"],
    requiredAbsoluteUrlFields: ["url"],
    forbiddenStringLiterals: ["[to be researched]"],
  }));
  assert.equal(failed.status, "failed");
  assert.equal(failed.artifactVerification.status, "failed");
  assert.equal(
    failed.artifactVerification.failures?.includes("stories[0].publisher is missing or blank."),
    true,
  );
  assert.equal(
    failed.artifactVerification.failures?.includes("stories[0].url is not an absolute http(s) URL."),
    true,
  );
  assert.equal(
    failed.artifactVerification.failures?.includes("stories[0].summary uses forbidden placeholder '[to be researched]'."),
    true,
  );
});

test("filesystem JSON verifier fails before parsing truncated content", async () => {
  const { handlers, policyRoots } = await createFsHarness();
  await writeFile(path.join(policyRoots.workspaceRoot, "large-json.json"), JSON.stringify({ stories: ["abcdef"] }), "utf8");

  const result = await rawToolOutput<{
    status: string;
    truncated: boolean;
    maxBytes: number;
    artifactVerification: {
      status: string;
      requirements: Array<{ id: string; status: string }>;
      failures?: string[];
    };
  }>(handlers["fs.verify_json"]({
    path: "large-json.json",
    maxBytes: 8,
  }));

  assert.equal(result.status, "failed");
  assert.equal(result.truncated, true);
  assert.equal(result.maxBytes, 8);
  assert.deepEqual(result.artifactVerification.requirements.map((item) => `${item.id}:${item.status}`), [
    "json_size:failed",
  ]);
  assert.match(String(result.artifactVerification.failures?.[0]), /exceeds JSON verification read budget/u);
});

test("filesystem JSON verifier caps emitted per-entry details", async () => {
  const { handlers, policyRoots } = await createFsHarness();
  await writeFile(
    path.join(policyRoots.workspaceRoot, "many-valid.json"),
    JSON.stringify({
      stories: Array.from({ length: 250 }, (_value, index) => ({
        title: `Story ${index}`,
      })),
    }),
    "utf8",
  );

  const result = await rawToolOutput<{
    status: string;
    artifactVerification: {
      status: string;
      requirements: Array<{ id: string; status: string }>;
      requirementsOmitted?: number;
    };
  }>(handlers["fs.verify_json"]({
    path: "many-valid.json",
    arrayPath: "stories",
    requiredStringFields: ["title"],
  }));

  assert.equal(result.status, "passed");
  assert.equal(result.artifactVerification.status, "passed");
  assert.equal(result.artifactVerification.requirements.length, 200);
  assert.equal(result.artifactVerification.requirements.at(-1)?.id, "details_omitted");
  assert.equal(result.artifactVerification.requirements.at(-1)?.status, "passed");
  assert.equal(result.artifactVerification.requirementsOmitted, 53);
});

test("filesystem list output explicitly describes empty visible directories", async () => {
  const { handlers, policyRoots } = await createFsHarness();
  await mkdir(path.join(policyRoots.workspaceRoot, "hidden-only"), { recursive: true });
  await mkdir(path.join(policyRoots.workspaceRoot, "hidden-only/.git"), { recursive: true });
  await mkdir(path.join(policyRoots.workspaceRoot, "hidden-only/.git/refs/heads"), { recursive: true });
  await mkdir(path.join(policyRoots.workspaceRoot, "hidden-only/.cache"), { recursive: true });
  await mkdir(path.join(policyRoots.workspaceRoot, "hidden-only/.cache/state"), { recursive: true });
  await writeFile(path.join(policyRoots.workspaceRoot, "hidden-only/.git/HEAD"), "ref: refs/heads/main\n", "utf8");
  await writeFile(
    path.join(policyRoots.workspaceRoot, "hidden-only/.git/refs/heads/main"),
    "0123456789abcdef0123456789abcdef01234567\n",
    "utf8",
  );
  await writeFile(path.join(policyRoots.workspaceRoot, "hidden-only/.git/index"), "", "utf8");
  await writeFile(path.join(policyRoots.workspaceRoot, "hidden-only/.cache/session-note.md"), "# Note\n", "utf8");
  await writeFile(
    path.join(policyRoots.workspaceRoot, "hidden-only/.cache/state/current.md"),
    "# Memory\n",
    "utf8",
  );

  const hiddenOnlyResult = await rawToolOutput<{
    path: string;
    entries: Array<{ path: string }>;
    entryCount: number;
    empty: boolean;
    includeHidden: boolean;
    omittedHiddenEntryCount?: number;
    directoryFacts?: {
      visibleEntryCount: number;
      hiddenEntryCount: number;
      hasGitRepository: boolean;
      classification?: string;
      gitRepository?: {
        present: boolean;
        initialized: boolean;
        headKind?: string;
        currentBranch?: string;
        hasHeadCommit?: boolean;
        hasIndex: boolean;
        latestMetadataMtime?: string;
      };
    };
    message?: string;
  }>(handlers["fs.list"]({
    path: "hidden-only",
    includeHidden: false,
  }));

  assert.equal(hiddenOnlyResult.path, "hidden-only");
  assert.deepEqual(hiddenOnlyResult.entries, []);
  assert.equal(hiddenOnlyResult.entryCount, 0);
  assert.equal(hiddenOnlyResult.empty, true);
  assert.equal(hiddenOnlyResult.includeHidden, false);
  assert.equal(hiddenOnlyResult.omittedHiddenEntryCount, 2);
  assert.deepEqual({
    visibleEntryCount: hiddenOnlyResult.directoryFacts?.visibleEntryCount,
    hiddenEntryCount: hiddenOnlyResult.directoryFacts?.hiddenEntryCount,
    hasGitRepository: hiddenOnlyResult.directoryFacts?.hasGitRepository,
    classification: hiddenOnlyResult.directoryFacts?.classification,
  }, {
    visibleEntryCount: 0,
    hiddenEntryCount: 2,
    hasGitRepository: true,
    classification: "empty_git_repository",
  });
  assert.deepEqual(hiddenOnlyResult.directoryFacts?.gitRepository, {
    present: true,
    initialized: true,
    headKind: "branch",
    currentBranch: "main",
    hasHeadCommit: true,
    hasIndex: true,
    latestMetadataMtime: hiddenOnlyResult.directoryFacts?.gitRepository?.latestMetadataMtime,
  });
  assert.match(String(hiddenOnlyResult.directoryFacts?.gitRepository?.latestMetadataMtime), /^\d{4}-\d{2}-\d{2}T/u);
  assert.match(
    String(hiddenOnlyResult.message),
    /^This directory contains Git repository metadata and no visible project files\. Git state: has a HEAD commit on branch main and an index\. Latest Git metadata mtime: .+$/u,
  );

  const hiddenIncludedResult = await rawToolOutput<{ entries: Array<{ path: string }>; empty: boolean; message?: string }>(handlers["fs.list"]({
    path: "hidden-only",
    includeHidden: true,
  }));
  assert.deepEqual(
    hiddenIncludedResult.entries.map((entry) => entry.path),
    ["hidden-only/.cache", "hidden-only/.git"],
  );
  assert.equal(hiddenIncludedResult.empty, false);
  assert.equal(hiddenIncludedResult.message, undefined);
});

test("filesystem tool execution classes match interaction mode policy", () => {
  const manifest = defaultToolCatalog.toCapabilityManifest(["fs.list", "fs.write_text", "fs.delete"]);
  const readOnlyClass = manifest[0]?.executionClass;
  const sandboxedClass = manifest[1]?.executionClass;
  const deleteClass = manifest[2]?.executionClass;

  assert.equal(readOnlyClass, "read_only");
  assert.equal(sandboxedClass, "sandboxed_only");
  assert.equal(deleteClass, "sandboxed_only");

  assert.equal(
    isToolClassAllowed({ interactionMode: "plan", toolClass: readOnlyClass! }),
    true,
  );
  assert.equal(
    isToolClassAllowed({ interactionMode: "plan", toolClass: sandboxedClass! }),
    false,
  );
  assert.equal(
    isToolClassAllowed({ interactionMode: "build", actSubmode: "safe", toolClass: sandboxedClass! }),
    true,
  );
  assert.equal(
    isToolClassAllowed({ interactionMode: "chat", toolClass: deleteClass! }),
    false,
  );
});

test("filesystem copy and move overwrite replace existing destinations instead of merging", async () => {
  const { handlers, policyRoots } = await createFsHarness();
  await mkdir(path.join(policyRoots.workspaceRoot, "src"), { recursive: true });
  await mkdir(path.join(policyRoots.workspaceRoot, "dest"), { recursive: true });
  await writeFile(path.join(policyRoots.workspaceRoot, "src/new.txt"), "new", "utf8");
  await writeFile(path.join(policyRoots.workspaceRoot, "dest/old.txt"), "old", "utf8");

  await handlers["fs.copy"]({
    sourcePath: "src",
    destinationPath: "dest",
    overwrite: true,
  });

  await assert.rejects(
    () => readFile(path.join(policyRoots.workspaceRoot, "dest/old.txt"), "utf8"),
    /ENOENT/,
  );
  assert.equal(
    await readFile(path.join(policyRoots.workspaceRoot, "dest/new.txt"), "utf8"),
    "new",
  );

  await mkdir(path.join(policyRoots.workspaceRoot, "move-src"), { recursive: true });
  await mkdir(path.join(policyRoots.workspaceRoot, "move-dest"), { recursive: true });
  await writeFile(path.join(policyRoots.workspaceRoot, "move-src/replaced.txt"), "moved", "utf8");
  await writeFile(path.join(policyRoots.workspaceRoot, "move-dest/stale.txt"), "stale", "utf8");

  await handlers["fs.move"]({
    sourcePath: "move-src",
    destinationPath: "move-dest",
    overwrite: true,
  });

  await assert.rejects(
    () => readFile(path.join(policyRoots.workspaceRoot, "move-dest/stale.txt"), "utf8"),
    /ENOENT/,
  );
  assert.equal(
    await readFile(path.join(policyRoots.workspaceRoot, "move-dest/replaced.txt"), "utf8"),
    "moved",
  );
  await assert.rejects(
    () => lstat(path.join(policyRoots.workspaceRoot, "move-src")),
    /ENOENT/,
  );
});

test("filesystem copy and move return stable parent-path errors", async () => {
  const { handlers, policyRoots } = await createFsHarness();
  await writeFile(path.join(policyRoots.workspaceRoot, "source.txt"), "data", "utf8");

  const copyFailure = await failedToolResult(
    handlers["fs.copy"]({
      sourcePath: "source.txt",
      destinationPath: "missing-parent/output.txt",
    }),
  );
  assert.match(String((copyFailure.auditRecord.error as { message?: unknown }).message), /Path does not exist: missing-parent/u);

  const moveFailure = await failedToolResult(
    handlers["fs.move"]({
      sourcePath: "source.txt",
      destinationPath: "missing-parent/output.txt",
    }),
  );
  assert.match(String((moveFailure.auditRecord.error as { message?: unknown }).message), /Path does not exist: missing-parent/u);
});

async function createPolicyRoots(): Promise<{
  workspaceRoot: string;
  tempRoot: string;
  outsideRoot: string;
}> {
  const baseRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-fs-tools-"));
  const workspaceRoot = path.join(baseRoot, "workspace");
  const tempRoot = path.join(baseRoot, "temp");
  const outsideRoot = path.join(baseRoot, "outside");

  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(tempRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });

  return {
    workspaceRoot,
    tempRoot,
    outsideRoot,
  };
}

async function rawToolOutput<T>(resultPromise: Promise<unknown>): Promise<T> {
  return unwrapAgentToolOutput(await resultPromise) as T;
}

async function failedToolResult(resultPromise: Promise<unknown>): Promise<AgentToolResult> {
  const result = await resultPromise;
  assert.equal(isAgentToolResult(result), true);
  assert.equal((result as AgentToolResult).status, "FAILED");
  return result as AgentToolResult;
}

async function createFsHarness(): Promise<{
  handlers: FsTestHandlers;
  policyRoots: Awaited<ReturnType<typeof createPolicyRoots>>;
}> {
  const policyRoots = await createPolicyRoots();
  return {
    handlers: defaultToolCatalog.createHandlers([...FILESYSTEM_TOOL_NAMES], {
      fileSystem: {
        workspaceRoot: policyRoots.workspaceRoot,
        tempRoots: [policyRoots.tempRoot],
      },
    }) as unknown as FsTestHandlers,
    policyRoots,
  };
}
