#!/usr/bin/env node

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  hasTerminalEvent,
  parseNetworkObservations,
  parseExactAgentToolResult,
  parseQualificationRunStream,
  readCapabilityReplayEvidence,
  readCodeStdout,
  type ParsedQualificationRun,
} from "./qualification/sandbox-capability-evidence.js";

const execFileAsync = promisify(execFile);
const MODES = new Set(["live", "controlled", "all"]);
const CHECKPOINTS = [
  ["before_provider_invocation", false],
  ["provider_response_received", false],
  ["provider_result_committed", false],
  ["before_exact_result_persistence", false],
  ["exact_result_persisted", true],
  ["lease_cleanup_completed", true],
] as const;

interface QualificationConfig {
  hostMode: "local" | "ssh";
  sshTarget: string;
  sshKeyPath: string;
  mode: "live" | "controlled" | "all";
  commit: string;
  remoteRoot: string;
  repositoryRoot: string;
  tenantId: string;
  environmentId: string;
  runnerToken: string;
  controlToken: string;
  tavilyKey: string;
  modelProvider: string;
  model: string;
  modelCredentialName: string;
  modelCredential: string;
  baselineContainers: string[];
}

interface ScenarioEvidence {
  name: string;
  mode: "live" | "controlled";
  status: "passed" | "failed";
  startedAt: string;
  completedAt: string;
  runId?: string;
  sessionId?: string;
  idempotencyKey?: string;
  assertions: string[];
  publicEvidence: unknown[];
  error?: string;
}

