import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { SharedToolModule } from "../contracts.js";
import { createToolInputError, parseObjectInput, readString } from "../helpers.js";
import { readTextArtifact } from "../runtime/artifactStore.js";
import {
  createFileSystemCapability,
  createFileSystemPresentation,
  pathExists,
  resolveExistingFileSystemPath,
  resolveTargetFileSystemPath,
} from "./shared.js";
import { assertExpectedRevision, readRevision } from "./textRevision.js";

const execFileAsync = promisify(execFile);
const MAX_PATCH_BYTES = 4 * 1024 * 1024;

interface ExpectedRevision {
  path: string;
  revision: string;
}

export const fsApplyPatchTool: SharedToolModule = {
  definition: {
    name: "fs.apply_patch",
    description: "Atomically apply a unified diff against required current file revisions. Supply literal patch text or an immutable patchRef returned by exec_command capture mode.",
    inputSchema: {
      type: "object",
      properties: {
        patch: { type: "string", minLength: 1 },
        patchRef: { type: "string", minLength: 1 },
        expectedRevisions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: { type: "string", minLength: 1 },
              revision: { type: "string", minLength: 1 },
            },
            required: ["path", "revision"],
          },
        },
      },
      additionalProperties: false,
    },
    capability: createFileSystemCapability("fs.patch", "sandboxed_only"),
    presentation: createFileSystemPresentation({
      displayName: "Apply Patch",
      aliases: ["apply patch", "unified diff", "patch files"],
      keywords: ["apply", "patch", "diff", "revision", "atomic"],
    }),
  },
  createHandler(context) {
    return async (input: unknown) => {
      const body = parseObjectInput("fs.apply_patch", input);
      const literalPatch = readString(body, "patch");
      const patchRef = readString(body, "patchRef");
      if ((literalPatch === undefined) === (patchRef === undefined)) {
        throw createToolInputError("fs.apply_patch", "Provide exactly one of input.patch or input.patchRef.", {
          fields: ["patch", "patchRef"],
        });
      }
      const patch = literalPatch ?? readPatchArtifact(patchRef!);
      if (Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES) {
        throw createToolInputError("fs.apply_patch", "Patch exceeds the maximum supported size.", { maxBytes: MAX_PATCH_BYTES });
      }
      const changedPaths = parsePatchPaths(patch);
      if (changedPaths.length === 0) {
        throw createToolInputError("fs.apply_patch", "Patch contains no file changes.", { field: "patch" });
      }
      const expected = parseExpectedRevisions(body.expectedRevisions);
      const workspaceRoot = await realpath(path.resolve(context.fileSystem?.workspaceRoot ?? process.cwd()));
      const repoRoot = await realpath((await execFileAsync("git", ["-C", workspaceRoot, "rev-parse", "--show-toplevel"])).stdout.trim());
      const relativeWorkspace = path.relative(repoRoot, workspaceRoot);
      if (relativeWorkspace.startsWith("..") || path.isAbsolute(relativeWorkspace)) {
        throw createToolInputError("fs.apply_patch", "Active workspace is not contained by its Git repository.", { workspaceRoot, repoRoot });
      }

      const beforeRevisions: Record<string, string> = {};
      for (const patchPath of changedPaths) {
        const workspacePath = patchPath;
        const target = await resolveTargetFileSystemPath(workspacePath, context.fileSystem);
        if (await pathExists(target.absolutePath)) {
          const resolved = await resolveExistingFileSystemPath(workspacePath, context.fileSystem);
          const actualRevision = await readRevision(resolved.absolutePath);
          const requiredRevision = expected.get(resolved.displayPath) ?? expected.get(workspacePath) ?? expected.get(patchPath);
          if (requiredRevision === undefined) {
            throw createToolInputError("fs.apply_patch", `Missing expected revision for existing file ${resolved.displayPath}.`, {
              path: resolved.displayPath,
              actualRevision,
              recoverable: true,
              nextSuggestedAction: `Read ${resolved.displayPath} and include its revision in expectedRevisions.`,
            });
          }
          assertExpectedRevision({
            toolName: "fs.apply_patch",
            path: resolved.displayPath,
            expectedRevision: requiredRevision,
            actualRevision,
          });
          beforeRevisions[resolved.displayPath] = actualRevision;
        }
      }

      const tempRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-apply-patch-"));
      const patchPath = path.join(tempRoot, "change.patch");
      const directoryArg = relativeWorkspace.length > 0 ? [`--directory=${relativeWorkspace}`] : [];
      try {
        await writeFile(patchPath, patch, "utf8");
        await execFileAsync("git", ["-C", repoRoot, "apply", "--check", "--whitespace=nowarn", ...directoryArg, patchPath], {
          maxBuffer: MAX_PATCH_BYTES * 2,
        });
        await execFileAsync("git", ["-C", repoRoot, "apply", "--whitespace=nowarn", ...directoryArg, patchPath], {
          maxBuffer: MAX_PATCH_BYTES * 2,
        });
      } catch (error) {
        const stderr = (error as { stderr?: string }).stderr?.trim();
        throw createToolInputError("fs.apply_patch", stderr ?? "Patch did not apply cleanly; no files were changed.", {
          paths: changedPaths,
          recoverable: true,
        });
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }

      const afterRevisions: Record<string, string> = {};
      for (const patchPath of changedPaths) {
        const workspacePath = patchPath;
        const target = await resolveTargetFileSystemPath(workspacePath, context.fileSystem);
        if (await pathExists(target.absolutePath)) {
          const resolved = await resolveExistingFileSystemPath(workspacePath, context.fileSystem);
          afterRevisions[resolved.displayPath] = await readRevision(resolved.absolutePath);
        }
      }
      return {
        changed: true,
        changedFiles: changedPaths,
        beforeRevisions,
        afterRevisions,
        patch,
        ...(patchRef !== undefined ? { patchRef } : {}),
      };
    };
  },
};

