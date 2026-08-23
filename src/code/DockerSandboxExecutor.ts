import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  CodeExecutionArtifact,
  CodeExecutionFile,
  CodeExecutionLanguage,
  SandboxExecutionInput,
  SandboxExecutionOutput,
  SandboxExecutor,
} from "./contracts.js";

const SANDBOX_UID = 65_532;
const SANDBOX_GID = 65_532;
const DOCKER_LIFECYCLE_TIMEOUT_MS = 10_000;
const DOCKER_LIFECYCLE_OUTPUT_BYTES = 16_000;
const DOCKER_OWNERSHIP_INSPECTION_LIMIT = 5;
const DOCKER_OWNERSHIP_RETRY_DELAY_MS = 100;
export const DOCKER_CAPABILITY_ENDPOINT = "http://127.0.0.1:43127/v1/capability";
const DOCKER_CAPABILITY_PORT = 43_127;
const DOCKER_INVOCATION_LABEL = "com.kestrel.code.invocation";

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
  ".kestrel-python",
  "__pycache__",
  ".git",
  ".cache",
]);

export class DockerUnavailableError extends Error {}
export class DockerSandboxCancellationError extends Error {}

export interface DockerSandboxExecutorOptions {
  containerNameFactory?: (() => string) | undefined;
  capabilityConfinementProbe?: ((signal?: AbortSignal | undefined) => Promise<boolean>) | undefined;
  createCommandRunner?: ((args: string[], signal?: AbortSignal | undefined) => Promise<DockerProcessResult>) | undefined;
  ownershipInspectRunner?: ((containerName: string) => Promise<DockerProcessResult>) | undefined;
  beforeAmbiguousCreateCleanup?: ((containerName: string, containerId: string) => Promise<void>) | undefined;
}

export interface DockerProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  stdout: string;
  stderr: string;
}

export class DockerSandboxExecutor implements SandboxExecutor {
  private readonly containerNameFactory: () => string;
  private readonly capabilityConfinementProbe: (signal?: AbortSignal | undefined) => Promise<boolean>;
  private readonly createCommandRunner: (args: string[], signal?: AbortSignal | undefined) => Promise<DockerProcessResult>;
  private readonly ownershipInspectRunner: (containerName: string) => Promise<DockerProcessResult>;
  private readonly beforeAmbiguousCreateCleanup: (containerName: string, containerId: string) => Promise<void>;

  constructor(options: DockerSandboxExecutorOptions = {}) {
    this.containerNameFactory =
      options.containerNameFactory ?? (() => `kestrel-code-${randomUUID()}`);
    this.capabilityConfinementProbe =
      options.capabilityConfinementProbe ?? probeDockerCapabilityConfinement;
    this.createCommandRunner = options.createCommandRunner ?? ((args, signal) =>
      runDockerProcess(
        args,
        DOCKER_LIFECYCLE_TIMEOUT_MS,
        DOCKER_LIFECYCLE_OUTPUT_BYTES,
        signal,
      ));
    this.ownershipInspectRunner = options.ownershipInspectRunner ?? inspectContainerOwnership;
    this.beforeAmbiguousCreateCleanup = options.beforeAmbiguousCreateCleanup ?? (async () => {});
  }

