import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import type {
  CodeExecutionArtifact,
  CodeExecutionFile,
  CodeExecutionLanguage,
  SandboxExecutionInput,
  SandboxExecutionOutput,
  SandboxExecutor,
} from "./contracts.js";

const LANGUAGE_IMAGE: Record<CodeExecutionLanguage, string> = {
  javascript: "node:20-alpine",
  python: "python:3.12-alpine",
  bash: "bash:5.2",
};

const LANGUAGE_MAIN_FILE: Record<CodeExecutionLanguage, string> = {
  javascript: "main.js",
  python: "main.py",
  bash: "main.sh",
};

const IGNORED_ARTIFACT_DIRS = new Set([
  "node_modules",
  "__pycache__",
  ".git",
  ".cache",
]);

export class DockerUnavailableError extends Error {}

export class DockerSandboxExecutor implements SandboxExecutor {
  async execute(input: SandboxExecutionInput): Promise<SandboxExecutionOutput> {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-code-"));
    const workspaceDir = path.join(rootDir, "workspace");
    const mainFile = LANGUAGE_MAIN_FILE[input.request.language];

    await mkdir(workspaceDir, { recursive: true });

    const declaredFiles = normalizeFiles(input.request.files);
    await writeDeclaredFiles(workspaceDir, declaredFiles);
    await writeFile(path.join(workspaceDir, mainFile), input.request.code, "utf8");

    try {
      const startedAt = Date.now();
      const command = buildDockerCommand(input, workspaceDir, mainFile);
      const run = await runDockerCommand(command, input.policy.timeoutMs, input.policy.maxOutputBytes);
      const durationMs = Date.now() - startedAt;

      const artifacts = await collectArtifacts({
        workspaceDir,
        baselinePaths: new Set([...declaredFiles.map((file) => file.path), mainFile]),
        maxArtifacts: input.policy.maxArtifacts,
        maxArtifactBytes: input.policy.maxArtifactBytes,
      });

      if (run.timedOut) {
        return {
          status: "timeout",
          exitCode: null,
          stdout: run.stdout,
          stderr: run.stderr,
          durationMs,
          artifacts,
        };
      }

      return {
        status: run.exitCode === 0 ? "ok" : "error",
        exitCode: run.exitCode,
        stdout: run.stdout,
        stderr: run.stderr,
        durationMs,
        artifacts,
      };
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  }
}

function normalizeFiles(value: CodeExecutionFile[] | undefined): CodeExecutionFile[] {
  if (Array.isArray(value) === false) {
    return [];
  }

  const normalized: CodeExecutionFile[] = [];
  for (const file of value) {
    if (typeof file.path !== "string" || typeof file.content !== "string") {
      continue;
    }
    const safePath = sanitizeRelativePath(file.path);
    if (safePath === undefined) {
      continue;
    }
    normalized.push({
      path: safePath,
      content: file.content,
    });
  }

  return normalized.slice(0, 100);
}

async function writeDeclaredFiles(workspaceDir: string, files: CodeExecutionFile[]): Promise<void> {
  for (const file of files) {
    const destination = path.join(workspaceDir, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content, "utf8");
  }
}

function sanitizeRelativePath(value: string): string | undefined {
  const normalized = value.replace(/\\/gu, "/").trim();
  if (normalized.length === 0) {
    return ;
  }

  const candidate = path.posix.normalize(normalized);
  if (candidate.startsWith("/") || candidate.startsWith("../") || candidate.includes("/../")) {
    return ;
  }

  return candidate;
}

function buildDockerCommand(input: SandboxExecutionInput, workspaceDir: string, mainFile: string): string[] {
  const image = LANGUAGE_IMAGE[input.request.language];
  const commandScript = buildCommandScript(input.request.language, mainFile, input.request.dependencies ?? [], input.request.args ?? []);

  const args = [
    "run",
    "--rm",
    "--init",
    "--memory",
    `${input.policy.memoryMb}m`,
    "--cpu-shares",
    String(input.policy.cpuShares),
    "--network",
    input.policy.network === "off" ? "none" : "bridge",
    "--volume",
    `${workspaceDir}:/workspace`,
    "--workdir",
    "/workspace",
    image,
    "sh",
    "-lc",
    commandScript,
  ];

  return args;
}

function buildCommandScript(
  language: CodeExecutionLanguage,
  mainFile: string,
  dependencies: string[],
  args: string[],
): string {
  const dependencyCommand = buildDependencyInstallCommand(language, dependencies);
  const argString = args.map((item) => shellQuote(item)).join(" ");

  if (language === "javascript") {
    return joinShellCommands([
      "set -euo pipefail",
      dependencyCommand,
      `node /workspace/${mainFile}${argString.length > 0 ? ` ${argString}` : ""}`,
    ]);
  }

  if (language === "python") {
    return joinShellCommands([
      "set -euo pipefail",
      dependencyCommand,
      `python /workspace/${mainFile}${argString.length > 0 ? ` ${argString}` : ""}`,
    ]);
  }

  return joinShellCommands([
    "set -euo pipefail",
    `bash /workspace/${mainFile}${argString.length > 0 ? ` ${argString}` : ""}`,
  ]);
}

function buildDependencyInstallCommand(
  language: CodeExecutionLanguage,
  dependencies: string[],
): string | undefined {
  if (dependencies.length === 0) {
    return ;
  }

  const packages = dependencies.map((item) => shellQuote(item)).join(" ");

  if (language === "javascript") {
    return `npm install --no-audit --no-fund --silent ${packages}`;
  }

  if (language === "python") {
    return `pip install --disable-pip-version-check --no-input --quiet ${packages}`;
  }

  return ;
}

function joinShellCommands(lines: Array<string | undefined>): string {
  return lines.filter((line): line is string => typeof line === "string" && line.trim().length > 0).join("; ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

async function runDockerCommand(
  args: string[],
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<{
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = appendBounded(stdout, String(chunk), maxOutputBytes);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendBounded(stderr, String(chunk), maxOutputBytes);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new DockerUnavailableError("docker command is not available"));
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

function appendBounded(value: string, append: string, maxBytes: number): string {
  const combined = value + append;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) {
    return combined;
  }

  const marker = "\n...[truncated]";
  const allowedBytes = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  const truncated = truncateUtf8Bytes(combined, allowedBytes);
  return `${truncated}${marker}`;
}

function truncateUtf8Bytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }

  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) {
    return value;
  }

