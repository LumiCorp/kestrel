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
const QUALIFICATION_NETWORK_TARGETS = [
  "https://example.com",
  "http://qualification.invalid",
  "http://127.0.0.1:80",
  "http://10.255.255.1:80",
  "http://169.254.1.1:80",
  "http://169.254.169.254/latest/meta-data/",
] as const;
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
  let readinessSnapshot = "";
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
    readinessSnapshot = await remote(config, `test ! -f ${shell(`${config.remoteRoot}/runtime/readiness.json`)} || cat ${shell(`${config.remoteRoot}/runtime/readiness.json`)}`)
      .then((result) => result.stdout)
      .catch(() => "");
    lifecycleSnapshot = await remote(config, `test ! -f ${shell(`${config.remoteRoot}/runtime/control/events.ndjson`)} || cat ${shell(`${config.remoteRoot}/runtime/control/events.ndjson`)}`)
      .then((result) => result.stdout)
      .catch(() => "");
    cleanup = await cleanupRemote(config).catch((error) => ({ ok: false, error: errorMessage(error) }));
    await writeEvidenceBundle({ artifactDir, config, startedAt, scenarios, cleanup, remoteFacts, providerSnapshot, lifecycleSnapshot, readinessSnapshot });
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
    await requireCapabilityLease(client, result, { status: "cleaned", remainingRequests: 1 });
    return result;
  });
  await capture(evidence, "provider-used", "controlled", async () => {
    const result = await client.run(profileId, "provider-used");
    requireTrue(hasTerminalEvent(result.parsed, "run.completed"), "provider-used run did not complete");
    const observations = result.parsed.codeResults.flatMap((item) => parseNetworkObservations(readCodeStdout(item)));
    requireEqual(observations.map((item) => item.url).sort(), QUALIFICATION_NETWORK_TARGETS.slice().sort(), "controlled network probe inventory changed");
    requireTrue(observations.every((item) => item.outcome === "blocked"), `controlled sandbox unexpectedly reached a direct-network target: ${canonical(observations)}`);
    requireMatch(await providerEvidence(config), /qualification-provider-used/u, "controlled provider was not contacted");
    assertSecretFree(result.stream, config);
    await requireCapabilityLease(client, result, { status: "cleaned", remainingRequests: 0 });
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
    await requireCapabilityLease(client, result, { status: "cleaned", terminalReason: "provider_invocation_timeout" });
    return result;
  });
  const expiryProfile = await client.resolveProfile(config, "controlled", { timeoutMs: 2_000, maxExpiryMs: 100 });
  await capture(evidence, "expiry", "controlled", async () => {
    const result = await client.run(expiryProfile, "expiry");
    await requireCapabilityLease(client, result, { status: "cleaned", terminalReason: "lease_expired" });
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
    const before = providerRequestCount(await providerEvidence(config));
    const result = await client.run(profileId, "concurrency");
    const after = providerRequestCount(await providerEvidence(config));
    requireRun(after - before === 1, result, "concurrent consumers did not produce exactly one provider request");
    const outcomes = readConcurrencyOutcomes(result);
    requireRun(outcomes.length === 2, result, "concurrent capability evidence did not contain two consumer outcomes");
    requireRun(outcomes.filter((outcome) => outcome.status === 200).length === 1, result, "concurrent capability consumers did not produce exactly one winner");
    requireRun(outcomes.filter((outcome) => outcome.status === 429 && asRecord(outcome.body).error === "request_ceiling_reached").length === 1, result, "concurrent capability loser was not denied by the request ceiling");
    await requireCapabilityLease(client, result, { status: "cleaned", remainingRequests: 0 });
    return result;
  });
}