  async execute(input: SandboxExecutionInput): Promise<SandboxExecutionOutput> {
    throwIfCancelled(input.signal);
    await assertSupportedNetworkMode(input, this.capabilityConfinementProbe);
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-code-"));
    const stagingDir = path.join(rootDir, "staging");
    const snapshotDir = path.join(rootDir, "snapshot");
    const mainFile = LANGUAGE_MAIN_FILE[input.request.language];
    const containerName = this.containerNameFactory();
    const brokerContainerName = `${containerName}-broker`;
    const invocationMarker = randomUUID();
    const declaredFiles = normalizeFiles(input.request.files);

    await mkdir(stagingDir, { recursive: true, mode: 0o777 });
    await chmod(stagingDir, 0o777);
    await writeDeclaredFiles(stagingDir, declaredFiles);
    await writeSandboxFile(
      path.join(stagingDir, mainFile),
      input.request.code,
    );

    const startedAt = Date.now();
    let run: DockerProcessResult | undefined;
    let snapshotError: string | undefined;
    let ownedWorkloadContainerId: string | undefined;
    let ownedBrokerContainerId: string | undefined;
    const adapterPumpController = new AbortController();
    let adapterPump: Promise<void> | undefined;
    let teardownReason: "completed" | "failed" | "cancelled" | "timeout" = "failed";

    try {
      if (input.capability !== undefined) {
        await startCapabilityBroker(input, brokerContainerName, invocationMarker, this.createCommandRunner, this.ownershipInspectRunner, this.beforeAmbiguousCreateCleanup, (containerId) => {
          ownedBrokerContainerId = containerId;
        });
        if (input.capability.adapter !== undefined) {
          adapterPump = runCapabilityAdapterPump(
            input.capability,
            brokerContainerName,
            adapterPumpController.signal,
          );
        }
      }
      ownedWorkloadContainerId = await createOwnedContainer(
        withInvocationMarker(
          buildDockerCreateCommand(input, containerName, brokerContainerName),
          invocationMarker,
        ),
        containerName,
        invocationMarker,
        "create sandbox container",
        input.signal,
        this.createCommandRunner,
        this.ownershipInspectRunner,
        this.beforeAmbiguousCreateCleanup,
      );
      await runRequiredDockerCommand(
        ["start", containerName],
        "start sandbox container",
        input.signal,
      );
      await copyStagedInputs({
        stagingDir,
        relativePaths: [...new Set([
          ...declaredFiles.map((file) => file.path),
          mainFile,
        ])],
        containerName,
        signal: input.signal,
      });

      throwIfCancelled(input.signal);
      run = await runDockerProcess(
        buildDockerExecCommand(input, mainFile, containerName),
        input.policy.timeoutMs,
        input.policy.maxOutputBytes,
        input.signal,
      );
      if (run.cancelled) {
        throw new DockerSandboxCancellationError(
          "Docker sandbox execution was cancelled",
        );
      }
      adapterPumpController.abort();
      await adapterPump;

      throwIfCancelled(input.signal);
      try {
        await runRequiredDockerCommand(
          ["pause", containerName],
          "pause sandbox container",
          input.signal,
        );
        await snapshotWorkspace({
          containerName,
          snapshotDir,
          baselinePaths: new Set([
            ...declaredFiles.map((file) => file.path),
            mainFile,
          ]),
          maxArtifacts: input.policy.maxArtifacts,
          maxArtifactBytes: input.policy.maxArtifactBytes,
          signal: input.signal,
        });
      } catch (error) {
        if (input.signal?.aborted === true) {
          throw error;
        }
        snapshotError = error instanceof Error ? error.message : String(error);
        if (run.timedOut === false) {
          throw error;
        }
      }

      let artifacts = snapshotError === undefined
        ? await collectArtifacts({
            workspaceDir: snapshotDir,
            baselinePaths: new Set([
              ...declaredFiles.map((file) => file.path),
              mainFile,
            ]),
            maxArtifacts: input.policy.maxArtifacts,
            maxArtifactBytes: input.policy.maxArtifactBytes,
          })
        : [];
      const durationMs = Date.now() - startedAt;
      let stderr = snapshotError === undefined
        ? run.stderr
        : appendBounded(
            run.stderr,
            `\nSandbox artifact snapshot failed after timeout: ${snapshotError}`,
            input.policy.maxOutputBytes,
          );

      let stdout = run.stdout;
      if (input.capability !== undefined) {
        stdout = redactSensitiveValue(stdout, input.capability.lease);
        stderr = redactSensitiveValue(stderr, input.capability.lease);
        artifacts = artifacts.map((artifact) => ({
          ...artifact,
          ...(artifact.preview === undefined ? {} : {
            preview: {
              ...artifact.preview,
              text: redactSensitiveValue(artifact.preview.text, input.capability!.lease),
            },
          }),
        }));
      }

      if (run.timedOut) {
        teardownReason = "timeout";
        return {
          status: "timeout",
          exitCode: null,
          stdout,
          stderr,
          durationMs,
          artifacts,
        };
      }

      teardownReason = run.exitCode === 0 ? "completed" : "failed";
      return {
        status: run.exitCode === 0 ? "ok" : "error",
        exitCode: run.exitCode,
        stdout,
        stderr,
        durationMs,
        artifacts,
      };
    } finally {
      adapterPumpController.abort();
      await adapterPump?.catch(() => {});
      if (input.signal?.aborted === true) teardownReason = "cancelled";
      let lifecycleError: unknown;
      try {
        await input.capability?.lifecycle?.beforeContainerTeardown(teardownReason);
      } catch (error) {
        lifecycleError = error;
      }
      if (ownedWorkloadContainerId !== undefined) {
        await removeContainer(ownedWorkloadContainerId);
      }
      if (ownedBrokerContainerId !== undefined) {
        await removeContainer(ownedBrokerContainerId);
      }
      await rm(rootDir, { recursive: true, force: true });
      if (lifecycleError !== undefined) throw lifecycleError;
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
    normalized.push({ path: safePath, content: file.content });
  }

  return normalized.slice(0, 100);
}

async function writeDeclaredFiles(
  workspaceDir: string,
  files: CodeExecutionFile[],
): Promise<void> {
  for (const file of files) {
    const destination = path.join(workspaceDir, file.path);
    await mkdirWritableDirectory(path.dirname(destination), workspaceDir);
    await writeSandboxFile(destination, file.content);
  }
}

async function mkdirWritableDirectory(
  directory: string,
  workspaceDir: string,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o777 });
  let current = directory;
  while (current.startsWith(workspaceDir) && current !== workspaceDir) {
    await chmod(current, 0o777);
    current = path.dirname(current);
  }
}

async function writeSandboxFile(destination: string, content: string): Promise<void> {
  await writeFile(destination, content, { encoding: "utf8", mode: 0o666 });
  await chmod(destination, 0o666);
}

function sanitizeRelativePath(value: string): string | undefined {
  const normalized = value.replace(/\\/gu, "/").trim();
  if (normalized.length === 0) {
    return;
  }

  const candidate = path.posix.normalize(normalized);
  if (
    candidate === "." ||
    candidate.startsWith("/") ||
    candidate.startsWith("../") ||
    candidate.includes("/../")
  ) {
    return;
  }

  return candidate;
}