function readPatchArtifact(ref: string): string {
  const artifact = readTextArtifact(ref);
  if (artifact === undefined) {
    throw createToolInputError("fs.apply_patch", `Patch artifact is unavailable: ${ref}`, { ref, recoverable: false });
  }
  if (artifact.contentType.startsWith("text/x-diff") === false) {
    throw createToolInputError("fs.apply_patch", `Artifact is not a patch: ${ref}`, { ref, contentType: artifact.contentType });
  }
  return artifact.content;
}

function parseExpectedRevisions(value: unknown): Map<string, string> {
  const result = new Map<string, string>();
  if (value === undefined) return result;
  if (Array.isArray(value) === false) {
    throw createToolInputError("fs.apply_patch", "expectedRevisions must be an array.", { field: "expectedRevisions" });
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw createToolInputError("fs.apply_patch", `expectedRevisions[${index}] must be an object.`, { field: `expectedRevisions[${index}]` });
    }
    const record = item as Record<string, unknown>;
    if (typeof record.path !== "string" || typeof record.revision !== "string") {
      throw createToolInputError("fs.apply_patch", `expectedRevisions[${index}] requires path and revision.`, { field: `expectedRevisions[${index}]` });
    }
    result.set(record.path, record.revision);
  }
  return result;
}

function parsePatchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split(/\r?\n/u)) {
    if (line.startsWith("+++ ") === false && line.startsWith("--- ") === false) continue;
    const raw = line.slice(4).split("\t", 1)[0]?.trim();
    if (raw === undefined || raw === "/dev/null") continue;
    if (raw.startsWith("\"") || raw.includes("\\")) {
      throw createToolInputError("fs.apply_patch", "Quoted or escaped patch paths are not supported.", { path: raw });
    }
    const normalized = raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw;
    if (normalized.length === 0 || path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
      throw createToolInputError("fs.apply_patch", `Unsafe patch path: ${raw}`, { path: raw });
    }
    paths.add(normalized);
  }
  return [...paths].sort();
}
