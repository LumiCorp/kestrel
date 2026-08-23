import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import { createServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";

import {
  EXECUTION_PROTOCOL_VERSION,
  RUNNER_CAPABILITIES,
  RUNNER_COMMAND_CONTRACT_VERSION,
  RUNNER_EVENT_CONTRACT_VERSION,
} from "../../packages/protocol/src/index.js";
import { LocalCoreClient } from "../../src/localCore/client.js";
import { resolveLocalCorePaths } from "../../src/localCore/home.js";
import { DEFAULT_CODE_MODE_ENABLED_CONFIG } from "../../src/code/contracts.js";
import type { TuiProfile } from "../../cli/contracts.js";


const execFileAsync = promisify(execFile);
const KESTREL_SUITE_VERSION = (
  createRequire(import.meta.url)("../../package.json") as { version: string }
).version;

test("kestrel web prints env exports and answers curl health checks", async (t) => {
  await ensureCurlAvailable();

  const runner = await startWebRunner(t);
  assert.match(runner.startupOutput, /"type":"runner\.service\.started"/u);
  assert.equal(runner.url, `http://127.0.0.1:${runner.port}`);
  assert.match(runner.token, /^[0-9a-f]{48}$/u);

  const health = await runCurlJson({
    url: `${runner.url}/health`,
  });

  assert.equal(health.status, 200);
  assert.deepEqual(health.body, {
    version: "runner-health-v1",
    ok: true,
    service: {
      name: "kestrel-runner",
      version: KESTREL_SUITE_VERSION,
    },
    contracts: {
      execution: EXECUTION_PROTOCOL_VERSION,
      command: RUNNER_COMMAND_CONTRACT_VERSION,
      events: RUNNER_EVENT_CONTRACT_VERSION,
    },
    capabilities: [...RUNNER_CAPABILITIES],
  });
});

test("kestrel web rejects unauthenticated curl command requests", async (t) => {
  await ensureCurlAvailable();

  const runner = await startWebRunner(t);
  const unauthorized = await runCurlJson({
    url: `${runner.url}/commands`,
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      id: "cmd-web-unauthorized",
      type: "runner.ping",
      metadata: {
        actor: {
          actorId: "user-1",
          actorType: "operator",
          tenantId: "internal",
        },
        tenantId: "internal",
      },
      payload: {
        nonce: "ok",
      },
    }),
  });

  assert.equal(unauthorized.status, 401);
  const unauthorizedBody = unauthorized.body as {
    type?: string;
    payload?: { message?: string | undefined } | undefined;
  };
  assert.equal(unauthorizedBody.type, "runner.error");
  assert.match(String(unauthorizedBody.payload?.message ?? ""), /authorization is required/i);
});

test("kestrel web answers authenticated curl runner.ping requests", async (t) => {
  await ensureCurlAvailable();

  const runner = await startWebRunner(t);
  const ping = await runCurlJson({
    url: `${runner.url}/commands`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${runner.token}`,
    },
    body: JSON.stringify({
      id: "cmd-web-ping",
      type: "runner.ping",
      metadata: {
        actor: {
          actorId: "user-1",
          actorType: "operator",
          tenantId: "internal",
        },
        tenantId: "internal",
      },
      payload: {
        nonce: "ok",
      },
    }),
  });

  assert.equal(ping.status, 200);
  const pingBody = ping.body as {
    type?: string;
    id?: string | undefined;
    ts?: string | undefined;
    payload?: { nonce?: string | undefined } | undefined;
  };
  assert.equal(pingBody.type, "runner.pong");
  assert.match(String(pingBody.id ?? ""), /./u);
  assert.match(String(pingBody.ts ?? ""), /\d{4}-\d{2}-\d{2}T/u);
  assert.equal(pingBody.payload?.nonce, "ok");
});

test("kestrel web loads project provider credentials before starting Local Core", async () => {
  const root = await mkdtemp(path.join("/tmp", "kestrel-web-dotenv-"));
  const cwd = path.join(root, "project");
  const coreHome = path.join(root, "core-home");
  const corePaths = resolveLocalCorePaths(coreHome);
  await mkdir(cwd, { recursive: true });
  await writeFile(path.join(cwd, ".env"), "OPENROUTER_API_KEY=dotenv-openrouter-key\n", "utf8");
  const port = await reservePort();
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    KESTREL_CORE_HOME: coreHome,
    KESTREL_HOME: coreHome,
    // This test exercises project dotenv capture. macOS Local Core deliberately
    // makes Keychain authoritative, so use the portable ambient-credential
    // boundary instead of depending on credentials from the developer's
    // personal Keychain.
    KESTREL_CORE_PLATFORM: "linux",
    KESTREL_LOCAL_CORE_DIRECT: "0",
    KESTREL_CORE_IDLE_TIMEOUT_MS: "600000",
    FORCE_COLOR: "0",
  };
  delete childEnv.OPENROUTER_API_KEY;
  delete childEnv.KESTREL_DISABLE_DOTENV;
  delete childEnv.KESTREL_LOCAL_CORE_API_SOCKET;
  delete childEnv.KESTREL_LOCAL_CORE_API_TOKEN;

  const child = spawn(
    process.execPath,
    [
      "--import",
      createRequire(import.meta.url).resolve("tsx"),
      path.resolve(process.cwd(), "cli/tui.ts"),
      "web",
      "--port",
      String(port),
    ],
    { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk.toString("utf8")));
  const exitPromise = waitForClose(child);

  try {
    await waitForOutput(stdoutChunks, /export KESTREL_RUNNER_SERVICE_TOKEN=/u);
    const coreToken = (await readFile(corePaths.apiTokenPath, "utf8")).trim();
    const client = new LocalCoreClient({ socketPath: corePaths.apiSocketPath, token: coreToken });
    const readiness = await client.providerReadiness() as {
      providerReadiness?: { openrouter?: { ready?: boolean | undefined } | undefined } | undefined;
    };
    assert.equal(readiness.providerReadiness?.openrouter?.ready, true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGINT");
    }
    const exit = await exitPromise;
    await stopLocalCoreFromLock(corePaths.lockPath);
    await rm(root, { recursive: true, force: true });
    assert.equal(exit.code, 0, stderrChunks.join(""));
  }
});

test("kestrel web runs quick chat-lane agent interactions against a fake model backend", async (t) => {
  await ensureCurlAvailable();

  const fakeModel = await startFakeOpenRouterServer();
  t.after(async () => {
    await fakeModel.close();
  });

  const runner = await startWebRunner(t, {
    OPENROUTER_API_KEY: "test-openrouter-key",
    OPENROUTER_MODEL: "openai/gpt-5.2-chat",
    OPENROUTER_BASE_URL: fakeModel.url,
  });

  const listed = await runCurlJson({
    url: `${runner.url}/commands`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${runner.token}`,
    },
    body: JSON.stringify({
      id: "cmd-web-profile-list",
      type: "profile.list",
      metadata: {
        actor: {
          actorId: "user-1",
          actorType: "operator",
          tenantId: "internal",
        },
        tenantId: "internal",
      },
      payload: {},
    }),
  });

  assert.equal(listed.status, 200);
  const listedBody = listed.body as {
    type?: string;
    payload?: {
      profiles?: Array<{
        id?: string | undefined;
        agent?: string | undefined;
        modelProvider?: string | undefined;
        default?: boolean | undefined;
      }> | undefined;
    } | undefined;
  };
  assert.equal(listedBody.type, "profile.listed");
  const availableProfiles = listedBody.payload?.profiles ?? [];
  const selectedProfile = availableProfiles.find(
    (item) =>
      item.agent === "kestrel" &&
      item.default === true &&
      (item.modelProvider === "openrouter" || item.modelProvider === undefined),
  );

  assert.notEqual(
    selectedProfile,
    undefined,
    `Expected an openrouter-backed Kestrel profile, got ${JSON.stringify(availableProfiles)}`,
  );
  if (selectedProfile === undefined) {
    throw new Error(`Expected an openrouter-backed Kestrel profile, got ${JSON.stringify(availableProfiles)}`);
  }
  const profileId = selectedProfile.id;
  const greetingSessionId = `session-web-chat-greeting-${randomUUID()}`;
  const capabilitiesSessionId = `session-web-chat-capabilities-${randomUUID()}`;

  const actorMetadata = {
    actor: {
      actorId: "user-1",
      actorType: "end_user",
      displayName: "Web Runner Test User",
      tenantId: "internal",
    },
    tenantId: "internal",
  };

  const greeting = await runCurlText({
    url: `${runner.url}/commands/stream`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${runner.token}`,
    },
    body: JSON.stringify({
      id: "cmd-web-chat-greeting",
      type: "run.start",
      metadata: actorMetadata,
      payload: {
        profileId,
        turn: {
          sessionId: greetingSessionId,
          message: "hiya",
          eventType: "user.message",
        },
      },
    }),
  });

  assert.equal(greeting.status, 200);
  assert.match(greeting.body, /event: run\.started/u);
  assert.match(greeting.body, /event: run\.completed/u);
  assert.match(greeting.body, /Hello from the fake web runner chat path\./u);

  const capabilities = await runCurlText({
    url: `${runner.url}/commands/stream`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${runner.token}`,
    },
    body: JSON.stringify({
      id: "cmd-web-chat-capabilities",
      type: "run.start",
      metadata: actorMetadata,
      payload: {
        profileId,
        turn: {
          sessionId: capabilitiesSessionId,
          message: "what tools do you have",
          eventType: "user.message",
        },
      },
    }),
  });

  assert.equal(capabilities.status, 200);
  assert.match(capabilities.body, /event: run\.started/u);
  assert.match(capabilities.body, /event: run\.completed/u);
  assert.match(capabilities.body, /I can help with chat responses in this deterministic test harness\./u);

  assert.deepEqual(
    fakeModel.requests.map((item) => item.schemaName),
    [
      "tool_call",
      "tool_call",
    ],
  );
  assert.equal(fakeModel.requests.length, 2);
  assert.equal(fakeModel.requests[0]?.userMessage, "hiya");
  assert.equal(fakeModel.requests[1]?.userMessage, "what tools do you have");
});