export function buildDockerCreateCommand(
  input: SandboxExecutionInput,
  containerName: string,
  brokerContainerName = `${containerName}-broker`,
): string[] {
  const image = LANGUAGE_IMAGE[input.request.language];
  return [
    "create",
    "--init",
    "--name",
    containerName,
    "--user",
    `${SANDBOX_UID}:${SANDBOX_GID}`,
    "--read-only",
    "--memory",
    `${input.policy.memoryMb}m`,
    "--cpu-shares",
    String(input.policy.cpuShares),
    "--pids-limit",
    String(input.policy.pidsLimit),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--network",
    input.capability === undefined ? "none" : `container:${brokerContainerName}`,
    "--tmpfs",
    buildTmpfsSpec(
      "/workspace",
      input.policy.workspaceSizeMb,
      input.policy.workspaceInodes,
    ),
    "--tmpfs",
    buildTmpfsSpec("/tmp", input.policy.tmpSizeMb, input.policy.tmpInodes),
    "--env",
    "HOME=/tmp",
    "--env",
    "PYTHONPATH=/workspace/.kestrel-python",
    "--env",
    "NPM_CONFIG_CACHE=/tmp/.npm",
    "--workdir",
    "/workspace",
    image,
    "sh",
    "-lc",
    "while :; do sleep 3600; done",
  ];
}

async function assertSupportedNetworkMode(
  input: SandboxExecutionInput,
  confinementProbe: (signal?: AbortSignal | undefined) => Promise<boolean>,
): Promise<void> {
  if (input.capability === undefined) {
    if (input.policy.network === "on") {
      throw new DockerUnavailableError(
        "Unrestricted Docker networking is disabled; a confined capability grant is required",
      );
    }
    return;
  }
  if (input.capability.transport !== "docker-shared-loopback-v1") {
    throw new DockerUnavailableError("Docker capability transport is unsupported");
  }
  if (await confinementProbe(input.signal) === false) {
    throw new DockerUnavailableError(
      "Active Docker backend cannot enforce the shared-loopback capability transport",
    );
  }
}

async function probeDockerCapabilityConfinement(
  signal?: AbortSignal | undefined,
): Promise<boolean> {
  const info = await runDockerProcess(
    ["info", "--format", "{{.OSType}}"],
    DOCKER_LIFECYCLE_TIMEOUT_MS,
    DOCKER_LIFECYCLE_OUTPUT_BYTES,
    signal,
  );
  if (info.cancelled) {
    throw new DockerSandboxCancellationError("Docker sandbox execution was cancelled");
  }
  return info.timedOut === false && info.exitCode === 0 && info.stdout.trim() === "linux";
}

const CAPABILITY_BROKER_SCRIPT = String.raw`
const fs = require("node:fs");
const http = require("node:http");
const configPath = "/run/kestrel/config";
const requestPath = "/run/kestrel/request";
const requestTempPath = "/run/kestrel/request.tmp";
const responsePath = "/run/kestrel/response";
let acceptedRequests = 0;
function load() {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    fs.unlinkSync(configPath);
    if (typeof config.lease !== "string" || config.lease.length < 16) process.exit(64);
    http.createServer((request, response) => {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(204); response.end(); return;
      }
      if (request.method !== "POST" || request.url !== "/v1/capability") {
        response.writeHead(404); response.end(JSON.stringify({ error: "unknown_endpoint" })); return;
      }
      if (typeof config.expiresAt === "string" && Date.now() >= Date.parse(config.expiresAt)) {
        response.writeHead(410); response.end(JSON.stringify({ error: "capability_expired" })); return;
      }
      if (acceptedRequests >= (config.maxRequests ?? 1)) {
        response.writeHead(429); response.end(JSON.stringify({ error: "request_ceiling_reached" })); return;
      }
      let body = "";
      let rejected = false;
      request.setEncoding("utf8");
      request.on("data", chunk => {
        if (rejected) return;
        body += chunk;
        if (body.length > 4096) {
          rejected = true;
          response.writeHead(413); response.end(JSON.stringify({ error: "request_too_large" }));
        }
      });
      request.on("end", () => {
        if (rejected) return;
        let value;
        try { value = JSON.parse(body); } catch { response.writeHead(400); response.end(JSON.stringify({ error: "invalid_request" })); return; }
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          response.writeHead(400); response.end(JSON.stringify({ error: "invalid_request" })); return;
        }
        const expectedKeys = config.expectedInput === undefined ? 2 : 3;
        if (value.operation !== config.operation || value.destination !== config.destination || Object.keys(value).length !== expectedKeys || (config.expectedInput !== undefined && JSON.stringify(value.input) !== JSON.stringify(config.expectedInput))) {
          response.writeHead(403); response.end(JSON.stringify({ error: "capability_denied" })); return;
        }
        acceptedRequests += 1;
        if (config.adapter === true) {
          fs.writeFileSync(requestTempPath, JSON.stringify(value), { mode: 0o600 });
          fs.renameSync(requestTempPath, requestPath);
          const waitForResponse = () => {
            try {
              const mediated = JSON.parse(fs.readFileSync(responsePath, "utf8"));
              fs.unlinkSync(responsePath);
              fs.unlinkSync(requestPath);
              if (mediated.ok !== true) { response.writeHead(502); response.end(JSON.stringify({ error: "adapter_failed" })); return; }
              if (typeof config.expiresAt === "string" && Date.now() >= Date.parse(config.expiresAt)) { response.writeHead(410); response.end(JSON.stringify({ error: "capability_expired" })); return; }
              const serialized = JSON.stringify(mediated.response);
              if (Buffer.byteLength(serialized, "utf8") > (config.maxResponseBytes ?? 64000)) { response.writeHead(502); response.end(JSON.stringify({ error: "response_too_large" })); return; }
              response.writeHead(200, { "content-type": "application/json" }); response.end(serialized);
            } catch (error) {
              if (error && error.code === "ENOENT") setTimeout(waitForResponse, 10);
              else { response.writeHead(502); response.end(JSON.stringify({ error: "adapter_failed" })); }
            }
          };
          waitForResponse();
          return;
        }
        const serialized = JSON.stringify(config.response);
        if (Buffer.byteLength(serialized, "utf8") > (config.maxResponseBytes ?? 64000)) {
          response.writeHead(502); response.end(JSON.stringify({ error: "response_too_large" })); return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(serialized);
      });
    }).listen(${DOCKER_CAPABILITY_PORT}, "127.0.0.1");
  } catch (error) {
    if (error && error.code === "ENOENT") setTimeout(load, 10); else process.exit(65);
  }
}
load();`;