async function runLiveJourney(config: QualificationConfig, port: number, evidence: ScenarioEvidence[]): Promise<void> {
  const client = new PublicRunnerClient(port, config.runnerToken, config.tenantId);
  const profileId = await client.resolveProfile(config, "live", { timeoutMs: 10_000, maxExpiryMs: 60_000 });
  await capture(evidence, "live-tavily", "live", async () => {
    const marker = `kestrel-live-${randomUUID()}`;
    const providerBefore = providerRequestCount(await providerEvidence(config));
    const result = await client.run(profileId, `provider-used ${marker}`);
    if (!hasTerminalEvent(result.parsed, "run.completed")) {
      throw new QualificationRunAssertionError(result, classifyLiveTerminalFailure(result.parsed));
    }
    const toolNames = readStartedToolNames(result.parsed);
    const executions = toolNames.filter((name) => name === "code.execute");
    requireRun(executions.length === 1, result, executions.length === 0
      ? "MODEL_DID_NOT_SELECT_CAPABILITY: Luna completed without selecting the required Tavily capability"
      : "MODEL_SELECTED_MULTIPLE_CODE_EXECUTIONS: Luna selected code.execute more than once");
    requireRun(
      toolNames.every((name) => name === "code.execute" || name === "effect_result_lookup" || name === "FinalizeAnswer"),
      result,
      "MODEL_SELECTED_UNAUTHORIZED_NETWORK_TOOL: live journey selected an additional tool",
    );
    if (result.parsed.codeResults.length === 1) {
      const executionFailure = classifyCodeExecutionFailure(result.parsed.codeResults[0]!);
      if (executionFailure !== undefined) throw new QualificationRunAssertionError(result, executionFailure);
    }
    if (result.parsed.codeResults.length !== 1 || readCapabilityReplayEvidence(result.parsed.codeResults[0]!) === undefined) {
      throw new QualificationRunAssertionError(result, "MODEL_CAPABILITY_RESULT_MISSING: selected code.execute did not produce capability replay evidence");
    }
    requireExactNetworkConfinement(result, parseNetworkObservations(readCodeStdout(result.parsed.codeResults[0]!)));
    assertSecretFree(result.stream, config);
    const exact = await client.getExactResult(result);
    requireRun(readExactCapabilityQuery(exact) === marker, result, "live exact result did not bind the unique Tavily query marker");
    const providerAfter = providerRequestCount(await providerEvidence(config));
    requireRun(providerAfter - providerBefore === 1, result, "live journey did not produce exactly one Tavily provider request");
    requireRun(await hasProviderMarkerReceipt(config, marker), result, "live Tavily receipt did not bind the selected query marker");
    const lease = await requireCapabilityLease(client, result, { status: "cleaned", remainingRequests: 0 });
    result.profileId = profileId;
    result.structuralEvidence = [{
      resolvedProfileId: profileId,
      exactContract: summarizeExactCapabilityContract(exact),
      providerMarkerDigest: createHash("sha256").update(marker).digest("hex"),
      lease,
    }];
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

interface RunResult {
  stream: string;
  parsed: ParsedQualificationRun;
  runId: string;
  sessionId: string;
  idempotencyKey?: string;
  profileId?: string;
  structuralEvidence?: unknown[];
}

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
    const liveMarker = mode.startsWith("provider-used ") ? mode.slice("provider-used ".length) : undefined;
    const promise = this.streamCommand(identity.commandId ?? `qualification-${mode}-${randomUUID()}`, {
      profileId,
      turn: {
        sessionId,
        message: liveMarker !== undefined
          ? `qualification live provider journey. UNIQUE_QUERY_MARKER=${JSON.stringify(liveMarker)}. The capability input.query and broker input.query must equal only that exact quoted marker, with no prefix or suffix. You must use code.execute exactly once, with language javascript, and select the advertised V2 tavily.search.read capability. The sandbox has no direct network access. In that one execution, probe all exact URLs ${JSON.stringify(QUALIFICATION_NETWORK_TARGETS)} concurrently with Promise.all and an independent AbortSignal.timeout(500) for each fetch; do not probe them sequentially. Print one DIRECT_NETWORK_BLOCKED:{"url":"...","error":"..."} line for every rejection or DIRECT_NETWORK_UNEXPECTED:{"url":"...","status":0} if any succeeds. After Promise.all settles, POST {"operation":"search","destination":"api.tavily.com","input":{"query":${JSON.stringify(liveMarker)},"maxResults":1}} to http://127.0.0.1:43127/v1/capability with AbortSignal.timeout(5000) and print its JSON response. Do not use any other tool or network destination.`
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
    const controller = new AbortController();
    const watchdog = setTimeout(() => controller.abort(new QualificationStreamTimeoutError()), 120_000);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/commands/stream`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify({ id, type: "run.start", metadata: this.metadata(), payload }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(watchdog);
      throw new PartialRunError(readRunResult("", sessionId), controller.signal.aborted ? controller.signal.reason : error);
    }
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
      throw new PartialRunError(readRunResult(stream, sessionId), controller.signal.aborted ? controller.signal.reason : error);
    } finally {
      clearTimeout(watchdog);
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

class QualificationStreamTimeoutError extends Error {
  readonly code = "LIVE_RUN_STREAM_TIMEOUT";
  constructor() { super("LIVE_RUN_STREAM_TIMEOUT: public run stream exceeded the qualification watchdog"); }
}

class QualificationRunAssertionError extends Error {
  constructor(readonly result: RunResult, message: string, readonly supplementalEvidence: unknown[] = []) { super(message); }
}

function readRunResult(stream: string, sessionId: string): RunResult {
  const parsed = parseQualificationRunStream(stream);
  return { stream, parsed, runId: parsed.runId, sessionId, ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}) };
}

async function capture(evidence: ScenarioEvidence[], name: string, mode: "live" | "controlled", run: () => Promise<RunResult>): Promise<void> {
  const startedAt = new Date().toISOString();
  try {
    const result = await run();
    evidence.push({ name, mode, status: "passed", startedAt, completedAt: new Date().toISOString(), runId: result.runId, sessionId: result.sessionId, idempotencyKey: result.idempotencyKey, assertions: ["public_terminal_state", "secret_scan"], publicEvidence: [redactEvidence(result.stream), ...(result.structuralEvidence ?? []).map(redactEvidence)] });
  } catch (error) {
    const failed = failedEvidence(name, mode, error, startedAt);
    if (error instanceof QualificationRunAssertionError || error instanceof PartialRunError) {
      failed.runId = error.result.runId;
      failed.sessionId = error.result.sessionId;
      failed.idempotencyKey = error.result.idempotencyKey;
      failed.publicEvidence = [
        summarizePublicRun(error.result),
        ...(error instanceof QualificationRunAssertionError ? error.supplementalEvidence : []),
      ];
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
    KESTREL_QUALIFICATION_READINESS_EVIDENCE: `${config.remoteRoot}/runtime/readiness.json`,
    KESTREL_QUALIFICATION_MODEL: config.model,
    ...(!credentials ? { KESTREL_QUALIFICATION_REPLAY_ONLY: "1" } : {}),
    ...(credentials ? {
      KESTREL_SANDBOX_TAVILY_CREDENTIAL: config.tavilyKey,
      KESTREL_SANDBOX_TAVILY_CREDENTIAL_REVISION: "qualification-live-r1",
      [config.modelCredentialName]: mode === "controlled" ? "qualification-model-key" : config.modelCredential,
    } : {}),
    ...(mode === "controlled" ? { OPENROUTER_BASE_URL: "http://127.0.0.1:43191" } : {}),
    ...(!credentials && config.hostMode === "local" ? { DOCKER_HOST: "unix:///tmp/kestrel-qualification-docker-unavailable.sock" } : {}),
  };
  await uploadText(config, Object.entries(env).map(([key, value]) => `${key}=${encodeEnv(value)}`).join("\n") + "\n", `${config.remoteRoot}/runtime/runner.env`);
  const entrypoint = "dist/cli/runner/qualification-service.js";
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
    const readiness = await remote(config, `test ! -f ${shell(`${config.remoteRoot}/runtime/readiness.json`)} || tail -n 1 ${shell(`${config.remoteRoot}/runtime/readiness.json`)}`)
      .then((result) => result.stdout.trim())
      .catch(() => "");
    if (readiness) {
      const record = asRecord(JSON.parse(readiness));
      if (record.status === "failed") {
        throw new Error(`${String(record.code ?? "LIVE_READINESS_FAILED")}: qualification readiness failed before inference`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const logs = await remote(config, `for f in ${shell(`${config.remoteRoot}/runtime/runner.log`)} ${shell(`${config.remoteRoot}/runtime/model.log`)}; do test ! -f "$f" || tail -n 80 "$f"; done`).then((result) => result.stdout).catch(() => "");
  throw new Error(`Qualification runner health check timed out.${logs ? `\n${logs}` : ""}`);
}

async function requireCapabilityLease(
  client: PublicRunnerClient,
  result: RunResult,
  expected: { status?: string; remainingRequests?: number; terminalReason?: string },
): Promise<Record<string, unknown>> {
  let response: Record<string, unknown> = {};
  try {
    response = asRecord(await client.operatorRun(result.runId));
  } catch (error) {
    throw new QualificationRunAssertionError(result, `Operator lifecycle lookup failed: ${errorMessage(error)}`);
  }
  const payload = asRecord(response.payload);
  const view = asRecord(payload.view);
  const report = asRecord(view.sandboxCapabilities);
  const leases = Array.isArray(report.leases) ? report.leases.map(asRecord) : [];
  if (leases.length !== 1) throw new QualificationRunAssertionError(result, `Operator projection exposed ${leases.length} capability leases; expected exactly one.`, [{ operatorProjection: response }]);
  const lease = leases[0]!;
  for (const [field, value] of Object.entries(expected)) {
    if (lease[field] !== value) throw new QualificationRunAssertionError(result, `Operator capability ${field} mismatch: expected ${JSON.stringify(value)}, received ${JSON.stringify(lease[field])}.`, [{ operatorProjection: response }]);
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
  const toolStarts = result.parsed.events.flatMap((event) => {
    if (event.type !== "run.tool.started") return [];
    const update = asRecord(asRecord(event.payload).update);
    return [{ toolName: update.toolName, toolCallId: update.toolCallId, input: update.input }];
  });
  const progress = result.parsed.events.filter((event) => event.type === "run.progress").at(-1);
  return {
    terminalEvents: result.parsed.events.filter((event) => event.type === "run.completed" || event.type === "run.cancelled" || event.type === "run.failed").map((event) => ({ type: event.type, runId: event.runId, payload: event.payload })),
    toolStarts,
    ...(progress === undefined ? {} : { lastProgress: progress }),
    codeResults: result.parsed.codeResults.map((item) => ({ stdout: item.stdout.slice(0, 4_000), capabilityReplayEvidence: item.capabilityReplayEvidence })),
  };
}

function classifyLiveTerminalFailure(run: ParsedQualificationRun): string {
  const failed = run.events.find((event) => event.type === "run.failed");
  if (failed === undefined) return "LIVE_RUN_MISSING_TERMINAL: live stream ended without a terminal event";
  const payload = asRecord(failed.payload);
  const error = asRecord(payload.error);
  const code = typeof error.code === "string" ? error.code : "LIVE_RUN_FAILED";
  return `${code}: live Luna journey failed before exact capability completion`;
}

function classifyCodeExecutionFailure(value: unknown): string | undefined {
  const result = asRecord(value);
  if (result.status === "timeout") return "TOOL_EXECUTION_TIMEOUT: code.execute exceeded its admitted sandbox timeout before exact capability completion";
  if (result.status === "cancelled") return "TOOL_EXECUTION_CANCELLED: code.execute was cancelled before exact capability completion";
  if (result.status === "error") return "TOOL_EXECUTION_FAILED: code.execute failed before exact capability completion";
  return undefined;
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

function summarizeExactCapabilityContract(value: unknown): Record<string, unknown> {
  const result = asRecord(value);
  const activation = asRecord(result.activation);
  const descriptor = asRecord(activation.descriptor);
  const audit = asRecord(result.auditRecord);
  const input = asRecord(audit.input);
  const capability = asRecord(input.capability);
  return {
    toolName: result.toolName,
    contractRevision: activation.contractRevision,
    inputSchemaHash: descriptor.inputSchemaHash,
    outputSchemaHash: descriptor.outputSchemaHash,
    adapterId: capability.capabilityId,
    operation: capability.operation,
    resource: capability.resource,
    effectClass: capability.effectClass,
    selectionDigest: createHash("sha256").update(canonical(capability)).digest("hex"),
  };
}

function readConcurrencyOutcomes(result: RunResult): Array<{ status: number; body: unknown }> {
  for (const codeResult of result.parsed.codeResults) {
    for (const line of codeResult.stdout.split(/\r?\n/u)) {
      if (!line.startsWith("CAPABILITY_CONCURRENCY:")) continue;
      const value = JSON.parse(line.slice("CAPABILITY_CONCURRENCY:".length)) as unknown;
      if (!Array.isArray(value)) return [];
      return value.flatMap((item) => {
        const record = asRecord(item);
        return typeof record.status === "number" ? [{ status: record.status, body: record.body }] : [];
      });
    }
  }
  return [];
}

async function providerEvidence(config: QualificationConfig): Promise<string> {
  return (await remote(config, `test ! -f ${shell(`${config.remoteRoot}/runtime/provider.ndjson`)} || cat ${shell(`${config.remoteRoot}/runtime/provider.ndjson`)}`)).stdout;
}

async function hasProviderMarkerReceipt(config: QualificationConfig, marker: string): Promise<boolean> {
  const expected = `sha256:${sha256(marker)}`;
  return (await providerEvidence(config)).split("\n").filter(Boolean).some((line) => {
    const record = asRecord(JSON.parse(line) as unknown);
    return record.kind === "provider_request" && record.mode === "live" && record.queryDigest === expected;
  });
}

function readStartedToolNames(run: ParsedQualificationRun): string[] {
  return run.events.flatMap((event) => {
    if (event.type !== "run.tool.started") return [];
    const update = asRecord(asRecord(event.payload).update);
    return typeof update.toolName === "string" ? [update.toolName] : [];
  });
}

function requireExactNetworkConfinement(result: RunResult, observations: ReturnType<typeof parseNetworkObservations>): void {
  requireRun(
    canonical(observations.map((item) => item.url).sort()) === canonical(QUALIFICATION_NETWORK_TARGETS.slice().sort()),
    result,
    `live sandbox network probe inventory changed: ${canonical(observations)}`,
  );
  requireRun(
    observations.every((item) => item.outcome === "blocked"),
    result,
    `live sandbox unexpectedly reached a direct-network target: ${canonical(observations)}`,
  );
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

async function writeEvidenceBundle(input: { artifactDir: string; config: QualificationConfig; startedAt: string; scenarios: ScenarioEvidence[]; cleanup: unknown; remoteFacts: unknown; providerSnapshot: string; lifecycleSnapshot: string; readinessSnapshot: string }): Promise<void> {
  const safeConfig = {
    mode: input.config.mode,
    commit: input.config.commit,
    sshTargetHash: sha256(input.config.sshTarget),
    tenantId: input.config.tenantId,
    environmentId: input.config.environmentId,
    modelProvider: input.config.modelProvider,
    model: input.config.model,
  };
  const rawEvidence = { scenarios: input.scenarios, providerSnapshot: input.providerSnapshot, lifecycleSnapshot: input.lifecycleSnapshot, readinessSnapshot: input.readinessSnapshot };
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
      controlledProviderRequests: providerRequestCount(input.providerSnapshot, "controlled"),
      liveProviderRequests: providerRequestCount(input.providerSnapshot, "live"),
      modelUsage: "reported_in_public_run_evidence_when_available",
      estimatedCost: "not_estimated",
    },
    secretScan: { passed: !secretLeakDetected },
    scenarios: input.scenarios,
    providerEvidence: input.providerSnapshot.split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    lifecycleEvidence: input.lifecycleSnapshot.split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    readinessEvidence: input.readinessSnapshot.split("\n").filter(Boolean).map((line) => JSON.parse(line)),
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
function providerRequestCount(value: string, mode?: "live" | "controlled"): number {
  return value.split("\n").filter(Boolean).filter((line) => {
    const record = asRecord(JSON.parse(line) as unknown);
    return record.kind === "provider_request" && (mode === undefined || record.mode === mode);
  }).length;
}
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
