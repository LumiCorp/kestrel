import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";

import type { DesktopPathTargetInput } from "./contracts.js";
import { createDesktopError } from "./errors.js";

export interface ResolvedDesktopPathTarget {
  rootPath: string;
  targetPath: string;
}

export interface VerifiedDesktopPathTarget extends ResolvedDesktopPathTarget {
  realRootPath: string;
  realTargetPath: string;
}

export function parseDesktopPathTargetInput(
  input: unknown,
  options: {
    methodName: string;
    invalidInputCode: string;
    invalidRootCode?: string | undefined;
    invalidTargetCode: string;
  },
): DesktopPathTargetInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw createDesktopError({
      code: options.invalidInputCode,
      message: `${options.methodName} requires a path request.`,
    });
  }
  const record = input as Record<string, unknown>;
  if (typeof record.rootPath !== "string" || record.rootPath.trim().length === 0) {
    throw createDesktopError({
      code: options.invalidRootCode ?? "desktop.invalid_root_path",
      message: `${options.methodName} requires a project root path.`,
    });
  }
  if (typeof record.targetPath !== "string" || record.targetPath.trim().length === 0) {
    throw createDesktopError({
      code: options.invalidTargetCode,
      message: `${options.methodName} requires a file path.`,
    });
  }
  return {
    rootPath: record.rootPath,
    targetPath: record.targetPath,
  };
}

export function resolveDesktopPathTarget(
  input: DesktopPathTargetInput,
  field = "targetPath",
): ResolvedDesktopPathTarget {
  const rootPath = path.resolve(input.rootPath);
  const targetPath = path.resolve(input.targetPath);
  assertWithinRoot(rootPath, targetPath, field);
  return {
    rootPath,
    targetPath,
  };
}

export function resolveRegisteredDesktopProjectRoot(
  rootPath: string,
  registeredRootPaths: readonly string[],
): string {
  const resolved = resolveDesktopProjectRootCandidate(rootPath, registeredRootPaths);
  if (resolved !== undefined) {
    return resolved;
  }

  throw createDesktopError({
    code: "desktop.unregistered_project_root",
    message: "rootPath must match a registered desktop project root.",
  });
}

export function resolveDesktopProjectRootForWatcherCleanup(
  rootPath: string,
  registeredRootPaths: readonly string[],
  watchedRootPaths: readonly string[],
): string {
  const registeredRoot = resolveDesktopProjectRootCandidate(rootPath, registeredRootPaths);
  if (registeredRoot !== undefined) {
    return registeredRoot;
  }
  const watchedRoot = resolveDesktopProjectRootCandidate(rootPath, watchedRootPaths);
  if (watchedRoot !== undefined) {
    return watchedRoot;
  }
  const resolvedRoot = path.resolve(rootPath);
  if (existsSync(resolvedRoot) === false) {
    return resolvedRoot;
  }

  throw createDesktopError({
    code: "desktop.unregistered_project_root",
    message: "rootPath must match a registered desktop project root.",
  });
}

function resolveDesktopProjectRootCandidate(
  rootPath: string,
  candidateRootPaths: readonly string[],
): string | undefined {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedCandidates = candidateRootPaths.map((candidate) => path.resolve(candidate));
  const directMatch = resolvedCandidates.find((candidate) => candidate === resolvedRoot);
  if (directMatch !== undefined) {
    return directMatch;
  }

  let realResolvedRoot: string | undefined;
  try {
    realResolvedRoot = realpathSync(resolvedRoot);
  } catch {
    realResolvedRoot = undefined;
  }
  if (realResolvedRoot !== undefined) {
    for (const candidate of resolvedCandidates) {
      try {
        if (realpathSync(candidate) === realResolvedRoot) {
          return candidate;
        }
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

export async function resolveVerifiedDesktopPathTarget(
  input: DesktopPathTargetInput,
  registeredRootPaths: readonly string[],
  field = "targetPath",
): Promise<VerifiedDesktopPathTarget> {
  const resolved = resolveDesktopPathTarget(input, field);
  const rootPath = resolveRegisteredDesktopProjectRoot(
    resolved.rootPath,
    registeredRootPaths,
  );
  assertWithinRoot(rootPath, resolved.targetPath, field);
  const [realRootPath, realTargetPath] = await Promise.all([
    realpath(rootPath),
    realpath(resolved.targetPath),
  ]);
  assertWithinRoot(realRootPath, realTargetPath, field);
  return {
    rootPath,
    targetPath: resolved.targetPath,
    realRootPath,
    realTargetPath,
  };
}

export function assertWithinRoot(rootPath: string, candidatePath: string, field: string): void {
  const normalizedRoot = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`;
  if (candidatePath === rootPath || candidatePath.startsWith(normalizedRoot)) {
    return;
  }
  throw createDesktopError({
    code: "desktop.path_outside_project",
    message: `${field} must stay within the selected project root.`,
  });
}