async function startCapabilityBroker(
  input: SandboxExecutionInput,
  brokerContainerName: string,
  invocationMarker: string,
  createCommandRunner: (args: string[], signal?: AbortSignal | undefined) => Promise<DockerProcessResult>,
  ownershipInspectRunner: (containerName: string) => Promise<DockerProcessResult>,
  beforeAmbiguousCreateCleanup: (containerName: string, containerId: string) => Promise<void>,
  onCreated: (containerId: string) => void,
): Promise<void> {
  const grant = input.capability;
  if (grant === undefined) return;
  const containerId = await createOwnedContainer(withInvocationMarker([
    "create", "--init", "--name", brokerContainerName,
    "--user", `${SANDBOX_UID}:${SANDBOX_GID}`,
    "--read-only", "--memory", "64m", "--pids-limit", "32",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--network", "none",
    "--tmpfs", `/run/kestrel:rw,nosuid,nodev,noexec,size=1m,uid=${SANDBOX_UID},gid=${SANDBOX_GID},mode=0700`,
    "node:20-alpine", "node", "-e", CAPABILITY_BROKER_SCRIPT,
  ], invocationMarker), brokerContainerName, invocationMarker, "create confined capability broker", input.signal, createCommandRunner, ownershipInspectRunner, beforeAmbiguousCreateCleanup);
  onCreated(containerId);
  await runRequiredDockerCommand(["start", brokerContainerName], "start confined capability broker", input.signal);
  const configuration = Buffer.from(JSON.stringify({
    lease: grant.lease,
    operation: grant.operation,
    destination: grant.destination,
    response: grant.response,
    expiresAt: grant.expiresAt,
    maxRequests: grant.maxRequests,
    maxResponseBytes: grant.maxResponseBytes,
    authority: grant.authority,
    expectedInput: grant.expectedInput,
    adapter: grant.adapter !== undefined,
  }), "utf8");
  const written = await runDockerProcess([
    "exec", "--interactive", "--user", `${SANDBOX_UID}:${SANDBOX_GID}`,
    brokerContainerName, "sh", "-c", "umask 077; cat > /run/kestrel/config.tmp && mv /run/kestrel/config.tmp /run/kestrel/config",
  ], DOCKER_LIFECYCLE_TIMEOUT_MS, DOCKER_LIFECYCLE_OUTPUT_BYTES, input.signal, configuration);
  requireSuccessfulDockerResult(written, "load the capability broker grant");
  const deadline = Date.now() + DOCKER_LIFECYCLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ready = await runDockerProcess([
      "exec", "--user", `${SANDBOX_UID}:${SANDBOX_GID}`, brokerContainerName,
      "node", "-e", `require('http').get('http://127.0.0.1:${DOCKER_CAPABILITY_PORT}/health',r=>process.exit(r.statusCode===204?0:1)).on('error',()=>process.exit(1))`,
    ], 1_000, 1_000, input.signal);
    if (ready.exitCode === 0) return;
  }
  const state = await runDockerProcess(
    ["inspect", "--format", "{{json .State}}", brokerContainerName],
    2_000,
    2_000,
    input.signal,
  );
  throw new Error(
    `Timed out while waiting for the confined capability broker${state.stdout.trim().length > 0 ? `: ${state.stdout.trim()}` : ""}`,
  );
}