test("spawned Local Core executes an immutable capability profile through Docker and isolated provider transport", async (t) => {
  try { await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"]); }
  catch { t.skip("Docker daemon is required for capability process qualification"); return; }
  const fakeModel = await startFakeOpenRouterServer();
  t.after(async () => await fakeModel.close());
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-local-capability-"));
  const evidencePath = path.join(evidenceRoot, "provider.ndjson");
  const tenantId = "qualification-tenant";
  const environmentId = "qualification-local";
  const authorityId = "qualification-broker";
  const authorityRevision = "qualification-r1";
  const sessionId = `qualification-${randomUUID()}`;
  const runner = await startWebRunner(t, {
    OPENROUTER_API_KEY: "fixture-model-key", OPENROUTER_BASE_URL: fakeModel.url,
    TAVILY_API_KEY: "isolated-tavily-secret", KESTREL_TENANT_ID: tenantId, KESTREL_ENVIRONMENT_ID: environmentId,
    KESTREL_SANDBOX_BROKER_AUTHORITY_ID: authorityId, KESTREL_SANDBOX_BROKER_AUTHORITY_REVISION: authorityRevision,
    KESTREL_TEST_SANDBOX_CAPABILITY_EVIDENCE: evidencePath,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${path.resolve(process.cwd(), "tests/fixtures/sandbox-capability-fetch-preload.mjs")}`.trim(),
  }, "SIGINT", async (client) => {
    const listed = await client.getJson("/v1/profiles") as { profiles: TuiProfile[] };
    const canonical = listed.profiles.find((profile) => profile.id === "kestrel");
    assert.ok(canonical);
    const capability = {
      version: 1 as const, capabilityId: "tavily.search.read" as const, operations: ["search"] as ["search"], resource: "https://api.tavily.com/search" as const,
      audience: { tenantId, environmentId }, maxRequests: 1 as const, maxQueryChars: 100, maxResults: 3, maxResponseBytes: 4096,
      timeoutMs: 200, maxExpiryMs: 20_000, brokerAuthority: { authorityId, revision: authorityRevision },
    };
    const expiryCapability = { ...capability, timeoutMs: 2_000, maxExpiryMs: 100 };
    await client.putJson("/v1/profiles", { profiles: [{ ...canonical, codeMode: { ...structuredClone(DEFAULT_CODE_MODE_ENABLED_CONFIG), capabilities: [expiryCapability] } }] });
    const expiryProfileId = (await client.resolveExecutionProfile({ client: "cli", profileId: "kestrel" })).profileId;
    await client.putJson("/v1/profiles", { profiles: [{ ...canonical, codeMode: { ...structuredClone(DEFAULT_CODE_MODE_ENABLED_CONFIG), capabilities: [capability] } }] });
    return { qualificationProfileId: (await client.resolveExecutionProfile({ client: "cli", profileId: "kestrel" })).profileId, expiryProfileId };
  });
  assert.match(runner.qualificationProfileId ?? "", /^kestrel:cli_safe_local:[a-f0-9]{64}$/u);
  const response = await runCurlText({
    url: `${runner.url}/commands/stream`, method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${runner.token}` },
    body: JSON.stringify({ id: "qualification-provider-used", type: "run.start", metadata: { actor: { actorId: "qualification", actorType: "operator", tenantId }, tenantId }, payload: { profileId: runner.qualificationProfileId, turn: { sessionId, message: "qualification provider-used", eventType: "user.message", interactionMode: "build", actSubmode: "full_auto", executionPolicy: { toolClassPolicy: { read_only: true, planning_write: true, sandboxed_only: true, external_side_effect: true }, capabilityPolicy: { "workspace.read": true, "workspace.write": true, "shell.exec": true, "code.execute": true, "network.call": true, "mcp.invoke": true, "external.confirm": true } } } } }),
  });
  assert.equal(response.status, 200);
  assert.match(response.body, /event: run\.completed/u);
  const evidence = await readFile(evidencePath, "utf8").catch(() => {
    throw new Error(`Provider not invoked. Stream tail:\n${response.body.slice(-10_000)}`);
  });
  assert.match(evidence, /qualification/u);
  assert.equal(evidence.includes("isolated-tavily-secret"), false);
  assert.equal(response.body.includes("isolated-tavily-secret"), false);
  assert.match(response.body, /capabilityReplayEvidence/u);
  assert.match(response.body, /"toolName":"code\.execute"/u);
  const providerEvidenceBeforeUnused = await readFile(evidencePath, "utf8");
  const unused = await runCapabilityQualification(runner, runner.qualificationProfileId!, tenantId, "selected-unused");
  assert.match(unused.body, /event: run\.completed/u);
  assert.match(unused.body, /selected capability intentionally unused/u);
  assert.match(unused.body, /capabilityReplayEvidence/u);
  assert.equal(await readFile(evidencePath, "utf8"), providerEvidenceBeforeUnused);
  assert.equal(unused.body.includes("isolated-tavily-secret"), false);
  await assertSelectedUnusedProjection(runner, unused.body, tenantId);
  const capabilityFree = await runCapabilityQualification(runner, runner.qualificationProfileId!, tenantId, "capability-free");
  assert.match(capabilityFree.body, /event: run\.completed/u);
  assert.doesNotMatch(capabilityFree.body, /capabilityReplayEvidence/u);
  assert.equal(await readFile(evidencePath, "utf8"), providerEvidenceBeforeUnused);
  await assertCancellationQualification(runner, runner.qualificationProfileId!, tenantId, evidencePath);
  const expired = await runCapabilityQualification(runner, runner.expiryProfileId!, tenantId, "expiry");
  assert.match(expired.body, /event: run\.completed/u);
  await assertCapabilityProjection(runner, expired.body, tenantId, 1, "expired");
  const timedOut = await runCapabilityQualification(runner, runner.qualificationProfileId!, tenantId, "timeout");
  assert.match(timedOut.body, /event: run\.completed/u);
  assert.match(timedOut.body, /capability_timeout/u);
  assert.equal(timedOut.body.includes("isolated-tavily-secret"), false);
  await waitForFileMatch(evidencePath, /"kind":"provider_abort","query":"qualification-timeout"/u);
  await assertCapabilityProjection(runner, timedOut.body, tenantId, 0, "provider_invocation_timeout");
  const completed = readSseEvent(response.body, "run.completed") as { runId?: string };
  assert.ok(completed.runId);
  const exactResultKey = response.body.match(/"idempotencyKey":"([^"]+)"/u)?.[1];
  assert.ok(exactResultKey);
  const lookup = async () => await runCurlJson({
    url: `${runner.url}/commands`, method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${runner.token}` },
    body: JSON.stringify({ id: `qualification-local-effect-${randomUUID()}`, type: "effect.result.get", metadata: { actor: { actorId: "qualification", actorType: "operator", tenantId }, tenantId }, payload: { sessionId, runId: completed.runId, idempotencyKey: exactResultKey } }),
  });
  const liveRead = await lookup();
  assert.equal(liveRead.status, 200, JSON.stringify(liveRead.body));
  const evidenceBeforeRestart = await readFile(evidencePath, "utf8");
  await runner.restartCore({ TAVILY_API_KEY: undefined, PATH: "/usr/bin:/bin" });
  const restartedRead = await lookup();
  assert.equal(restartedRead.status, 200, JSON.stringify(restartedRead.body));
  assert.deepEqual((restartedRead.body.payload as { result?: unknown }).result, (liveRead.body.payload as { result?: unknown }).result);
  assert.equal(await readFile(evidencePath, "utf8"), evidenceBeforeRestart);
});

test("spawned hosted runner executes a registered capability profile through Docker and isolated provider transport", async (t) => {
  try { await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"]); }
  catch { t.skip("Docker daemon is required for capability process qualification"); return; }
  const fakeModel = await startFakeOpenRouterServer();
  t.after(async () => await fakeModel.close());
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-hosted-capability-"));
  const evidencePath = path.join(evidenceRoot, "provider.ndjson");
  const tenantId = "qualification-hosted-tenant";
  const environmentId = "qualification-hosted";
  const authorityId = "qualification-hosted-broker";
  const authorityRevision = "qualification-hosted-r1";
  const sessionId = `qualification-hosted-${randomUUID()}`;
  const runner = await startHostedRunner(t, {
    OPENROUTER_API_KEY: "fixture-model-key", OPENROUTER_BASE_URL: fakeModel.url,
    KESTREL_TENANT_ID: tenantId, KESTREL_ENVIRONMENT_ID: environmentId,
    KESTREL_SANDBOX_BROKER_AUTHORITY_ID: authorityId, KESTREL_SANDBOX_BROKER_AUTHORITY_REVISION: authorityRevision,
    KESTREL_SANDBOX_TAVILY_CREDENTIAL: "isolated-tavily-secret", KESTREL_SANDBOX_TAVILY_CREDENTIAL_REVISION: "credential-r1",
    KESTREL_TEST_SANDBOX_CAPABILITY_EVIDENCE: evidencePath,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${path.resolve(process.cwd(), "tests/fixtures/sandbox-capability-fetch-preload.mjs")}`.trim(),
  });
  const capability = {
    version: 1 as const, capabilityId: "tavily.search.read" as const, operations: ["search"] as ["search"], resource: "https://api.tavily.com/search" as const,
    audience: { tenantId, environmentId }, maxRequests: 1 as const, maxQueryChars: 100, maxResults: 3, maxResponseBytes: 4096,
    timeoutMs: 200, maxExpiryMs: 20_000, brokerAuthority: { authorityId, revision: authorityRevision },
  };
  const resolved = await runCurlJson({
    url: `${runner.url}/commands`, method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${runner.token}` },
    body: JSON.stringify({ id: "qualification-hosted-resolve", type: "execution-profile.resolve", metadata: { actor: { actorId: "qualification", actorType: "operator", tenantId }, tenantId }, payload: { environmentPresetId: "workspace_hosted", managedConfiguration: { modelProvider: "openrouter", model: "openai/gpt-5.6-luna", codeMode: { ...structuredClone(DEFAULT_CODE_MODE_ENABLED_CONFIG), capabilities: [capability] } } } }),
  });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  const resolvedEvent = resolved.body as { type?: string; payload?: { profileId?: string } };
  assert.equal(resolvedEvent.type, "execution-profile.resolved");
  assert.match(resolvedEvent.payload?.profileId ?? "", /^kestrel:workspace_hosted:[a-f0-9]{64}$/u);
  const response = await runCurlText({
    url: `${runner.url}/commands/stream`, method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${runner.token}` },
    body: JSON.stringify({ id: "qualification-hosted-provider-used", type: "run.start", metadata: { actor: { actorId: "qualification", actorType: "operator", tenantId }, tenantId }, payload: { profileId: resolvedEvent.payload?.profileId, turn: { sessionId, message: "qualification provider-used", eventType: "user.message", interactionMode: "build", actSubmode: "full_auto", executionPolicy: { toolClassPolicy: { read_only: true, planning_write: true, sandboxed_only: true, external_side_effect: true }, capabilityPolicy: { "workspace.read": true, "workspace.write": true, "shell.exec": true, "code.execute": true, "network.call": true, "mcp.invoke": true, "external.confirm": true } } } } }),
  });
  assert.equal(response.status, 200);
  assert.match(response.body, /event: run\.completed/u);
  const evidence = await readFile(evidencePath, "utf8").catch(() => {
    throw new Error(`Provider not invoked. Stream tail:\n${response.body.slice(-10_000)}`);
  });
  assert.match(evidence, /qualification/u);
  assert.equal(evidence.includes("isolated-tavily-secret"), false);
  assert.equal(response.body.includes("isolated-tavily-secret"), false);
  assert.match(response.body, /capabilityReplayEvidence/u);
  assert.match(response.body, /"toolName":"code\.execute"/u);
  const providerEvidenceBeforeUnused = await readFile(evidencePath, "utf8");
  const unused = await runCapabilityQualification(runner, resolvedEvent.payload!.profileId!, tenantId, "selected-unused");
  assert.match(unused.body, /event: run\.completed/u);
  assert.match(unused.body, /selected capability intentionally unused/u);
  assert.match(unused.body, /capabilityReplayEvidence/u);
  assert.equal(await readFile(evidencePath, "utf8"), providerEvidenceBeforeUnused);
  await assertCancellationQualification(runner, resolvedEvent.payload!.profileId!, tenantId, evidencePath);
  const expiryResolved = await runCurlJson({ url: `${runner.url}/commands`, method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${runner.token}` }, body: JSON.stringify({ id: "qualification-hosted-expiry-resolve", type: "execution-profile.resolve", metadata: { actor: { actorId: "qualification", actorType: "operator", tenantId }, tenantId }, payload: { environmentPresetId: "workspace_hosted", managedConfiguration: { modelProvider: "openrouter", model: "openai/gpt-5.6-luna", codeMode: { ...structuredClone(DEFAULT_CODE_MODE_ENABLED_CONFIG), capabilities: [{ ...capability, timeoutMs: 2_000, maxExpiryMs: 100 }] } } } }) });
  const expiryProfileId = (expiryResolved.body.payload as { profileId?: string }).profileId;
  assert.ok(expiryProfileId);
  const expired = await runCapabilityQualification(runner, expiryProfileId, tenantId, "expiry");
  assert.match(expired.body, /event: run\.completed/u);
  await assertCapabilityProjection(runner, expired.body, tenantId, 1, "expired");
  const timedOut = await runCapabilityQualification(runner, resolvedEvent.payload!.profileId!, tenantId, "timeout");
  assert.match(timedOut.body, /event: run\.completed/u);
  assert.match(timedOut.body, /capability_timeout/u);
  assert.equal(timedOut.body.includes("isolated-tavily-secret"), false);
  await waitForFileMatch(evidencePath, /"kind":"provider_abort","query":"qualification-timeout"/u);
  await assertCapabilityProjection(runner, timedOut.body, tenantId, 0, "provider_invocation_timeout");
  assert.equal(unused.body.includes("isolated-tavily-secret"), false);
  await assertSelectedUnusedProjection(runner, unused.body, tenantId);
  const providerEvidenceBeforeCapabilityFree = await readFile(evidencePath, "utf8");
  const capabilityFree = await runCapabilityQualification(runner, resolvedEvent.payload!.profileId!, tenantId, "capability-free");
  assert.match(capabilityFree.body, /event: run\.completed/u);
  assert.doesNotMatch(capabilityFree.body, /capabilityReplayEvidence/u);
  assert.equal(await readFile(evidencePath, "utf8"), providerEvidenceBeforeCapabilityFree);
  const completed = readSseEvent(response.body, "run.completed") as { runId?: string };
  assert.ok(completed.runId);
  const exactResultKey = response.body.match(/"idempotencyKey":"([^"]+)"/u)?.[1];
  assert.ok(exactResultKey);
  const lookup = async () => await runCurlJson({
    url: `${runner.url}/commands`, method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${runner.token}` },
    body: JSON.stringify({ id: `qualification-hosted-effect-${randomUUID()}`, type: "effect.result.get", metadata: { actor: { actorId: "qualification", actorType: "operator", tenantId }, tenantId }, payload: { sessionId, runId: completed.runId, idempotencyKey: exactResultKey } }),
  });
  const liveRead = await lookup();
  assert.equal(liveRead.status, 200, JSON.stringify(liveRead.body));
  assert.equal(liveRead.body.type, "effect.result.loaded");
  const evidenceBeforeRestart = await readFile(evidencePath, "utf8");
  await runner.restart({ KESTREL_SANDBOX_TAVILY_CREDENTIAL: undefined, KESTREL_SANDBOX_TAVILY_CREDENTIAL_REVISION: undefined });
  const restartedHealth = await runCurlJson({
    url: `${runner.url}/health`,
    headers: { authorization: `Bearer ${runner.token}` },
  });
  assert.equal(restartedHealth.status, 200, JSON.stringify(restartedHealth.body));
  const restartedRead = await lookup().catch((error) => {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nHosted stderr:\n${runner.stderrOutput()}`);
  });
  assert.equal(restartedRead.status, 200, JSON.stringify(restartedRead.body));
  assert.deepEqual((restartedRead.body.payload as { result?: unknown }).result, (liveRead.body.payload as { result?: unknown }).result);
  assert.equal(await readFile(evidencePath, "utf8"), evidenceBeforeRestart);
});

test("kestrel web forces shutdown after the grace period when an event stream is still connected", async (t) => {
  const runner = await startWebRunner(
    t,
    {
      KESTREL_RUNNER_SERVICE_SHUTDOWN_GRACE_MS: "200",
    },
    false,
  );
  const subscription = await openEventSubscription(runner.url, runner.token, `session-web-shutdown-${randomUUID()}`);
  t.after(() => {
    subscription.close();
  });

  runner.signal("SIGINT");
  const exit = await runner.waitForExit();

  assert.equal(exit.code, 0);
  assert.match(runner.stderrOutput(), /shutting down gracefully/u);
  assert.match(runner.stderrOutput(), /shutdown grace period elapsed; forcing shutdown/u);
  assert.match(runner.stderrOutput(), /runner service stopped/u);
});

test("kestrel web forces shutdown immediately on a second signal", async (t) => {
  const runner = await startWebRunner(
    t,
    {
      KESTREL_RUNNER_SERVICE_SHUTDOWN_GRACE_MS: "5000",
    },
    false,
  );
  const subscription = await openEventSubscription(runner.url, runner.token, `session-web-signal-${randomUUID()}`);
  t.after(() => {
    subscription.close();
  });

  runner.signal("SIGINT");
  await runner.waitForStderr(/shutting down gracefully/u);
  runner.signal("SIGINT");
  const exit = await runner.waitForExit();

  assert.equal(exit.code, 0);
  assert.match(runner.stderrOutput(), /received another shutdown signal; forcing shutdown/u);
  assert.match(runner.stderrOutput(), /runner service stopped/u);
});

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Failed to reserve an ephemeral port."));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForOutput(chunks: string[], pattern: RegExp): Promise<string> {
  while (true) {
    const joined = chunks.join("");
    if (pattern.test(joined)) {
      return joined;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForClose(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

async function ensureCurlAvailable(): Promise<void> {
  try {
    await execFileAsync("curl", ["--version"], {
      cwd: process.cwd(),
      env: process.env,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`test:web-runner requires curl to be installed: ${message}`);
  }
}

async function runCapabilityQualification(
  runner: { url: string; token: string },
  profileId: string,
  tenantId: string,
  mode: "selected-unused" | "capability-free" | "timeout" | "expiry" | "cancel",
  sessionId = `qualification-${mode}-${randomUUID()}`,
): Promise<{ status: number; body: string }> {
  return await runCurlText({
    url: `${runner.url}/commands/stream`, method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${runner.token}` },
    body: JSON.stringify({ id: `qualification-${mode}-${randomUUID()}`, type: "run.start", metadata: { actor: { actorId: "qualification", actorType: "operator", tenantId }, tenantId }, payload: { profileId, turn: { sessionId, message: `qualification ${mode}`, eventType: "user.message", interactionMode: "build", actSubmode: "full_auto", executionPolicy: { toolClassPolicy: { read_only: true, planning_write: true, sandboxed_only: true, external_side_effect: true }, capabilityPolicy: { "workspace.read": true, "workspace.write": true, "shell.exec": true, "code.execute": true, "network.call": true, "mcp.invoke": true, "external.confirm": true } } } } }),
  });
}

