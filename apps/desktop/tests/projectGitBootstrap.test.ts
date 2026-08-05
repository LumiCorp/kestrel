import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  ensureDesktopProjectGitBootstrap,
  inspectDesktopProjectGitBootstrap,
  prepareDesktopProjectRegistrations,
} from "../src/projectGitBootstrap.js";


const execFileAsync = promisify(execFile);

test("project inspection discloses Git bootstrap without mutating the folder", async () => {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), "kestrel-inspect-empty-"));

  const inspection = await inspectDesktopProjectGitBootstrap(projectPath);

  assert.deepEqual(inspection, {
    projectPath,
    kind: "empty",
    requiresGitBootstrap: true,
  });
  assert.deepEqual(await readdir(projectPath), []);
});

test("project inspection recognizes non-empty folders as no-mutation registrations", async () => {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), "kestrel-inspect-existing-"));
  await writeFile(path.join(projectPath, "notes.txt"), "keep me\n", "utf8");

  const inspection = await inspectDesktopProjectGitBootstrap(projectPath);

  assert.equal(inspection.kind, "non_empty");
  assert.equal(inspection.requiresGitBootstrap, false);
  assert.deepEqual(await readdir(projectPath), ["notes.txt"]);
});

test("project inspection requires confirmation for a non-empty Git repository without HEAD", async () => {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), "kestrel-inspect-unborn-git-"));
  await git(projectPath, ["init"]);
  const sourcePath = path.join(projectPath, "main.ts");
  await writeFile(sourcePath, "export const ready = true;\n", "utf8");

  const inspection = await inspectDesktopProjectGitBootstrap(projectPath);

  assert.equal(inspection.kind, "git_without_head");
  assert.equal(inspection.requiresGitBootstrap, true);
  assert.equal(await readFile(sourcePath, "utf8"), "export const ready = true;\n");
  await assert.rejects(git(projectPath, ["rev-parse", "HEAD"]));

  const unconfirmed = await ensureDesktopProjectGitBootstrap(projectPath);
  assert.equal(unconfirmed.status, "skipped_non_empty");
  await assert.rejects(git(projectPath, ["rev-parse", "HEAD"]));

  const result = await ensureDesktopProjectGitBootstrap(projectPath, {
    allowNonEmptyGitWithoutHeadBootstrap: true,
  });
  assert.equal(result.status, "initialized_head");
  assert.match(await git(projectPath, ["rev-parse", "HEAD"]), /^[0-9a-f]{40}$/u);
  assert.equal(await readFile(sourcePath, "utf8"), "export const ready = true;\n");
  assert.match(await git(projectPath, ["status", "--short"]), /\?\? main\.ts/u);
});

test("ensureDesktopProjectGitBootstrap initializes an empty project with a HEAD commit", async () => {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), "kestrel-empty-project-"));

  const result = await ensureDesktopProjectGitBootstrap(projectPath);

  assert.equal(result.status, "initialized");
  const head = await git(projectPath, ["rev-parse", "HEAD"]);
  assert.match(head, /^[0-9a-f]{40}$/u);
});

test("ensureDesktopProjectGitBootstrap initializes a Kestrel-only project without deleting managed files", async () => {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), "kestrel-managed-only-project-"));
  const notePath = path.join(projectPath, ".kestrel", "session-note.md");
  await mkdir(path.dirname(notePath), { recursive: true });
  await writeFile(notePath, "# Note\n", "utf8");

  const result = await ensureDesktopProjectGitBootstrap(projectPath);

  assert.equal(result.status, "initialized");
  assert.equal(await readFile(notePath, "utf8"), "# Note\n");
  const head = await git(projectPath, ["rev-parse", "HEAD"]);
  assert.match(head, /^[0-9a-f]{40}$/u);
});

test("ensureDesktopProjectGitBootstrap leaves non-empty non-git folders untouched", async () => {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), "kestrel-existing-folder-"));
  await writeFile(path.join(projectPath, "notes.txt"), "user content\n", "utf8");

  const result = await ensureDesktopProjectGitBootstrap(projectPath);

  assert.equal(result.status, "skipped_non_empty");
  assert.deepEqual(await readdir(projectPath), ["notes.txt"]);
});

test("prepareDesktopProjectRegistrations drops missing project paths during settings saves", async () => {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), "kestrel-registered-project-"));
  const missingProjectPath = path.join(projectPath, "missing-project");

  const prepared = await prepareDesktopProjectRegistrations([
    { path: projectPath, label: "registered-project" },
    { path: missingProjectPath, label: "missing-project" },
  ]);

  assert.deepEqual(prepared, [
    { path: projectPath, label: "registered-project" },
  ]);
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}