async function runCapabilityAdapterPump(
  grant: NonNullable<SandboxExecutionInput["capability"]>,
  brokerContainerName: string,
  signal: AbortSignal,
): Promise<void> {
  if (grant.adapter === undefined || grant.expectedInput === undefined) return;
  while (signal.aborted === false) {
    const request = await runDockerProcess(
      ["exec", "--user", `${SANDBOX_UID}:${SANDBOX_GID}`, brokerContainerName, "sh", "-c", "test -f /run/kestrel/request && cat /run/kestrel/request"],
      1_000,
      8_192,
      signal,
    );
    if (request.cancelled) return;
    if (request.exitCode === 0 && request.stdout.trim().length > 0) {
      let mediated: { ok: true; response: unknown } | { ok: false };
      try {
        const value = JSON.parse(request.stdout) as Record<string, unknown>;
        const adapterInput = value.input as Record<string, unknown> | undefined;
        if (
          value.operation !== grant.operation ||
          value.destination !== grant.destination ||
          Object.keys(value).length !== 3 ||
          adapterInput?.query !== grant.expectedInput.query ||
          adapterInput.maxResults !== grant.expectedInput.maxResults ||
          Object.keys(adapterInput).length !== 2
        ) {
          throw new Error("Broker request does not match the trusted capability grant");
        }
        const invocation = await grant.lifecycle?.beforeProviderInvocation();
        const responseByteLimit = invocation?.responseByteLimit ?? grant.maxResponseBytes ?? 64_000;
        if (!Number.isSafeInteger(responseByteLimit) || responseByteLimit <= 0) {
          throw new Error("Capability invocation response-byte reservation is invalid");
        }
        let response: unknown;
        try {
          response = await invokeAdapterUntilAbort(
            grant.adapter,
            grant.expectedInput,
            signal,
          );
          if (signal.aborted) {
            throw new DockerSandboxCancellationError("Capability adapter completed after cancellation");
          }
          const responseBytes = Buffer.byteLength(JSON.stringify(response), "utf8");
          if (responseBytes > responseByteLimit) {
            throw new Error("Adapter response exceeds the trusted capability ceiling");
          }
          await grant.lifecycle?.commitProviderResult({
            result: response,
            responseBytes,
            resultCount: readCapabilityResultCount(response),
          });
        } catch (error) {
          // Teardown owns cancellation/timeout classification. Recording a
          // generic failure first would make that terminal outcome immutable.
          if (!signal.aborted) await grant.lifecycle?.recordProviderFailure(error);
          throw error;
        }
        mediated = { ok: true, response };
      } catch {
        mediated = { ok: false };
      }
      if (signal.aborted) return;
      const written = await runDockerProcess(
        ["exec", "--interactive", "--user", `${SANDBOX_UID}:${SANDBOX_GID}`, brokerContainerName, "sh", "-c", "umask 077; cat > /run/kestrel/response.tmp && mv /run/kestrel/response.tmp /run/kestrel/response"],
        DOCKER_LIFECYCLE_TIMEOUT_MS,
        DOCKER_LIFECYCLE_OUTPUT_BYTES,
        signal,
        Buffer.from(JSON.stringify(mediated), "utf8"),
      );
      if (written.cancelled) return;
      requireSuccessfulDockerResult(written, "return the capability adapter response");
      return;
    }
    await waitForAdapterRequest(signal);
  }
}

function readCapabilityResultCount(value: unknown): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return 0;
  const results = (value as { results?: unknown }).results;
  return Array.isArray(results) ? results.length : 0;
}

async function invokeAdapterUntilAbort(
  adapter: NonNullable<NonNullable<SandboxExecutionInput["capability"]>["adapter"]>,
  input: { query: string; maxResults: number },
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) throw new DockerSandboxCancellationError("Capability adapter pump was cancelled");
  return adapter(input, signal);
}

async function waitForAdapterRequest(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, 25);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

function withInvocationMarker(args: string[], marker: string): string[] {
  const createIndex = args.indexOf("create");
  if (createIndex < 0) {
    throw new Error("Docker create command is missing its create operation");
  }
  return [
    ...args.slice(0, createIndex + 1),
    "--label",
    `${DOCKER_INVOCATION_LABEL}=${marker}`,
    ...args.slice(createIndex + 1),
  ];
}

async function createOwnedContainer(
  args: string[],
  containerName: string,
  invocationMarker: string,
  action: string,
  signal: AbortSignal | undefined,
  runner: (args: string[], signal?: AbortSignal | undefined) => Promise<DockerProcessResult>,
  ownershipInspectRunner: (containerName: string) => Promise<DockerProcessResult>,
  beforeAmbiguousCreateCleanup: (containerName: string, containerId: string) => Promise<void>,
): Promise<string> {
  const result = await runner(args, signal);
  const reconciliationDeadline = Date.now() + DOCKER_LIFECYCLE_TIMEOUT_MS;
  if (result.exitCode === 0 && result.timedOut === false && result.cancelled === false) {
    try {
      return parseDockerContainerId(result.stdout, `${action} output`);
    } catch (outputError) {
      const inspectedContainerId = await resolveOwnedContainerId(
        containerName,
        invocationMarker,
        ownershipInspectRunner,
        reconciliationDeadline,
      );
      if (inspectedContainerId !== undefined) {
        return inspectedContainerId;
      }
      throw outputError;
    }
  }
  const ownedContainerId = await resolveOwnedContainerId(
    containerName,
    invocationMarker,
    ownershipInspectRunner,
    reconciliationDeadline,
  );
  if (ownedContainerId !== undefined) {
    await beforeAmbiguousCreateCleanup(containerName, ownedContainerId);
    await removeContainer(ownedContainerId);
  }
  if (result.cancelled) {
    throw new DockerSandboxCancellationError("Docker sandbox execution was cancelled");
  }
  if (result.timedOut) {
    throw new Error(`Timed out while attempting to ${action}`);
  }
  const detail = result.stderr.trim() || result.stdout.trim();
  throw new Error(`Unable to ${action}${detail.length > 0 ? `: ${detail}` : ""}`);
}