async function assertSelectedUnusedProjection(
  runner: { url: string; token: string },
  runBody: string,
  tenantId: string,
): Promise<void> {
  await assertCapabilityProjection(runner, runBody, tenantId, 1);
}

async function assertCapabilityProjection(
  runner: { url: string; token: string },
  runBody: string,
  tenantId: string,
  remainingRequests: number,
  expectedTerminal?: string,
): Promise<void> {
  const terminalEvent = runBody.includes("event: run.cancelled") ? "run.cancelled" : runBody.includes("event: run.failed") ? "run.failed" : "run.completed";
  const runId = (readSseEvent(runBody, terminalEvent) as { runId?: string }).runId;
  assert.ok(runId);
  const projection = await runCurlJson({
    url: `${runner.url}/commands`, method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${runner.token}` },
    body: JSON.stringify({ id: `qualification-operator-run-${randomUUID()}`, type: "operator.run", metadata: { actor: { actorId: "qualification", actorType: "operator", tenantId }, tenantId }, payload: { runId } }),
  });
  assert.equal(projection.status, 200, JSON.stringify(projection.body));
  const sandbox = ((projection.body.payload as { view?: { sandboxCapabilities?: { leases?: Array<Record<string, unknown>> } } }).view?.sandboxCapabilities);
  assert.ok(sandbox);
  assert.equal(sandbox.leases?.length, 1);
  assert.equal(sandbox.leases?.[0]?.status, "cleaned");
  assert.equal(sandbox.leases?.[0]?.remainingRequests, remainingRequests);
  if (expectedTerminal !== undefined) assert.match(JSON.stringify(sandbox.leases?.[0]), new RegExp(expectedTerminal, "u"));
}

async function assertCancellationQualification(runner: { url: string; token: string }, profileId: string, tenantId: string, evidencePath: string): Promise<void> {
  const sessionId = `qualification-cancel-${randomUUID()}`;
  const pending = runCapabilityQualification(runner, profileId, tenantId, "cancel", sessionId);
  await waitForFileMatch(evidencePath, /"query":"qualification-cancel"/u);
  const cancelled = await runCurlJson({ url: `${runner.url}/commands`, method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${runner.token}` }, body: JSON.stringify({ id: `qualification-cancel-command-${randomUUID()}`, type: "run.cancel", metadata: { actor: { actorId: "qualification", actorType: "operator", tenantId }, tenantId }, payload: { sessionId } }) });
  assert.equal(cancelled.body.type, "run.cancelled");
  const outcome = await pending;
  assert.match(outcome.body, /event: run\.cancelled/u);
  await waitForFileMatch(evidencePath, /"kind":"provider_abort","query":"qualification-cancel"/u);
  await assertCapabilityProjection(runner, outcome.body, tenantId, 0, "cancel");
  const runId = (readSseEvent(outcome.body, "run.cancelled") as { runId?: string }).runId;
  const idempotencyKey = outcome.body.match(/"idempotencyKey":"([^"]+)"/u)?.[1];
  assert.ok(runId && idempotencyKey);
  const replay = await runCurlJson({ url: `${runner.url}/commands`, method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${runner.token}` }, body: JSON.stringify({ id: `qualification-cancel-replay-${randomUUID()}`, type: "effect.result.get", metadata: { actor: { actorId: "qualification", actorType: "operator", tenantId }, tenantId }, payload: { sessionId, runId, idempotencyKey } }) });
  assert.equal(replay.body.type, "runner.error");
  assert.match(JSON.stringify(replay.body), /EFFECT_RESULT_(?:INCOMPLETE|NOT_FOUND)/u);
}

async function waitForFileMatch(filePath: string, pattern: RegExp): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (pattern.test(await readFile(filePath, "utf8").catch(() => ""))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${pattern}`);
}