async function main(): Promise<void> {
  const config = await readConfig();
  const startedAt = new Date().toISOString();
  const artifactDir = path.resolve("artifacts", "qualification", "sandbox-capability", startedAt.replaceAll(":", "-").replace(".", "-"));
  await mkdir(artifactDir, { recursive: true });
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-sandbox-qualification-"));
  const archivePath = path.join(tempDir, "source.tar.gz");
  const scenarios: ScenarioEvidence[] = [];
  let tunnel: ChildProcess | undefined;
  let localPort: number | undefined;
  let remoteFacts: unknown = { available: false };
  let providerSnapshot = "";
  let lifecycleSnapshot = "";
  let cleanup: { ok: boolean; containers?: string; error?: string } = { ok: false, error: "cleanup_not_attempted" };
  try {
    await verifyLocalTree(config.commit);
    await verifyRemoteHost(config);
    config.baselineContainers = (await remote(config, "docker ps -a --format '{{.Names}}' | grep '^kestrel-' || true")).stdout.trim().split("\n").filter(Boolean);
    remoteFacts = await collectRemoteFacts(config);
    if (config.hostMode === "ssh") {
      await execFileAsync("git", ["archive", "--format=tar.gz", "-o", archivePath, config.commit]);
      await upload(config, archivePath, "/tmp/kestrel-sandbox-qualification.tar.gz");
      await remote(config, bootstrapCommand(config));
      localPort = await reservePort();
      tunnel = await openTunnel(config, localPort, 43105);
    } else {
      await remote(config, bootstrapCommand(config));
      localPort = 43105;
    }

    if (config.mode === "controlled" || config.mode === "all") {
      await startRemote(config, "controlled");
      await waitForHealth(config, localPort, config.runnerToken);
      await runControlledJourney(config, localPort, scenarios);
      await stopRemote(config);
    }
    if (config.mode === "live" || config.mode === "all") {
      await startRemote(config, "live");
      await waitForHealth(config, localPort, config.runnerToken);
      await runLiveJourney(config, localPort, scenarios);
      await stopRemote(config);
    }
  } catch (error) {
    scenarios.push(failedEvidence("qualification", config.mode === "live" ? "live" : "controlled", error));
  } finally {
    tunnel?.kill("SIGTERM");
    providerSnapshot = await providerEvidence(config).catch(() => "");
    lifecycleSnapshot = await remote(config, `test ! -f ${shell(`${config.remoteRoot}/runtime/control/events.ndjson`)} || cat ${shell(`${config.remoteRoot}/runtime/control/events.ndjson`)}`)
      .then((result) => result.stdout)
      .catch(() => "");
    cleanup = await cleanupRemote(config).catch((error) => ({ ok: false, error: errorMessage(error) }));
    await writeEvidenceBundle({ artifactDir, config, startedAt, scenarios, cleanup, remoteFacts, providerSnapshot, lifecycleSnapshot });
    await rm(tempDir, { recursive: true, force: true });
  }

  const failed = scenarios.filter((scenario) => scenario.status === "failed");
  const ok = failed.length === 0 && cleanup.ok;
  process.stdout.write(`${JSON.stringify({
    ok,
    artifactDir,
    scenarios: scenarios.map(({ name, mode, status }) => ({ name, mode, status })),
  }, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

async function runControlledJourney(config: QualificationConfig, port: number, evidence: ScenarioEvidence[]): Promise<void> {
  const client = new PublicRunnerClient(port, config.runnerToken, config.tenantId);
  const profileId = await client.resolveProfile(config, "controlled", { timeoutMs: 300, maxExpiryMs: 20_000 });
  await capture(evidence, "capability-free", "controlled", async () => {
    const before = await providerEvidence(config);
    const result = await client.run(profileId, "capability-free");
    requireTrue(hasTerminalEvent(result.parsed, "run.completed"), "capability-free run did not complete");
    requireTrue(result.parsed.codeResults.every((item) => readCapabilityReplayEvidence(item) === undefined), "capability-free run minted capability evidence");
    requireEqual(await providerEvidence(config), before, "capability-free run contacted provider");
    return result;
  });
  await capture(evidence, "selected-unused", "controlled", async () => {
    const before = await providerEvidence(config);
    const result = await client.run(profileId, "selected-unused");
    requireTrue(result.parsed.codeResults.some((item) => readCodeStdout(item).includes("selected capability intentionally unused")), "selected-unused output missing");
    requireTrue(result.parsed.codeResults.some((item) => readCapabilityReplayEvidence(item) !== undefined), "selected-unused exact evidence missing");
    requireEqual(await providerEvidence(config), before, "selected-unused contacted provider");
    await requireCapabilityLease(client, result.runId, { status: "cleaned", remainingRequests: 1 });
    return result;
  });
  await capture(evidence, "provider-used", "controlled", async () => {
    const result = await client.run(profileId, "provider-used");
    requireTrue(hasTerminalEvent(result.parsed, "run.completed"), "provider-used run did not complete");
    const observations = result.parsed.codeResults.flatMap((item) => parseNetworkObservations(readCodeStdout(item)));
    requireEqual(observations.map((item) => item.url).sort(), ["http://10.255.255.1:80", "http://127.0.0.1:80", "http://169.254.169.254/latest/meta-data/", "https://example.com"].sort(), "controlled network probe inventory changed");
    requireTrue(observations.every((item) => item.outcome === "blocked"), `controlled sandbox unexpectedly reached a direct-network target: ${canonical(observations)}`);
    requireMatch(await providerEvidence(config), /qualification-provider-used/u, "controlled provider was not contacted");
    assertSecretFree(result.stream, config);
    await requireCapabilityLease(client, result.runId, { status: "cleaned", remainingRequests: 0 });
    return result;
  });
  await capture(evidence, "cancellation", "controlled", async () => {
    const pending = client.run(profileId, "cancel");
    await waitForRemoteMatch(config, "provider.ndjson", /qualification-block-cancel/u);
    const sessionId = pending.sessionId;
    await client.cancel(sessionId);
    const result = await pending.promise;
    requireTrue(hasTerminalEvent(result.parsed, "run.cancelled"), "cancelled run did not terminate as cancelled");
    requireMatch(await providerEvidence(config), /"kind":"provider_abort"/u, "provider abort was not observed");
    await client.expectExactResultUnavailable(result);
    return result;
  });
  await capture(evidence, "timeout", "controlled", async () => {
    const result = await client.run(profileId, "timeout");
    requireRun(hasStructuredPublicValue(result.parsed, "capability_timeout"), result, "timeout code missing");
    await requireCapabilityLease(client, result.runId, { status: "cleaned", terminalReason: "provider_invocation_timeout" });
    return result;
  });
  const expiryProfile = await client.resolveProfile(config, "controlled", { timeoutMs: 2_000, maxExpiryMs: 100 });
  await capture(evidence, "expiry", "controlled", async () => {
    const result = await client.run(expiryProfile, "expiry");
    await requireCapabilityLease(client, result.runId, { status: "cleaned", terminalReason: "lease_expired" });
    return result;
  });
  await capture(evidence, "secret-reflection", "controlled", async () => {
    const result = await client.run(profileId, "reflect-secret");
    assertSecretFree(result.stream, config);
    assertSecretFree(JSON.stringify(await client.operatorRun(result.runId)), config);
    return result;
  });
  await capture(evidence, "crash-during-provider-invocation", "controlled", async () => {
    try {
      const before = await remoteMatchCount(config, "provider.ndjson", /qualification-block-cancel/u);
      const pending = client.run(profileId, "cancel");
      const settled = pending.promise.catch((error) => error instanceof PartialRunError ? error.result : undefined);
      await waitForRemoteMatch(config, "provider.ndjson", /qualification-block-cancel/u, before + 1);
      await killRemote(config);
      const partial = await settled;
      await startRemote(config, "controlled", { credentials: false });
      await waitForHealth(config, port, config.runnerToken);
      if (partial?.runId && partial.idempotencyKey) await client.expectExactResultUnavailable(partial);
      return partial ?? { stream: "", parsed: parseQualificationRunStream(""), runId: "ambiguous", sessionId: pending.sessionId };
    } finally {
      await stopRemote(config).catch(() => undefined);
      await startRemote(config, "controlled").catch(() => undefined);
      await waitForHealth(config, port, config.runnerToken).catch(() => undefined);
    }
  });
  for (const [checkpoint, replayExpected] of CHECKPOINTS) {
    await capture(evidence, `crash-${checkpoint}`, "controlled", async () => {
      try {
        const barrierNonce = await armCheckpoint(config, checkpoint);
        const pending = client.run(profileId, "provider-used");
        const settled = pending.promise.catch((error) => error instanceof PartialRunError ? error.result : undefined);
        await waitForRemoteMatch(config, "control/events.ndjson", new RegExp(`"checkpoint":"${checkpoint}"[^\n]*"barrierNonce":"${barrierNonce}"`, "u"));
        await killRemote(config);
        const partial = await settled;
        await startRemote(config, "controlled", { credentials: false });
        await waitForHealth(config, port, config.runnerToken);
        const recovered = await recoverRunIdentity(config, checkpoint);
        const result = recovered ? { ...recovered, ...partial, idempotencyKey: partial?.idempotencyKey ?? recovered.idempotencyKey } : partial;
        if (!result?.runId || !result.sessionId || !result.idempotencyKey) {
          if (replayExpected) throw new Error(`Crash at ${checkpoint} did not expose exact result identity.`);
          return { stream: "", parsed: parseQualificationRunStream(""), runId: result?.runId ?? "unknown", sessionId: result?.sessionId ?? "unknown" };
        }
        if (replayExpected) await client.getExactResult(result);
        else await client.expectExactResultUnavailable(result);
        return result;
      } finally {
        await stopRemote(config).catch(() => undefined);
        await remote(config, `rm -f ${shell(`${config.remoteRoot}/runtime/control/${checkpoint}.pause`)} ${shell(`${config.remoteRoot}/runtime/control/${checkpoint}.release`)}`).catch(() => undefined);
        await startRemote(config, "controlled").catch(() => undefined);
        await waitForHealth(config, port, config.runnerToken).catch(() => undefined);
      }
    });
  }
  await capture(evidence, "concurrency", "controlled", async () => {
    const sessionId = `qualification-concurrency-${randomUUID()}`;
    const commandId = `qualification-concurrency-${randomUUID()}`;
    const before = providerRequestCount(await providerEvidence(config));
    const [a, b] = await Promise.allSettled([
      client.run(profileId, "concurrency", { sessionId, commandId }),
      client.run(profileId, "concurrency", { sessionId, commandId }),
    ]);
    const after = providerRequestCount(await providerEvidence(config));
    requireEqual(after - before, 1, "concurrent duplicate contacted provider more than once");
    const winner = [a, b].find((entry): entry is PromiseFulfilledResult<RunResult> => entry.status === "fulfilled");
    if (!winner) throw new Error("Concurrent duplicate produced no winner.");
    return winner.value;
  });
}

async function runLiveJourney(config: QualificationConfig, port: number, evidence: ScenarioEvidence[]): Promise<void> {
  const client = new PublicRunnerClient(port, config.runnerToken, config.tenantId);
  const profileId = await client.resolveProfile(config, "live", { timeoutMs: 10_000, maxExpiryMs: 60_000 });
  await capture(evidence, "live-tavily", "live", async () => {
    const marker = `kestrel-live-${randomUUID()}`;
    const result = await client.run(profileId, `provider-used ${marker}`);
    requireRun(hasTerminalEvent(result.parsed, "run.completed"), result, "live Tavily run did not complete");
    if (!result.parsed.codeResults.some((item) => readCapabilityReplayEvidence(item) !== undefined)) {
      throw new QualificationRunAssertionError(result, "MODEL_DID_NOT_SELECT_CAPABILITY: Luna completed without selecting the optional Tavily capability");
    }
    const stdout = result.parsed.codeResults.map(readCodeStdout).join("\n");
    requireRun(stdout.includes("DIRECT_NETWORK_BLOCKED direct HTTPS") && stdout.includes("DIRECT_NETWORK_BLOCKED loopback") && stdout.includes("DIRECT_NETWORK_BLOCKED metadata-network"), result, `live sandbox did not report blocked direct-network probes; observed stdout evidence: ${stdout.slice(0, 4_000)}`);
    requireRun(!stdout.includes("DIRECT_NETWORK_UNEXPECTED"), result, "live sandbox unexpectedly reached a direct-network target");
    assertSecretFree(result.stream, config);
    const exact = await client.getExactResult(result);
    requireRun(readExactCapabilityQuery(exact) === marker, result, "live exact result did not bind the unique Tavily query marker");
    await requireCapabilityLease(client, result.runId, { status: "cleaned", remainingRequests: 0 });
    await stopRemote(config);
    await setRemoteDockerAvailable(config, false);
    try {
      await startRemote(config, "live", { credentials: false });
      await waitForHealth(config, port, config.runnerToken);
      const replay = await client.getExactResult(result);
      requireEqual(canonical(replay), canonical(exact), "post-restart exact result changed");
    } finally {
      await stopRemote(config).catch(() => undefined);
      await setRemoteDockerAvailable(config, true);
    }
    return result;
  });
}

interface RunResult { stream: string; parsed: ParsedQualificationRun; runId: string; sessionId: string; idempotencyKey?: string }

class PublicRunnerClient {
  readonly baseUrl: string;
  constructor(port: number, private readonly token: string, private readonly tenantId: string) {
    this.baseUrl = `http://127.0.0.1:${port}`;
  }
  async command(type: string, payload: unknown): Promise<any> {
    const response = await fetch(`${this.baseUrl}/commands`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: `qualification-${randomUUID()}`, type, metadata: this.metadata(), payload }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`${type} failed (${response.status}): ${JSON.stringify(body)}`);
    return body;
  }
  async resolveProfile(config: QualificationConfig, mode: "live" | "controlled", limits: { timeoutMs: number; maxExpiryMs: number }): Promise<string> {
    const body = await this.command("execution-profile.resolve", {
      environmentPresetId: "workspace_hosted",
      managedConfiguration: {
        modelProvider: mode === "controlled" ? "openrouter" : config.modelProvider,
        model: mode === "controlled" ? "openai/gpt-5.6-luna" : config.model,
        codeMode: {
          enabled: true,
          languages: ["javascript", "typescript", "python"],
          sandbox: { image: "node:22-bookworm-slim", network: "none", user: "65532:65532", readOnlyRoot: true, timeoutMs: 30_000, memoryMb: 256, cpuCores: 1, pidsLimit: 64, tmpfsMb: 32 },
          retention: { stdoutBytes: 64_000, stderrBytes: 64_000, artifactBytes: 1_000_000, artifactCount: 10 },
          approvalMode: "auto",
          capabilities: [{
            version: 1,
            capabilityId: "tavily.search.read",
            operations: ["search"],
            resource: "https://api.tavily.com/search",
            audience: { tenantId: config.tenantId, environmentId: config.environmentId },
            maxRequests: 1,
            maxQueryChars: 256,
            maxResults: 3,
            maxResponseBytes: 16_384,
            timeoutMs: limits.timeoutMs,
            maxExpiryMs: limits.maxExpiryMs,
            brokerAuthority: { authorityId: "qualification-broker", revision: "qualification-r1" },
          }],
        },
      },
    });
    if (body.type !== "execution-profile.resolved" || typeof body.payload?.profileId !== "string") {
      throw new Error(`Profile resolution returned malformed evidence: ${JSON.stringify(body)}`);
    }
    return body.payload.profileId;
  }
  run(profileId: string, mode: string, identity: { sessionId?: string; commandId?: string } = {}): Promise<RunResult> & { sessionId: string; promise: Promise<RunResult> } {
    const sessionId = identity.sessionId ?? `qualification-${mode}-${randomUUID()}`;
    const promise = this.streamCommand(identity.commandId ?? `qualification-${mode}-${randomUUID()}`, {
      profileId,
      turn: {
        sessionId,
        message: mode.startsWith("provider-used ")
          ? `qualification ${mode}. You must use code.execute exactly once. In the sandbox, attempt direct HTTPS, loopback, and metadata-network fetches with short abort deadlines. Print DIRECT_NETWORK_BLOCKED for each rejected probe and DIRECT_NETWORK_UNEXPECTED if any probe succeeds. Then invoke the selected Tavily capability using the unique marker. Do not use another network tool.`
          : `qualification ${mode}`,
        eventType: "user.message",
        interactionMode: "build",
        actSubmode: "full_auto",
        executionPolicy: {
          toolClassPolicy: { read_only: true, planning_write: true, sandboxed_only: true, external_side_effect: true },
          capabilityPolicy: { "workspace.read": true, "workspace.write": true, "shell.exec": true, "code.execute": true, "network.call": true, "mcp.invoke": true, "external.confirm": true },
          approvalPolicy: { strictApprovalPerCall: false },
        },
      },
    }, sessionId);
    return Object.assign(promise, { sessionId, promise });
  }
  async streamCommand(id: string, payload: unknown, sessionId: string): Promise<RunResult> {
    const response = await fetch(`${this.baseUrl}/commands/stream`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ id, type: "run.start", metadata: this.metadata(), payload }),
    });
    let stream = "";
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Run stream had no response body.");
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        stream += new TextDecoder().decode(next.value, { stream: true });
      }
    } catch (error) {
      throw new PartialRunError(readRunResult(stream, sessionId), error);
    }
    if (!response.ok) throw new Error(`run.start failed (${response.status}): ${stream}`);
    return readRunResult(stream, sessionId);
  }
  async cancel(sessionId: string): Promise<void> { await this.command("run.cancel", { sessionId }); }
  async operatorRun(runId: string): Promise<unknown> { return await this.command("operator.run", { runId }); }
  async getExactResult(result: Pick<RunResult, "sessionId" | "runId" | "idempotencyKey">): Promise<unknown> {
    if (!result.idempotencyKey) throw new Error("Run did not expose an idempotency key.");
    const body = await this.command("effect.result.get", { sessionId: result.sessionId, runId: result.runId, idempotencyKey: result.idempotencyKey });
    if (body.type !== "effect.result.loaded") throw new Error(`Exact result unavailable: ${JSON.stringify(body)}`);
    return parseExactAgentToolResult(body.payload.result);
  }
  async expectExactResultUnavailable(result: Pick<RunResult, "sessionId" | "runId" | "idempotencyKey">): Promise<void> {
    try { await this.getExactResult(result); } catch { return; }
    throw new Error("Exact result unexpectedly replayed after an uncommitted outcome.");
  }
  private metadata() { return { actor: { actorId: "qualification", actorType: "operator", tenantId: this.tenantId }, tenantId: this.tenantId }; }
}

