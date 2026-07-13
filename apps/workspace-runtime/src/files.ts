import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath, WorkspaceRequestError } from "./security.js";

export type WorkspaceFile = {
  content: Buffer;
  revision: string;
};

export async function readWorkspaceFile(
  workspaceRoot: string,
  requestedPath: string
): Promise<WorkspaceFile> {
  const filePath = resolveWorkspacePath(workspaceRoot, requestedPath);
  try {
    const content = await readFile(filePath);
    return { content, revision: fileRevision(content) };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new WorkspaceRequestError(404, "WORKSPACE_FILE_NOT_FOUND");
    }
    throw error;
  }
}

export async function writeWorkspaceFile(input: {
  workspaceRoot: string;
  requestedPath: string;
  expectedRevision: string | undefined;
  content: Buffer;
}): Promise<{ revision: string }> {
  if (!input.expectedRevision) {
    throw new WorkspaceRequestError(
      428,
      "WORKSPACE_FILE_REVISION_REQUIRED"
    );
  }
  const filePath = resolveWorkspacePath(input.workspaceRoot, input.requestedPath);
  const before = await readWorkspaceFile(
    input.workspaceRoot,
    input.requestedPath
  );
  assertRevision(before.revision, input.expectedRevision);

  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.kestrel-${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporaryPath, input.content, { flag: "wx" });
    const current = await readWorkspaceFile(
      input.workspaceRoot,
      input.requestedPath
    );
    assertRevision(current.revision, input.expectedRevision);
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return { revision: fileRevision(input.content) };
}

export function fileRevision(content: Uint8Array): string {
  return `"kestrel-sha256-${createHash("sha256").update(content).digest("hex")}"`;
}

function assertRevision(actual: string, expected: string) {
  if (actual !== expected) {
    throw new WorkspaceRequestError(
      409,
      "WORKSPACE_FILE_REVISION_CONFLICT"
    );
  }
}

function isNodeError(error: unknown, code: string) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