async function startHostedRunner(
  t: TestContext,
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<{ url: string; token: string; restart(overrides?: NodeJS.ProcessEnv): Promise<void>; stderrOutput(): string }> {
  const repoRoot = process.cwd();
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-hosted-runner-"));
  const storeDir = path.join(root, "store");
  const home = path.join(root, "home");
  const port = await reservePort();
  const token = `qualification-${randomUUID()}`;
  const launch = (overrides: NodeJS.ProcessEnv = {}) => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const child = spawn(process.execPath, ["--import", "tsx", path.resolve(repoRoot, "cli/runner/service.ts")], {
      cwd: repoRoot,
      env: { ...process.env, ...envOverrides, ...overrides, KESTREL_HOME: home, KESTREL_DISABLE_DOTENV: "1", KESTREL_RUNNER_STORE_DIR: storeDir, KESTREL_RUNNER_SERVICE_HOST: "127.0.0.1", KESTREL_RUNNER_SERVICE_PORT: String(port), KESTREL_RUNNER_SERVICE_TOKEN: token, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk.toString("utf8")));
    return { child, stdoutChunks, stderrChunks, exitPromise: waitForClose(child) };
  };
  let current = launch();
  const waitForStartup = async () => {
    const timeout = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Hosted runner startup timed out:\n${current.stderrChunks.join("")}`)), 15_000);
      timer.unref();
    });
    await Promise.race([
      waitForOutput(current.stdoutChunks, /"type":"runner\.service\.started"/u),
      current.exitPromise.then((exit) => {
        throw new Error(`Hosted runner exited during startup (${JSON.stringify(exit)}):\n${current.stderrChunks.join("")}`);
      }),
      timeout,
    ]);
  };
  const stopCurrent = async () => {
    if (current.child.exitCode === null && current.child.signalCode === null) current.child.kill("SIGINT");
    const forceTimer = setTimeout(() => {
      if (current.child.exitCode === null && current.child.signalCode === null) current.child.kill("SIGKILL");
    }, 10_000);
    const exit = await current.exitPromise;
    clearTimeout(forceTimer);
    current.child.stdout.destroy();
    current.child.stderr.destroy();
    assert.ok(exit.code === 0 || exit.signal === "SIGKILL", current.stderrChunks.join(""));
    return exit;
  };
  t.after(async () => {
    await stopCurrent();
    await rm(root, { recursive: true, force: true });
  });
  await waitForStartup();
  if (current.child.exitCode !== null || current.child.signalCode !== null) {
    throw new Error(`Hosted runner exited during startup:\n${current.stderrChunks.join("")}`);
  }
  return { url: `http://127.0.0.1:${port}`, token, stderrOutput: () => current.stderrChunks.join(""), async restart(overrides = {}) {
    const stopped = await stopCurrent();
    assert.equal(stopped.code, 0, `Hosted runner did not close its persistent store cleanly: ${JSON.stringify(stopped)}`);
    current = launch(overrides);
    await waitForStartup();
  } };
}