  return bytes.subarray(0, maxBytes).toString("utf8");
}

async function collectArtifacts(input: {
  workspaceDir: string;
  baselinePaths: Set<string>;
  maxArtifacts: number;
  maxArtifactBytes: number;
}): Promise<CodeExecutionArtifact[]> {
  const discovered = await walkFiles(input.workspaceDir, "");

  const artifacts: CodeExecutionArtifact[] = [];
  for (const relativePath of discovered) {
    if (input.baselinePaths.has(relativePath)) {
      continue;
    }

    const absolutePath = path.join(input.workspaceDir, relativePath);
    const details = await stat(absolutePath);
    if (details.isFile() === false) {
      continue;
    }
    if (details.size > input.maxArtifactBytes) {
      continue;
    }

    const contents = await readFile(absolutePath);
    const sha256 = createHash("sha256").update(contents).digest("hex");
    const previewText = contents.toString("utf8", 0, Math.min(contents.byteLength, 2000));

    artifacts.push({
      path: relativePath,
      sizeBytes: details.size,
      sha256,
      preview: {
        text: previewText,
        truncated: contents.byteLength > 2000,
      },
    });

    if (artifacts.length >= input.maxArtifacts) {
      break;
    }
  }

  return artifacts;
}

async function walkFiles(baseDir: string, relativeDir: string): Promise<string[]> {
  const absoluteDir = path.join(baseDir, relativeDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === "." || entry.name === "..") {
      continue;
    }

    const relativePath = relativeDir.length > 0 ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (IGNORED_ARTIFACT_DIRS.has(entry.name)) {
        continue;
      }
      files.push(...await walkFiles(baseDir, relativePath));
      continue;
    }

    if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files.sort();
}
