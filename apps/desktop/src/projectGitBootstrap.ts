import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { createRuntimeFailure } from "../../../src/runtime/RuntimeFailure.js";
import type { DesktopProjectRegistration } from "./contracts.js";

const execFileAsync = promisify(execFile);
const KESTREL_PROJECT_METADATA_ENTRY = ".kestrel";
const MACOS_DIRECTORY_METADATA_ENTRY = ".DS_Store";

export type DesktopProjectGitBootstrapStatus =
  | "existing_git"
  | "initialized"
  | "initialized_head"
  | "skipped_non_empty";

export interface DesktopProjectGitBootstrapResult {
  projectPath: string;
  status: DesktopProjectGitBootstrapStatus;
}

export async function prepareDesktopProjectRegistrations(
  projects: readonly DesktopProjectRegistration[],
): Promise<DesktopProjectRegistration[]> {
  const prepared: DesktopProjectRegistration[] = [];
  for (const project of projects) {
    try {
      await ensureDesktopProjectGitBootstrap(project.path);
      prepared.push(project);
    } catch (error) {
      if (readErrorCode(error) === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  return prepared;
}

export async function ensureDesktopProjectGitBootstrap(
  projectPath: string,
): Promise<DesktopProjectGitBootstrapResult> {
  const directory = await stat(projectPath);
  if (directory.isDirectory() === false) {
    throw createRuntimeFailure(
      "DESKTOP_PROJECT_PATH_INVALID",
      `Desktop project path must be a directory: ${projectPath}`,
      { projectPath },
    );
  }

  const existingGit = await hasGitRepository(projectPath);
  if (existingGit && await hasGitHead(projectPath)) {
    return { projectPath, status: "existing_git" };
  }

  const safeToBootstrap = await isNewProjectDirectory(projectPath, {
    ignoreGitDirectory: existingGit,
  });
  if (safeToBootstrap === false) {
    return { projectPath, status: "skipped_non_empty" };
  }

  if (existingGit === false) {
    await git(projectPath, ["init"]);
    await createEmptyInitialCommit(projectPath);
    return { projectPath, status: "initialized" };
  }

  await createEmptyInitialCommit(projectPath);
  return { projectPath, status: "initialized_head" };
}

async function isNewProjectDirectory(
  projectPath: string,
  options: { ignoreGitDirectory: boolean },
): Promise<boolean> {
  const entries = await readdir(projectPath);
  return entries.every((entry) =>
    entry === KESTREL_PROJECT_METADATA_ENTRY ||
    entry === MACOS_DIRECTORY_METADATA_ENTRY ||
    (options.ignoreGitDirectory && entry === ".git")
  );
}

async function hasGitRepository(projectPath: string): Promise<boolean> {
  try {
    await git(projectPath, ["rev-parse", "--show-toplevel"]);
    return true;
  } catch {
    return false;
  }
}

async function hasGitHead(projectPath: string): Promise<boolean> {
  try {
    await git(projectPath, ["rev-parse", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

async function createEmptyInitialCommit(projectPath: string): Promise<void> {
  await git(projectPath, [
    "-c",
    "user.name=Kestrel Desktop",
    "-c",
    "user.email=kestrel-desktop@local",
    "commit",
    "--allow-empty",
    "-m",
    "Initialize Kestrel project",
  ]);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

function readErrorCode(error: unknown): string | undefined {
  return typeof (error as { code?: unknown })?.code === "string"
    ? String((error as { code: string }).code)
    : undefined;
}