async function startWebRunner(
  t: TestContext,
  envOverrides: NodeJS.ProcessEnv = {},
  autoShutdownSignal: NodeJS.Signals | false = "SIGINT",
  afterCoreReady?: (client: LocalCoreClient) => Promise<string | { qualificationProfileId: string; expiryProfileId: string } | undefined>,
): Promise<{
  port: number;
  url: string;
  token: string;
  startupOutput: string;
  signal(signal: NodeJS.Signals): void;
  waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  waitForStderr(pattern: RegExp): Promise<string>;
  stderrOutput(): string;
  restartCore(overrides?: NodeJS.ProcessEnv): Promise<void>;
  qualificationProfileId?: string | undefined;
  expiryProfileId?: string | undefined;
}> {
  const repoRoot = process.cwd();
  const kestrelHome = await mkdtemp(path.join(os.tmpdir(), "kestrel-web-command-"));
  const corePaths = resolveLocalCorePaths(kestrelHome);
  const port = await reservePort();
  const launchCore = (overrides: NodeJS.ProcessEnv = {}) => {
    const coreStderrChunks: string[] = [];
    const core = spawn(process.execPath, ["--import", "tsx", path.resolve(repoRoot, "src/localCore/daemonMain.ts")], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...envOverrides,
        ...overrides,
        KESTREL_HOME: kestrelHome,
        // The web-runner fixture supplies isolated ambient credentials. Avoid
        // coupling it to the host developer's macOS Keychain.
        KESTREL_CORE_PLATFORM: "linux",
        KESTREL_DISABLE_DOTENV: "1",
        KESTREL_LOCAL_CORE_DIRECT: "0",
        KESTREL_LOCAL_CORE_DAEMON: "1",
        KESTREL_CORE_VERSION: KESTREL_SUITE_VERSION,
        KESTREL_CORE_OWNER_EXECUTABLE: path.resolve(repoRoot, "src/localCore/daemonMain.ts"),
        KESTREL_CORE_REPO_ROOT: repoRoot,
        KESTREL_CORE_RUN_MIGRATIONS: "1",
        KESTREL_CORE_IDLE_TIMEOUT_MS: "600000",
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const coreExitPromise = waitForClose(core);
    core.stderr.on("data", (chunk) => coreStderrChunks.push(chunk.toString("utf8")));
    return { core, coreExitPromise, coreStderrChunks };
  };
  let coreState = launchCore();
  let coreToken: string;
  try {
    coreToken = await waitForLocalCoreReady({
      socketPath: corePaths.apiSocketPath,
      tokenPath: corePaths.apiTokenPath,
      exitPromise: coreState.coreExitPromise,
      stderrChunks: coreState.coreStderrChunks,
    });
  } catch (error) {
    if (coreState.core.exitCode === null && coreState.core.signalCode === null) {
      coreState.core.kill("SIGTERM");
    }
    await coreState.coreExitPromise;
    await rm(kestrelHome, { recursive: true, force: true });
    throw error;
  }
  const configuredProfiles = await afterCoreReady?.(
    new LocalCoreClient({ socketPath: corePaths.apiSocketPath, token: coreToken }),
  );
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      path.resolve(repoRoot, "cli/tui.ts"),
      "web",
      "--port",
      String(port),
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...envOverrides,
        KESTREL_HOME: kestrelHome,
        KESTREL_DISABLE_DOTENV: "1",
        KESTREL_LOCAL_CORE_DIRECT: "0",
        KESTREL_LOCAL_CORE_API_SOCKET: corePaths.apiSocketPath,
        KESTREL_LOCAL_CORE_API_TOKEN: coreToken,
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const exitPromise = waitForClose(child);

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(chunk.toString("utf8"));
  });

  t.after(async () => {
    if (autoShutdownSignal !== false && child.exitCode === null && child.signalCode === null) {
      child.kill(autoShutdownSignal);
    } else if (autoShutdownSignal === false && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    const exit = await exitPromise;
    if (autoShutdownSignal !== false) {
      assert.equal(exit.code, 0);
      assert.match(stderrChunks.join(""), /runner service stopped/u);
    }
    if (coreState.core.exitCode === null && coreState.core.signalCode === null) {
      coreState.core.kill("SIGTERM");
    }
    await coreState.coreExitPromise;
    // The runner may have replaced an incompatible fixture daemon. This
    // isolated home belongs to the test, so stop whichever daemon currently
    // owns its lock before deleting the home.
    await stopLocalCoreFromLock(corePaths.lockPath);
    await rm(kestrelHome, { recursive: true, force: true });
  });

  const startupOutput = await waitForOutput(stdoutChunks, /export KESTREL_RUNNER_SERVICE_TOKEN=/u);
  const url = startupOutput.match(/export KESTREL_RUNNER_SERVICE_URL='([^']+)'/u)?.[1];
  const token = startupOutput.match(/export KESTREL_RUNNER_SERVICE_TOKEN='([^']+)'/u)?.[1];

  if (url === undefined || token === undefined) {
    throw new Error(`Expected launcher output to include URL and token exports.\n${startupOutput}`);
  }

  return {
    port,
    url,
    token,
    ...(configuredProfiles === undefined ? {} : typeof configuredProfiles === "string" ? { qualificationProfileId: configuredProfiles } : configuredProfiles),
    startupOutput,
    signal(signal: NodeJS.Signals) {
      child.kill(signal);
    },
    async waitForExit() {
      return await exitPromise;
    },
    async waitForStderr(pattern) {
      return await waitForOutput(stderrChunks, pattern);
    },
    stderrOutput() {
      return stderrChunks.join("");
    },
    async restartCore(overrides = {}) {
      if (coreState.core.exitCode === null && coreState.core.signalCode === null) coreState.core.kill("SIGTERM");
      await coreState.coreExitPromise;
      coreState = launchCore(overrides);
      const restartedToken = await waitForLocalCoreReady({
        socketPath: corePaths.apiSocketPath,
        tokenPath: corePaths.apiTokenPath,
        exitPromise: coreState.coreExitPromise,
        stderrChunks: coreState.coreStderrChunks,
      });
      assert.equal(restartedToken, coreToken, "Local Core restart must preserve the proxy authentication token.");
    },
  };
}