async function inspectContainerOwnership(containerName: string): Promise<DockerProcessResult> {
  return runDockerProcess(
    ["inspect", "--format", `{{.Id}}|{{index .Config.Labels "${DOCKER_INVOCATION_LABEL}"}}`, containerName],
    DOCKER_LIFECYCLE_TIMEOUT_MS,
    DOCKER_LIFECYCLE_OUTPUT_BYTES,
    undefined,
  );
}

async function resolveOwnedContainerId(
  containerName: string,
  marker: string,
  inspectRunner: (containerName: string) => Promise<DockerProcessResult>,
  deadline: number,
): Promise<string | undefined> {
  for (
    let attempt = 1;
    attempt <= DOCKER_OWNERSHIP_INSPECTION_LIMIT && Date.now() < deadline;
    attempt += 1
  ) {
    let inspected: DockerProcessResult;
    try {
      inspected = await inspectRunner(containerName);
    } catch {
      await waitForOwnershipRetry(attempt, deadline);
      continue;
    }
    if (inspected.exitCode !== 0 || inspected.timedOut || inspected.cancelled) {
      await waitForOwnershipRetry(attempt, deadline);
      continue;
    }
    const fields = inspected.stdout.trim().split("|");
    if (fields.length !== 2) {
      await waitForOwnershipRetry(attempt, deadline);
      continue;
    }
    let containerId: string;
    try {
      containerId = parseDockerContainerId(fields[0] ?? "", "Docker inspect container ID");
    } catch {
      await waitForOwnershipRetry(attempt, deadline);
      continue;
    }
    if (fields[1] !== marker) {
      return;
    }
    return containerId;
  }
  return;
}

async function waitForOwnershipRetry(attempt: number, deadline: number): Promise<void> {
  if (
    attempt >= DOCKER_OWNERSHIP_INSPECTION_LIMIT ||
    Date.now() + DOCKER_OWNERSHIP_RETRY_DELAY_MS >= deadline
  ) {
    return;
  }
  await new Promise<void>((resolve) =>
    setTimeout(resolve, DOCKER_OWNERSHIP_RETRY_DELAY_MS));
}

function parseDockerContainerId(value: string, label: string): string {
  const normalized = value.trim();
  if (/^[a-f0-9]{64}$/u.test(normalized) === false) {
    throw new Error(`${label} is not a valid immutable Docker container ID`);
  }
  return normalized;
}

function redactSensitiveValue(value: string, sensitiveValue: string): string {
  return sensitiveValue.length === 0
    ? value
    : value.split(sensitiveValue).join("[redacted:capability]");
}

function buildTmpfsSpec(
  destination: string,
  sizeMb: number,
  inodeLimit: number,
): string {
  return `${destination}:rw,nosuid,nodev,size=${sizeMb}m,nr_inodes=${inodeLimit},uid=${SANDBOX_UID},gid=${SANDBOX_GID},mode=0700`;
}

function buildDockerExecCommand(
  input: SandboxExecutionInput,
  mainFile: string,
  containerName: string,
): string[] {
  return [
    "exec",
    "--user",
    `${SANDBOX_UID}:${SANDBOX_GID}`,
    "--workdir",
    "/workspace",
    "--env",
    "HOME=/tmp",
    "--env",
    "PYTHONPATH=/workspace/.kestrel-python",
    "--env",
    "NPM_CONFIG_CACHE=/tmp/.npm",
    containerName,
    "sh",
    "-lc",
    buildCommandScript(
      input.request.language,
      mainFile,
      input.request.dependencies ?? [],
      input.request.args ?? [],
    ),
  ];
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
    return;
  }

  const packages = dependencies.map((item) => shellQuote(item)).join(" ");
  if (language === "javascript") {
    return `npm install --no-audit --no-fund --silent ${packages}`;
  }
  if (language === "python") {
    return `pip install --disable-pip-version-check --no-input --quiet --no-deps --no-build-isolation --target /workspace/.kestrel-python ${packages}`;
  }
  return;
}