class PartialRunError extends Error {
  constructor(readonly result: RunResult, cause: unknown) { super(`Run stream ended during qualification: ${errorMessage(cause)}`); }
}

class QualificationRunAssertionError extends Error {
  constructor(readonly result: RunResult, message: string) { super(message); }
}

function readRunResult(stream: string, sessionId: string): RunResult {
  const parsed = parseQualificationRunStream(stream);
  return { stream, parsed, runId: parsed.runId, sessionId, ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}) };
}

async function capture(evidence: ScenarioEvidence[], name: string, mode: "live" | "controlled", run: () => Promise<RunResult>): Promise<void> {
  const startedAt = new Date().toISOString();
  try {
    const result = await run();
    evidence.push({ name, mode, status: "passed", startedAt, completedAt: new Date().toISOString(), runId: result.runId, sessionId: result.sessionId, idempotencyKey: result.idempotencyKey, assertions: ["public_terminal_state", "secret_scan"], publicEvidence: [redactEvidence(result.stream)] });
  } catch (error) {
    const failed = failedEvidence(name, mode, error, startedAt);
    if (error instanceof QualificationRunAssertionError) {
      failed.runId = error.result.runId;
      failed.sessionId = error.result.sessionId;
      failed.idempotencyKey = error.result.idempotencyKey;
      failed.publicEvidence = [summarizePublicRun(error.result)];
    }
    evidence.push(failed);
  }
}