async function waitForLocalCoreReady(input: {
  socketPath: string;
  tokenPath: string;
  exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderrChunks: string[];
}): Promise<string> {
  while (true) {
    const exited = await Promise.race([
      input.exitPromise.then((result) => ({ result })),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 25)),
    ]);
    if (exited !== undefined) {
      throw new Error(
        `Local Core exited before becoming ready: ${JSON.stringify(exited.result)} ${input.stderrChunks.join("")}`,
      );
    }
    try {
      const normalizedToken = (await readFile(input.tokenPath, "utf8")).trim();
      if (normalizedToken.length === 0) {
        throw new Error("Local Core token was empty.");
      }
      const client = new LocalCoreClient({
        socketPath: input.socketPath,
        token: normalizedToken,
        timeoutMs: 2000,
      });
      await client.status();
      return normalizedToken;
    } catch {}
  }
}

async function stopLocalCoreFromLock(lockPath: string): Promise<void> {
  let ownerPid: number | undefined;
  try {
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as { ownerPid?: unknown };
    ownerPid = typeof lock.ownerPid === "number" ? lock.ownerPid : undefined;
  } catch {
    return;
  }
  if (ownerPid === undefined) {
    return;
  }
  try {
    process.kill(ownerPid, "SIGTERM");
  } catch {
    return;
  }
  while (true) {
    try {
      process.kill(ownerPid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function openEventSubscription(
  runnerUrl: string,
  runnerToken: string,
  sessionId: string,
): Promise<{ close(): void }> {
  const request = await new Promise<ClientRequest>((resolve, reject) => {
    const body = JSON.stringify({
      filter: {
        sessionId,
      },
      metadata: {
        actor: {
          actorId: "user-1",
          actorType: "operator",
          tenantId: "internal",
        },
        tenantId: "internal",
      },
    });
    const target = new URL(`${runnerUrl}/events/stream`);
    const req = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${runnerToken}`,
          "content-length": Buffer.byteLength(body).toString(),
        },
      },
      (response) => {
        req.setTimeout(0);
        response.on("data", () => {
          // Keep the stream flowing until the server closes it.
        });
        resolve(req);
      },
    );
    req.once("error", reject);
    req.end(body);
  });

  return {
    close() {
      request.destroy();
    },
  };
}

async function runCurlJson(input: {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const args = ["-sS", "--max-time", "20", "-o", "-", "-w", "\n%{http_code}"];
  if (input.method !== undefined && input.method !== "GET") {
    args.push("-X", input.method);
  }
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    args.push("-H", `${name}: ${value}`);
  }
  if (input.body !== undefined) {
    args.push("--data", input.body);
  }
  args.push(input.url);

  const result = await execFileAsync("curl", args, {
    cwd: process.cwd(),
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = result.stdout.trimEnd();
  const newline = stdout.lastIndexOf("\n");
  if (newline === -1) {
    throw new Error(`curl response was missing an HTTP status line for ${input.url}`);
  }

  const rawBody = stdout.slice(0, newline);
  const rawStatus = stdout.slice(newline + 1);
  const status = Number.parseInt(rawStatus, 10);
  if (Number.isFinite(status) === false) {
    throw new Error(`curl response returned invalid HTTP status '${rawStatus}' for ${input.url}`);
  }

  return {
    status,
    body: JSON.parse(rawBody) as Record<string, unknown>,
  };
}

async function runCurlText(input: {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string }> {
  const args = ["-sS", "-N", "-o", "-", "-w", "\n%{http_code}"];
  if (input.method !== undefined && input.method !== "GET") {
    args.push("-X", input.method);
  }
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    args.push("-H", `${name}: ${value}`);
  }
  if (input.body !== undefined) {
    args.push("--data", input.body);
  }
  args.push(input.url);

  const result = await execFileAsync("curl", args, {
    cwd: process.cwd(),
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = result.stdout.trimEnd();
  const newline = stdout.lastIndexOf("\n");
  if (newline === -1) {
    throw new Error(`curl response was missing an HTTP status line for ${input.url}`);
  }

  const rawBody = stdout.slice(0, newline);
  const rawStatus = stdout.slice(newline + 1);
  const status = Number.parseInt(rawStatus, 10);
  if (Number.isFinite(status) === false) {
    throw new Error(`curl response returned invalid HTTP status '${rawStatus}' for ${input.url}`);
  }

  return {
    status,
    body: rawBody,
  };
}

function readSseEvent(body: string, eventType: string): Record<string, unknown> {
  const marker = `event: ${eventType}\n`;
  const start = body.indexOf(marker);
  if (start === -1) throw new Error(`SSE event '${eventType}' was not present.`);
  const dataStart = start + marker.length;
  const dataEnd = body.indexOf("\n\n", dataStart);
  const line = body.slice(dataStart, dataEnd === -1 ? undefined : dataEnd);
  if (line.startsWith("data: ") === false) throw new Error(`SSE event '${eventType}' had no data line.`);
  return JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
}

async function startFakeOpenRouterServer(): Promise<{
  url: string;
  requests: Array<{ schemaName: string; userMessage: string }>;
  close(): Promise<void>;
}> {
  const requests: Array<{ schemaName: string; userMessage: string }> = [];
  const sockets = new Set<Socket>();
  const server = createHttpServer((request, response) => {
    void handleFakeOpenRouterRequest(request, response, requests);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to start fake OpenRouter server.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function handleFakeOpenRouterRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: Array<{ schemaName: string; userMessage: string }>,
): Promise<void> {
  const body = await readRequestBody(request);
  const parsed = JSON.parse(body) as {
    metadata?: { schemaName?: string | undefined } | undefined;
    response_format?: { json_schema?: { name?: string | undefined } | undefined } | undefined;
    tools?: Array<{ name?: string | undefined; function?: { name?: string | undefined } | undefined }> | undefined;
    messages?: Array<{ content?: string | undefined; tool_call_id?: string | undefined }> | undefined;
    stream?: boolean | undefined;
  };

  const schemaName = parsed.response_format?.json_schema?.name ?? parsed.metadata?.schemaName ??
    (Array.isArray(parsed.tools) ? "tool_call" : undefined);
  const lastMessage = parsed.messages?.at(-1)?.content;
  const parsedMessage =
    typeof lastMessage === "string"
      ? parseFakeModelMessage(lastMessage)
      : {};
  const userMessage =
    parsedMessage.userMessage ??
    (typeof lastMessage === "string" ? lastMessage : "");

  if (schemaName === undefined) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "missing response schema name" }));
    return;
  }

  requests.push({ schemaName, userMessage });

  const finalMessage = userMessage.includes("tools")
    ? "I can help with chat responses in this deterministic test harness."
    : "Hello from the fake web runner chat path.";
  if (schemaName !== "tool_call" && schemaName !== "kestrel_agent_action") {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: `unsupported schema '${schemaName}'` }));
    return;
  }

  const serializedMessages = JSON.stringify(parsed.messages);
  const qualificationUsed = serializedMessages.includes("qualification provider-used");
  const qualificationUnused = serializedMessages.includes("qualification selected-unused");
  const qualificationTimeout = serializedMessages.includes("qualification timeout");
  const qualificationCancel = serializedMessages.includes("qualification cancel");
  const qualificationExpiry = serializedMessages.includes("qualification expiry");
  const codeName = parsed.tools?.map((tool) => tool.function?.name ?? tool.name).find((name) => name === "code_execute") ?? "code.execute";
  const qualificationCallId = qualificationUnused ? "call_qualification_unused" : qualificationTimeout ? "call_qualification_timeout" : qualificationCancel ? "call_qualification_cancel" : qualificationExpiry ? "call_qualification_expiry" : "call_qualification_code";
  const qualificationQuery = qualificationTimeout ? "qualification-timeout" : qualificationCancel ? "qualification-cancel" : qualificationExpiry ? "qualification-expiry" : "qualification";
  const toolCall = (qualificationUsed || qualificationUnused || qualificationTimeout || qualificationCancel || qualificationExpiry) && serializedMessages.includes(qualificationCallId) === false ? {
    id: qualificationCallId,
    type: "function",
    function: {
      name: codeName,
      arguments: JSON.stringify({ language: "javascript", code: qualificationUnused ? "console.log('selected capability intentionally unused')" : `fetch('http://127.0.0.1:43127/v1/capability', { method: 'POST', body: JSON.stringify({ operation: 'search', destination: 'api.tavily.com', input: { query: '${qualificationQuery}', maxResults: 1 } }) }).then(async response => console.log(JSON.stringify(await response.json())))`, capability: { capabilityId: "tavily.search.read", input: { query: qualificationUnused ? "unused" : qualificationQuery, maxResults: 1 } } }),
    },
  } : {
    id: "call_fake_finalize",
    type: "function",
    function: {
      name: "kestrel_finalize",
      arguments: JSON.stringify({
        status: "goal_satisfied",
        message: finalMessage,
        assistantProgress: "I have completed the deterministic test response.",
      }),
    },
  };

  if (parsed.stream === true) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      connection: "close",
    });
    response.end(
      `data: ${JSON.stringify({
        model: "openai/gpt-5.2-chat",
        choices: [{ delta: { tool_calls: [{ index: 0, ...toolCall }] } }],
      })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }

  response.writeHead(200, {
    "content-type": "application/json",
    connection: "close",
  });
  response.end(
    JSON.stringify({
      model: "openai/gpt-5.2-chat",
      choices: [
        {
          message: {
            content: JSON.stringify({
              reason: "This deterministic test path can answer directly without tools.",
            }),
            tool_calls: [
              toolCall,
            ],
          },
        },
      ],
    }),
  );
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseFakeModelMessage(content: string): { userMessage?: string | undefined } {
  const contextJson = extractContextJson(content);
  if (contextJson !== undefined) {
    try {
      const parsed = JSON.parse(contextJson) as {
        userMessage?: string | undefined;
        goal?: string | undefined;
        taskInstruction?: string | undefined;
        latestUserTurn?: string | undefined;
      };
      return {
        userMessage: parsed.latestUserTurn ?? parsed.taskInstruction ?? parsed.userMessage ?? parsed.goal,
      };
    } catch {
      return {
        userMessage: content,
      };
    }
  }

  const taskInstruction = extractTaggedTextSection(content, "task_instruction");
  const latestUserTurn = extractTaggedTextSection(content, "latest_user_turn");
  if (taskInstruction !== undefined || latestUserTurn !== undefined) {
    return {
      userMessage: latestUserTurn ?? taskInstruction,
    };
  }

  try {
    const parsed = JSON.parse(content) as {
      userMessage?: string | undefined;
      goal?: string | undefined;
      taskInstruction?: string | undefined;
      latestUserTurn?: string | undefined;
    };
    return {
      userMessage: parsed.latestUserTurn ?? parsed.taskInstruction ?? parsed.userMessage ?? parsed.goal,
    };
  } catch {
    return {
      userMessage: content,
    };
  }
}

function extractContextJson(content: string): string | undefined {
  const startTag = "<context_json>";
  const endTag = "</context_json>";
  const start = content.indexOf(startTag);
  if (start < 0) {
    return ;
  }
  const jsonStart = start + startTag.length;
  const end = content.indexOf(endTag, jsonStart);
  if (end < 0) {
    return ;
  }
  return content.slice(jsonStart, end).trim();
}

function extractTaggedTextSection(content: string, tagName: string): string | undefined {
  const startTag = `<${tagName}>`;
  const endTag = `</${tagName}>`;
  const start = content.indexOf(startTag);
  if (start < 0) {
    return ;
  }
  const valueStart = start + startTag.length;
  const end = content.indexOf(endTag, valueStart);
  if (end < 0) {
    return ;
  }
  const value = content.slice(valueStart, end).trim();
  return value.length > 0 ? value : undefined;
}
