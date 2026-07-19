import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";

const execFileAsync = promisify(execFile);

export function textRevision(content: Buffer | string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export async function readRevision(absolutePath: string): Promise<string> {
  return textRevision(await readFile(absolutePath));
}

export function assertExpectedRevision(input: {
  toolName: string;
  path: string;
  expectedRevision: string;
  actualRevision: string;
}): void {
  if (input.expectedRevision === input.actualRevision) {
    return;
  }
  throw createRuntimeFailure("FILE_REVISION_STALE", `${input.toolName} rejected a stale revision for ${input.path}.`, {
    path: input.path,
    expectedRevision: input.expectedRevision,
    actualRevision: input.actualRevision,
    recoverable: true,
    nextSuggestedAction: `Reread ${input.path} and rebuild the edit from the latest content.`,
  });
}

export async function writeTextAtomically(input: {
  absolutePath: string;
  content: string;
  mode?: number | undefined;
}): Promise<void> {
  const temporaryPath = `${input.absolutePath}.kestrel-edit-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporaryPath, input.content, { encoding: "utf8", flag: "wx" });
    if (input.mode !== undefined) {
      await chmod(temporaryPath, input.mode);
    }
    await rename(temporaryPath, input.absolutePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function buildUnifiedTextDiff(input: {
  displayPath: string;
  before: string;
  after: string;
}): Promise<string> {
  if (input.before === input.after) {
    return "";
  }
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-text-diff-"));
  const beforePath = path.join(tempRoot, "before");
  const afterPath = path.join(tempRoot, "after");
  try {
    await writeFile(beforePath, input.before, "utf8");
    await writeFile(afterPath, input.after, "utf8");
    let stdout = "";
    try {
      const result = await execFileAsync("git", ["diff", "--no-index", "--no-ext-diff", "--unified=3", "--", beforePath, afterPath], {
        maxBuffer: 4 * 1024 * 1024,
      });
      stdout = result.stdout;
    } catch (error) {
      const record = error as { code?: number | string; stdout?: string };
      if (record.code !== 1 || typeof record.stdout !== "string") {
        throw error;
      }
      stdout = record.stdout;
    }
    const lines = stdout.split("\n");
    return lines.map((line) => {
      if (line.startsWith("diff --git ")) {
        return `diff --git a/${input.displayPath} b/${input.displayPath}`;
      }
      if (line.startsWith("--- ")) {
        return `--- a/${input.displayPath}`;
      }
      if (line.startsWith("+++ ")) {
        return `+++ b/${input.displayPath}`;
      }
      return line;
    }).join("\n");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