function failedEvidence(name: string, mode: "live" | "controlled", error: unknown, startedAt = new Date().toISOString()): ScenarioEvidence {
  return { name, mode, status: "failed", startedAt, completedAt: new Date().toISOString(), assertions: [], publicEvidence: [], error: errorMessage(error) };
}

async function readConfig(): Promise<QualificationConfig> {
  const mode = process.env.KESTREL_QUALIFICATION_MODE ?? "all";
  if (!MODES.has(mode)) throw new Error("KESTREL_QUALIFICATION_MODE must be live, controlled, or all.");
  const commit = (await execFileAsync("git", ["rev-parse", "HEAD"])).stdout.trim();
  const liveRequired = mode === "live" || mode === "all";
  const hostMode = process.env.KESTREL_QUALIFICATION_HOST_MODE?.trim() === "ssh" ? "ssh" : "local";
  const localRepositoryRoot = (await execFileAsync("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
  const remoteRoot = process.env.KESTREL_QUALIFICATION_REMOTE_ROOT?.trim() || (hostMode === "ssh" ? `/opt/kestrel-qualification/${commit.slice(0, 12)}` : path.join(os.tmpdir(), `kestrel-qualification-${commit.slice(0, 12)}`));
  return {
    hostMode,
    sshTarget: hostMode === "ssh" ? required("KESTREL_QUALIFICATION_SSH_TARGET") : "local-docker-desktop",
    sshKeyPath: hostMode === "ssh" ? path.resolve(required("KESTREL_QUALIFICATION_SSH_KEY")) : "",
    mode: mode as QualificationConfig["mode"],
    commit,
    remoteRoot,
    repositoryRoot: hostMode === "ssh" ? remoteRoot : localRepositoryRoot,
    tenantId: optional("KESTREL_QUALIFICATION_TENANT_ID") ?? `qualification-tenant-${randomUUID()}`,
    environmentId: optional("KESTREL_QUALIFICATION_ENVIRONMENT_ID") ?? `qualification-environment-${randomUUID()}`,
    runnerToken: optional("KESTREL_QUALIFICATION_RUNNER_TOKEN") ?? `${randomUUID()}${randomUUID()}`.replaceAll("-", ""),
    controlToken: optional("KESTREL_QUALIFICATION_CONTROL_TOKEN") ?? `${randomUUID()}${randomUUID()}`.replaceAll("-", ""),
    tavilyKey: liveRequired
      ? required("KESTREL_QUALIFICATION_TAVILY_KEY")
      : optional("KESTREL_QUALIFICATION_TAVILY_KEY") ?? `qualification-controlled-${randomUUID()}`,
    modelProvider: process.env.KESTREL_QUALIFICATION_MODEL_PROVIDER?.trim() || "openrouter",
    model: liveRequired
      ? required("KESTREL_QUALIFICATION_MODEL")
      : optional("KESTREL_QUALIFICATION_MODEL") ?? "openai/gpt-5.6-luna",
    modelCredentialName: validateCredentialName(process.env.KESTREL_QUALIFICATION_MODEL_CREDENTIAL_NAME?.trim() || "OPENROUTER_API_KEY"),
    modelCredential: liveRequired ? required("KESTREL_QUALIFICATION_MODEL_CREDENTIAL") : "",
    baselineContainers: [],
  };
}

async function verifyLocalTree(commit: string): Promise<void> {
  const status = (await execFileAsync("git", ["status", "--porcelain", "--untracked-files=no"])).stdout.trim();
  if (status) throw new Error("Qualification requires a clean tracked worktree.");
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error("Qualification commit is invalid.");
}

async function verifyRemoteHost(config: QualificationConfig): Promise<void> {
  if (config.hostMode === "local") {
    const output = await remote(config, "set -eu; command -v docker; docker info >/dev/null; command -v node; test \"$(node -p 'process.versions.node.split(`.`)[0]')\" = 22; test ! -e " + shell(config.remoteRoot));
    if (output.stderr.trim()) process.stderr.write(output.stderr);
    return;
  }
  const output = await remote(config, "set -eu; test \"$(uname -s)\" = Linux; . /etc/os-release; test \"$ID\" = ubuntu; test \"$VERSION_ID\" = 24.04; command -v docker; docker info >/dev/null; command -v node; test \"$(node -p 'process.versions.node.split(`.`)[0]')\" = 22; test ! -e " + shell(config.remoteRoot));
  if (output.stderr.trim()) process.stderr.write(output.stderr);
}

function bootstrapCommand(config: QualificationConfig): string {
  if (config.hostMode === "local") return `set -eu; mkdir -m 700 -p ${shell(`${config.remoteRoot}/runtime/control`)} ${shell(`${config.remoteRoot}/runtime/store`)} ${shell(`${config.remoteRoot}/runtime/home`)}`;
  return `set -eu; sudo mkdir -p ${shell(config.remoteRoot)}; sudo chown \"$(id -u):$(id -g)\" ${shell(config.remoteRoot)}; tar -xzf /tmp/kestrel-sandbox-qualification.tar.gz -C ${shell(config.remoteRoot)}; cd ${shell(config.remoteRoot)}; corepack enable; pnpm install --frozen-lockfile; pnpm exec tsc -p tsconfig.json; mkdir -m 700 -p runtime/control runtime/store runtime/home; rm -f /tmp/kestrel-sandbox-qualification.tar.gz`;
}

async function startRemote(config: QualificationConfig, mode: "live" | "controlled", options: { credentials?: boolean } = {}): Promise<void> {
  const credentials = options.credentials !== false;
  const env: Record<string, string> = {
    KESTREL_DISABLE_DOTENV: "1",
    KESTREL_RUNNER_STORE_DIR: `${config.remoteRoot}/runtime/store`,
    KESTREL_STORE_MIGRATIONS_DIR: `${config.repositoryRoot}/db/migrations`,
    KESTREL_HOME: `${config.remoteRoot}/runtime/home`,
    KESTREL_RUNNER_SERVICE_HOST: "127.0.0.1",
    KESTREL_RUNNER_SERVICE_PORT: "43105",
    KESTREL_RUNNER_SERVICE_TOKEN: config.runnerToken,
    KESTREL_TENANT_ID: config.tenantId,
    KESTREL_ENVIRONMENT_ID: config.environmentId,
    KESTREL_SANDBOX_BROKER_AUTHORITY_ID: "qualification-broker",
    KESTREL_SANDBOX_BROKER_AUTHORITY_REVISION: "qualification-r1",
    KESTREL_QUALIFICATION_MODE: mode,
    KESTREL_QUALIFICATION_CONTROL_DIR: `${config.remoteRoot}/runtime/control`,
    KESTREL_QUALIFICATION_CONTROL_TOKEN: config.controlToken,
    KESTREL_QUALIFICATION_PROVIDER_EVIDENCE: `${config.remoteRoot}/runtime/provider.ndjson`,
    ...(credentials ? {
      KESTREL_SANDBOX_TAVILY_CREDENTIAL: config.tavilyKey,
      KESTREL_SANDBOX_TAVILY_CREDENTIAL_REVISION: "qualification-live-r1",
      [config.modelCredentialName]: mode === "controlled" ? "qualification-model-key" : config.modelCredential,
    } : {}),
    ...(mode === "controlled" ? { OPENROUTER_BASE_URL: "http://127.0.0.1:43191" } : {}),
    ...(!credentials && config.hostMode === "local" ? { DOCKER_HOST: "unix:///tmp/kestrel-qualification-docker-unavailable.sock" } : {}),
  };
  await uploadText(config, Object.entries(env).map(([key, value]) => `${key}=${encodeEnv(value)}`).join("\n") + "\n", `${config.remoteRoot}/runtime/runner.env`);
  const entrypoint = mode === "controlled" ? "dist/cli/runner/qualification-service.js" : "dist/cli/runner/service.js";
  const modelStart = mode === "controlled" ? `nohup node --import tsx scripts/qualification/sandbox-capability-model-server.ts >${shell(`${config.remoteRoot}/runtime/model.log`)} 2>&1 & echo $! >${shell(`${config.remoteRoot}/runtime/model.pid`)}; ` : "";
  await remote(config, `set -eu; cd ${shell(config.repositoryRoot)}; ${modelStart}nohup sh -c 'set -a; . ${shell(`${config.remoteRoot}/runtime/runner.env`)}; set +a; exec node ${entrypoint}' >${shell(`${config.remoteRoot}/runtime/runner.log`)} 2>&1 & echo $! >${shell(`${config.remoteRoot}/runtime/runner.pid`)}`);
}

async function stopRemote(config: QualificationConfig): Promise<void> {
  await remote(config, `set +e; for f in ${shell(`${config.remoteRoot}/runtime/runner.pid`)} ${shell(`${config.remoteRoot}/runtime/model.pid`)}; do if test -f \"$f\"; then kill -TERM \"$(cat \"$f\")\" 2>/dev/null; fi; done; sleep 1; for f in ${shell(`${config.remoteRoot}/runtime/runner.pid`)} ${shell(`${config.remoteRoot}/runtime/model.pid`)}; do if test -f \"$f\"; then kill -KILL \"$(cat \"$f\")\" 2>/dev/null; rm -f \"$f\"; fi; done; exit 0`);
}

async function killRemote(config: QualificationConfig): Promise<void> {
  await remote(config, `set -eu; kill -KILL \"$(cat ${shell(`${config.remoteRoot}/runtime/runner.pid`)})\"; rm -f ${shell(`${config.remoteRoot}/runtime/runner.pid`)}`);
}

async function setRemoteDockerAvailable(config: QualificationConfig, available: boolean): Promise<void> {
  if (config.hostMode === "local") return;
  await remote(config, available
    ? "set -eu; sudo systemctl start docker.service; docker info >/dev/null"
    : "set -eu; sudo systemctl stop docker.service docker.socket; test ! -S /var/run/docker.sock");
}

async function cleanupRemote(config: QualificationConfig): Promise<{ ok: boolean; containers: string }> {
  await stopRemote(config).catch(() => undefined);
  const current = (await remote(config, "docker ps -a --format '{{.Names}}' | grep '^kestrel-' || true")).stdout.trim().split("\n").filter(Boolean);
  const containers = current.filter((name) => !config.baselineContainers.includes(name)).join("\n");
  if (containers.length > 0) {
    await remote(config, `docker rm -f ${containers.split("\n").map(shell).join(" ")} >/dev/null`);
  }
  const remaining = (await remote(config, "docker ps -a --format '{{.Names}}' | grep '^kestrel-' || true")).stdout.trim().split("\n").filter(Boolean).filter((name) => !config.baselineContainers.includes(name));
  await remote(config, `set -eu; test ${remaining.length} -eq 0; rm -rf ${shell(config.remoteRoot)}`);
  return { ok: remaining.length === 0, containers: remaining.join("\n") };
}

async function waitForHealth(config: QualificationConfig, port: number, token: string): Promise<void> {
  const signal = AbortSignal.timeout(60_000);
  while (!signal.aborted) {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
    if (response?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const logs = await remote(config, `for f in ${shell(`${config.remoteRoot}/runtime/runner.log`)} ${shell(`${config.remoteRoot}/runtime/model.log`)}; do test ! -f "$f" || tail -n 80 "$f"; done`).then((result) => result.stdout).catch(() => "");
  throw new Error(`Qualification runner health check timed out.${logs ? `\n${logs}` : ""}`);
}

async function requireCapabilityLease(
  client: PublicRunnerClient,
  runId: string,
  expected: { status?: string; remainingRequests?: number; terminalReason?: string },
): Promise<Record<string, unknown>> {
  const response = asRecord(await client.operatorRun(runId));
  const payload = asRecord(response.payload);
  const view = asRecord(payload.view);
  const report = asRecord(view.sandboxCapabilities);
  const leases = Array.isArray(report.leases) ? report.leases.map(asRecord) : [];
  if (leases.length !== 1) throw new Error(`Operator projection exposed ${leases.length} capability leases; expected exactly one.`);
  const lease = leases[0]!;
  for (const [field, value] of Object.entries(expected)) {
    if (lease[field] !== value) throw new Error(`Operator capability ${field} mismatch: expected ${JSON.stringify(value)}, received ${JSON.stringify(lease[field])}.`);
  }
  return lease;
}

function hasStructuredPublicValue(run: ParsedQualificationRun, expected: string): boolean {
  const visit = (value: unknown): boolean => {
    if (value === expected) return true;
    if (Array.isArray(value)) return value.some(visit);
    if (typeof value === "object" && value !== null) return Object.values(value).some(visit);
    return false;
  };
  if (run.events.some(visit) || run.codeResults.some(visit)) return true;
  return run.codeResults.some((result) => result.stdout.split(/\r?\n/u).some((line) => {
    if (line.trim() === "") return false;
    try { return visit(JSON.parse(line)); } catch { return false; }
  }));
}

function summarizePublicRun(result: RunResult): unknown {
  return {
    terminalEvents: result.parsed.events.filter((event) => event.type === "run.completed" || event.type === "run.cancelled" || event.type === "run.failed").map((event) => ({ type: event.type, runId: event.runId, payload: event.payload })),
    codeResults: result.parsed.codeResults.map((item) => ({ stdout: item.stdout.slice(0, 4_000), capabilityReplayEvidence: item.capabilityReplayEvidence })),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readExactCapabilityQuery(value: unknown): string | undefined {
  const result = asRecord(value);
  const audit = asRecord(result.auditRecord);
  const input = asRecord(audit.input);
  const capability = asRecord(input.capability);
  const selectionInput = asRecord(capability.input);
  return typeof selectionInput.query === "string" ? selectionInput.query : undefined;
}

async function providerEvidence(config: QualificationConfig): Promise<string> {
  return (await remote(config, `test ! -f ${shell(`${config.remoteRoot}/runtime/provider.ndjson`)} || cat ${shell(`${config.remoteRoot}/runtime/provider.ndjson`)}`)).stdout;
}

async function waitForRemoteMatch(config: QualificationConfig, relative: string, pattern: RegExp, minimumOccurrences = 1): Promise<void> {
  const signal = AbortSignal.timeout(120_000);
  while (!signal.aborted) {
    const text = (await remote(config, `test ! -f ${shell(`${config.remoteRoot}/runtime/${relative}`)} || cat ${shell(`${config.remoteRoot}/runtime/${relative}`)}`)).stdout;
    if (matchCount(text, pattern) >= minimumOccurrences) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Remote evidence did not match ${pattern}.`);
}

async function remoteMatchCount(config: QualificationConfig, relative: string, pattern: RegExp): Promise<number> {
  const text = (await remote(config, `test ! -f ${shell(`${config.remoteRoot}/runtime/${relative}`)} || cat ${shell(`${config.remoteRoot}/runtime/${relative}`)}`)).stdout;
  return matchCount(text, pattern);
}

function matchCount(value: string, pattern: RegExp): number {
  return value.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))?.length ?? 0;
}

async function armCheckpoint(config: QualificationConfig, checkpoint: string): Promise<string> {
  const nonce = randomUUID();
  await uploadText(config, `${config.controlToken}\n${nonce}\n`, `${config.remoteRoot}/runtime/control/${checkpoint}.pause`);
  return nonce;
}

async function recoverRunIdentity(config: QualificationConfig, checkpoint: string): Promise<RunResult | undefined> {
  const text = (await remote(config, `test ! -f ${shell(`${config.remoteRoot}/runtime/control/events.ndjson`)} || cat ${shell(`${config.remoteRoot}/runtime/control/events.ndjson`)}`)).stdout;
  const event = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { checkpoint?: string; runId?: string; toolCallId?: string }).reverse().find((candidate) => candidate.checkpoint === checkpoint);
  if (!event?.runId || !event.toolCallId) return undefined;
  const sessionId = event.toolCallId.split(`:${event.runId}:`, 1)[0];
  return { runId: event.runId, sessionId, idempotencyKey: event.toolCallId, stream: "", parsed: parseQualificationRunStream("") };
}

async function writeEvidenceBundle(input: { artifactDir: string; config: QualificationConfig; startedAt: string; scenarios: ScenarioEvidence[]; cleanup: unknown; remoteFacts: unknown; providerSnapshot: string; lifecycleSnapshot: string }): Promise<void> {
  const safeConfig = {
    mode: input.config.mode,
    commit: input.config.commit,
    sshTargetHash: sha256(input.config.sshTarget),
    tenantId: input.config.tenantId,
    environmentId: input.config.environmentId,
    modelProvider: input.config.modelProvider,
    model: input.config.model,
  };
  const rawEvidence = { scenarios: input.scenarios, providerSnapshot: input.providerSnapshot, lifecycleSnapshot: input.lifecycleSnapshot };
  const secretLeakDetected = containsSecret(rawEvidence, input.config);
  if (secretLeakDetected) {
    input.scenarios.push(failedEvidence("evidence-secret-scan", "controlled", new Error("Qualification evidence contained secret material and was redacted before persistence.")));
  }
  const document = redactSecrets({
    version: 1,
    evidenceClass: "informational",
    evidenceLabels: ["hosted_runner_black_box", "live_provider", "controlled_provider"],
    signature: null,
    integrity: "sha256",
    startedAt: input.startedAt,
    completedAt: new Date().toISOString(),
    config: safeConfig,
    remoteFacts: input.remoteFacts,
    usage: {
      controlledProviderRequests: providerRequestCount(input.providerSnapshot),
      liveProviderRequests: "unavailable",
      modelUsage: "reported_in_public_run_evidence_when_available",
      estimatedCost: "not_estimated",
    },
    secretScan: { passed: !secretLeakDetected },
    scenarios: input.scenarios,
    providerEvidence: input.providerSnapshot.split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    lifecycleEvidence: input.lifecycleSnapshot.split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    cleanup: input.cleanup,
  }, input.config);
  await writeFile(path.join(input.artifactDir, "qualification.json"), `${canonical(document)}\n`, "utf8");
  const files = (await readdir(input.artifactDir)).filter((name) => name !== "manifest.json" && name !== "manifest.sha256").sort();
  const entries = [];
  for (const file of files) entries.push({ file, sha256: sha256(await readFile(path.join(input.artifactDir, file))) });
  const manifest = canonical({ version: 1, algorithm: "sha256", signed: false, files: entries });
  await writeFile(path.join(input.artifactDir, "manifest.json"), `${manifest}\n`, "utf8");
  await writeFile(path.join(input.artifactDir, "manifest.sha256"), `${sha256(manifest)}  manifest.json\n`, "utf8");
}

async function collectRemoteFacts(config: QualificationConfig): Promise<unknown> {
  const osFact = config.hostMode === "local" ? "sw_vers -productVersion" : ". /etc/os-release; printf '%s' \"$PRETTY_NAME\"";
  const output = await remote(config, `set -eu; printf 'os='; ${osFact}; printf '\\n'; printf 'kernel='; uname -r; printf 'arch='; uname -m; printf 'node='; node --version; printf 'pnpm='; pnpm --version; printf 'docker='; docker version --format '{{.Server.Version}}'`);
  return Object.fromEntries(output.stdout.trim().split("\n").map((line) => {
    const index = line.indexOf("=");
    return index < 0 ? [line, true] : [line.slice(0, index), line.slice(index + 1)];
  }));
}

async function remote(config: QualificationConfig, command: string) {
  if (config.hostMode === "local") return await execFileAsync("sh", ["-c", command], { maxBuffer: 16 * 1024 * 1024 });
  return await execFileAsync("ssh", sshArgs(config, [config.sshTarget, command]), { maxBuffer: 16 * 1024 * 1024 });
}

async function upload(config: QualificationConfig, source: string, destination: string): Promise<void> {
  await execFileAsync("scp", [...sshKeyArgs(config), source, `${config.sshTarget}:${destination}`]);
}

async function uploadText(config: QualificationConfig, content: string, destination: string): Promise<void> {
  if (config.hostMode === "local") {
    await writeFile(destination, content, { encoding: "utf8", mode: 0o600 });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ssh", sshArgs(config, [config.sshTarget, `umask 077; cat > ${shell(destination)}`]), { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`SSH upload failed (${code}): ${stderr}`)));
    child.stdin.end(content);
  });
}

async function openTunnel(config: QualificationConfig, localPort: number, remotePort: number): Promise<ChildProcess> {
  const child = spawn("ssh", sshArgs(config, ["-N", "-L", `${localPort}:127.0.0.1:${remotePort}`, config.sshTarget]), { stdio: ["ignore", "ignore", "pipe"] });
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (child.exitCode !== null) throw new Error("SSH runner tunnel exited during startup.");
  return child;
}

function sshArgs(config: QualificationConfig, tail: string[]): string[] {
  return [...sshKeyArgs(config), "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", ...tail];
}
function sshKeyArgs(config: QualificationConfig): string[] { return ["-i", config.sshKeyPath]; }

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve local tunnel port.");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function assertSecretFree(serialized: string, config: QualificationConfig): void {
  for (const secret of [config.tavilyKey, config.modelCredential, config.runnerToken, config.controlToken]) {
    if (secret.length > 0 && serialized.includes(secret)) throw new Error("Qualification public evidence contained secret material.");
  }
}
function containsSecret(value: unknown, config: QualificationConfig): boolean {
  if (typeof value === "string") {
    return qualificationSecrets(config).some((secret) => secret.length > 0 && value.includes(secret));
  }
  if (Array.isArray(value)) return value.some((item) => containsSecret(item, config));
  if (value && typeof value === "object") return Object.values(value).some((item) => containsSecret(item, config));
  return false;
}
function redactSecrets(value: unknown, config: QualificationConfig): unknown {
  if (typeof value === "string") {
    return qualificationSecrets(config).reduce((current, secret) => secret.length > 0 ? current.split(secret).join("[redacted:qualification-secret]") : current, value);
  }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, config));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSecrets(item, config)]));
  return value;
}
function qualificationSecrets(config: QualificationConfig): string[] {
  return [config.tavilyKey, config.modelCredential, config.runnerToken, config.controlToken];
}
function redactEvidence(value: string): string { return value.length <= 64_000 ? value : `${value.slice(0, 64_000)}\n[truncated]`; }
function providerRequestCount(value: string): number { return value.split("\n").filter((line) => line.includes('"kind":"provider_request"')).length; }
function requireMatch(value: string, pattern: RegExp, message: string): void { if (!pattern.test(value)) throw new Error(message); }
function requireNoMatch(value: string, pattern: RegExp, message: string): void { if (pattern.test(value)) throw new Error(message); }
function requireEqual(actual: unknown, expected: unknown, message: string): void { if (canonical(actual) !== canonical(expected)) throw new Error(`${message}: ${canonical({ actual, expected })}`); }
function requireTrue(value: boolean, message: string): asserts value { if (!value) throw new Error(message); }
function requireRun(value: boolean, result: RunResult, message: string): asserts value { if (!value) throw new QualificationRunAssertionError(result, message); }
function canonical(value: unknown): string { return JSON.stringify(sortValue(value)); }
function sortValue(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortValue); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortValue(item)])); return value; }
function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function shell(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }
function encodeEnv(value: string): string {
  if (value.includes("\0") || value.includes("\r") || value.includes("\n")) {
    throw new Error("Qualification environment values must be single-line strings.");
  }
  return shell(value);
}
function required(name: string): string { const value = process.env[name]?.trim(); if (!value) throw new Error(`Missing required variable ${name}.`); return value; }
function optional(name: string): string | undefined { const value = process.env[name]?.trim(); return value ? value : undefined; }
function validateCredentialName(value: string): string { if (!/^(?:OPENAI|OPENROUTER|ANTHROPIC)_API_KEY$/u.test(value)) throw new Error("Unsupported qualification model credential name."); return value; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

void main().catch((error) => { process.stderr.write(`${errorMessage(error)}\n`); process.exitCode = 1; });