function joinShellCommands(lines: Array<string | undefined>): string {
  return lines
    .filter((line): line is string =>
      typeof line === "string" && line.trim().length > 0)
    .join("; ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

async function runRequiredDockerCommand(
  args: string[],
  action: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const result = await runDockerProcess(
    args,
    DOCKER_LIFECYCLE_TIMEOUT_MS,
    DOCKER_LIFECYCLE_OUTPUT_BYTES,
    signal,
  );
  if (result.cancelled) {
    throw new DockerSandboxCancellationError(
      "Docker sandbox execution was cancelled",
    );
  }
  if (result.timedOut) {
    throw new Error(`Timed out while attempting to ${action}`);
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `Unable to ${action}${detail.length > 0 ? `: ${detail}` : ""}`,
    );
  }
}

async function copyStagedInputs(input: {
  stagingDir: string;
  relativePaths: string[];
  containerName: string;
  signal: AbortSignal | undefined;
}): Promise<void> {
  for (const relativePath of input.relativePaths) {
    const destination = `/workspace/${relativePath}`;
    const result = await runDockerProcess(
      [
        "exec",
        "--interactive",
        "--user",
        `${SANDBOX_UID}:${SANDBOX_GID}`,
        input.containerName,
        "sh",
        "-c",
        'mkdir -p -- "$1" && cat > "$2" && chmod 0666 -- "$2"',
        "kestrel-copy",
        path.posix.dirname(destination),
        destination,
      ],
      DOCKER_LIFECYCLE_TIMEOUT_MS,
      DOCKER_LIFECYCLE_OUTPUT_BYTES,
      input.signal,
      await readFile(path.join(input.stagingDir, relativePath)),
    );
    if (result.cancelled) {
      throw new DockerSandboxCancellationError(
        "Docker sandbox execution was cancelled",
      );
    }
    if (result.timedOut) {
      throw new Error(`Timed out while copying staged input '${relativePath}'`);
    }
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new Error(
        `Unable to copy staged input '${relativePath}'${detail.length > 0 ? `: ${detail}` : ""}`,
      );
    }
  }
}

async function snapshotWorkspace(input: {
  containerName: string;
  snapshotDir: string;
  baselinePaths: Set<string>;
  maxArtifacts: number;
  maxArtifactBytes: number;
  signal: AbortSignal | undefined;
}): Promise<void> {
  // Docker's archive API reads the image rootfs and cannot see tmpfs mounts.
  // Establish a freezer barrier, then stop every non-supervisor process before
  // streaming regular files out of the bounded workspace.
  await runRequiredDockerCommand(
    ["unpause", input.containerName],
    "unpause sandbox container for snapshotting",
    input.signal,
  );
  await runRequiredDockerCommand(
    [
      "exec",
      "--user",
      `${SANDBOX_UID}:${SANDBOX_GID}`,
      input.containerName,
      "sh",
      "-c",
      [
        "self=$$",
        "for process in /proc/[0-9]*; do",
        "  pid=${process##*/}",
        '  case "$pid" in 1|"$self") continue ;; esac',
        '  kill -STOP "$pid" 2>/dev/null || true',
        "done",
      ].join("\n"),
    ],
    "freeze sandbox background processes",
    input.signal,
  );

  const candidateLimit = input.maxArtifacts + input.baselinePaths.size;
  const listArgs = [
      "exec",
      "--user",
      `${SANDBOX_UID}:${SANDBOX_GID}`,
      input.containerName,
      "sh",
      "-c",
      [
        "find /workspace -type f",
        "  ! -path '/workspace/node_modules/*'",
        "  ! -path '/workspace/.kestrel-python/*'",
        "  ! -path '/workspace/__pycache__/*'",
        "  ! -path '/workspace/.git/*'",
        "  ! -path '/workspace/.cache/*'",
        `  -size -${input.maxArtifactBytes + 1}c`,
        "  -exec sh -c 'for file; do",
        '    relative=${file#/workspace/};',
        '    encoded=$(printf "%s" "$relative" | base64 | tr -d "\\n");',
        '    size=$(stat -c "%s" "$file") || continue;',
        '    device=$(stat -c "%d" "$file") || continue;',
        '    inode=$(stat -c "%i" "$file") || continue;',
        '    mode=$(stat -c "%f" "$file") || continue;',
        '    printf "%s\\t%s\\t%s\\t%s\\t%s\\n" "$encoded" "$size" "$device" "$inode" "$mode";',
        "  done' kestrel-list {} +",
        `  | head -n ${candidateLimit}`,
      ].join(" "),
    ];
  const listResult = await runDockerProcess(
    listArgs,
    DOCKER_LIFECYCLE_TIMEOUT_MS,
    Math.max(DOCKER_LIFECYCLE_OUTPUT_BYTES, candidateLimit * 6_000),
    input.signal,
  );
  requireSuccessfulDockerResult(listResult, "list sandbox snapshot files");

  const candidates = listResult.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => parseSnapshotCandidate(line))
    .filter((candidate): candidate is SnapshotCandidate => candidate !== undefined)
    .filter((candidate) => input.baselinePaths.has(candidate.path) === false)
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .slice(0, input.maxArtifacts);

  await mkdir(input.snapshotDir, { recursive: true });
  for (const candidate of candidates) {
    const contentResult = await runDockerProcess(
      [
        "exec",
        "--user",
        `${SANDBOX_UID}:${SANDBOX_GID}`,
        input.containerName,
        "sh",
        "-c",
        [
          "set -eu",
          'file="$1"',
          'expected="$2"',
          '[ ! -L "$file" ] && [ -f "$file" ] || exit 65',
          'before=$(stat -c "%d:%i:%s:%f" "$file")',
          '[ "$before" = "$expected" ] || exit 66',
          'base64 "$file" | tr -d "\\n"',
          'after=$(stat -c "%d:%i:%s:%f" "$file")',
          '[ "$after" = "$expected" ] || exit 67',
        ].join("\n"),
        "kestrel-snapshot",
        `/workspace/${candidate.path}`,
        snapshotCandidateIdentity(candidate),
      ],
      DOCKER_LIFECYCLE_TIMEOUT_MS,
      Math.ceil(candidate.sizeBytes / 3) * 4 + 16,
      input.signal,
    );
    requireSuccessfulDockerResult(
      contentResult,
      `copy sandbox snapshot file '${candidate.path}'`,
    );
    const contents = Buffer.from(contentResult.stdout, "base64");
    if (contents.byteLength !== candidate.sizeBytes) {
      throw new Error(
        `Unable to copy sandbox snapshot file '${candidate.path}': expected ${candidate.sizeBytes} bytes but received ${contents.byteLength}`,
      );
    }
    const destination = path.join(input.snapshotDir, candidate.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents, { mode: 0o600 });
  }
}

interface SnapshotCandidate {
  path: string;
  sizeBytes: number;
  device: string;
  inode: string;
  mode: string;
}

function parseSnapshotCandidate(line: string): SnapshotCandidate | undefined {
  const [encodedPath, sizeValue, device, inode, mode, ...extra] =
    line.split("\t");
  if (
    encodedPath === undefined ||
    sizeValue === undefined ||
    device === undefined ||
    inode === undefined ||
    mode === undefined ||
    extra.length > 0
  ) {
    return;
  }
  const decodedPath = Buffer.from(encodedPath, "base64").toString("utf8");
  const safePath = sanitizeRelativePath(decodedPath);
  const sizeBytes = Number(sizeValue);
  if (
    safePath === undefined ||
    safePath !== decodedPath ||
    Number.isSafeInteger(sizeBytes) === false ||
    sizeBytes < 0 ||
    /^\d+$/u.test(device) === false ||
    /^\d+$/u.test(inode) === false ||
    /^[0-9a-f]+$/u.test(mode) === false
  ) {
    return;
  }
  return { path: safePath, sizeBytes, device, inode, mode };
}

function snapshotCandidateIdentity(candidate: SnapshotCandidate): string {
  return `${candidate.device}:${candidate.inode}:${candidate.sizeBytes}:${candidate.mode}`;
}

function requireSuccessfulDockerResult(
  result: DockerProcessResult,
  action: string,
): void {
  if (result.cancelled) {
    throw new DockerSandboxCancellationError(
      "Docker sandbox execution was cancelled",
    );
  }
  if (result.timedOut) {
    throw new Error(`Timed out while attempting to ${action}`);
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `Unable to ${action}${detail.length > 0 ? `: ${detail}` : ""}`,
    );
  }
}

async function runDockerProcess(
  args: string[],
  timeoutMs: number,
  maxOutputBytes: number,
  signal: AbortSignal | undefined,
  stdin?: Buffer | undefined,
): Promise<DockerProcessResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DockerSandboxCancellationError(
        "Docker sandbox execution was cancelled",
      ));
      return;
    }

    const child = spawn("docker", args, {
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let termination: "timeout" | "cancelled" | undefined;
    let settling = false;

    const requestTermination = (reason: "timeout" | "cancelled") => {
      if (termination !== undefined) {
        return;
      }
      termination = reason;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => requestTermination("timeout"), timeoutMs);
    const onAbort = () => requestTermination("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });

    const stopListening = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = appendBounded(stdout, String(chunk), maxOutputBytes);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = appendBounded(stderr, String(chunk), maxOutputBytes);
    });
    child.stdin?.on("error", () => {});
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
    child.on("error", (error) => {
      if (settling) {
        return;
      }
      settling = true;
      stopListening();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new DockerUnavailableError("docker command is not available"));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (settling) {
        return;
      }
      settling = true;
      stopListening();
      resolve({
        exitCode: code,
        timedOut: termination === "timeout",
        cancelled: termination === "cancelled",
        stdout,
        stderr,
      });
    });
  });
}

async function removeContainer(containerName: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn("docker", ["rm", "--force", containerName], {
      stdio: "ignore",
    });
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, 5_000);
    child.once("error", finish);
    child.once("close", finish);
  });
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DockerSandboxCancellationError(
      "Docker sandbox execution was cancelled",
    );
  }
}

function appendBounded(value: string, append: string, maxBytes: number): string {
  const combined = value + append;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) {
    return combined;
  }

  const marker = "\n...[truncated]";
  const allowedBytes = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  return `${truncateUtf8Bytes(combined, allowedBytes)}${marker}`;
}

function truncateUtf8Bytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  const bytes = Buffer.from(value, "utf8");
  return bytes.byteLength <= maxBytes
    ? value
    : bytes.subarray(0, maxBytes).toString("utf8");
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
    const before = await lstat(absolutePath);
    if (before.isFile() === false || before.size > input.maxArtifactBytes) {
      continue;
    }

    const contents = await readFile(absolutePath);
    const after = await lstat(absolutePath);
    if (
      after.isFile() === false ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      contents.byteLength !== before.size
    ) {
      throw new Error(
        `Sandbox artifact '${relativePath}' changed while it was being verified`,
      );
    }
    artifacts.push({
      path: relativePath,
      sizeBytes: before.size,
      sha256: createHash("sha256").update(contents).digest("hex"),
      preview: {
        text: contents.toString("utf8", 0, Math.min(contents.byteLength, 2000)),
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

    const relativePath = relativeDir.length > 0
      ? `${relativeDir}/${entry.name}`
      : entry.name;
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
