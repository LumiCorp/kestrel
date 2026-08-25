#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { appendFile, readFile } from "node:fs/promises";
import { connect } from "node:tls";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import {
  createHostedRunnerRuntimeFactory,
  createHostedRunnerStoreFromEnv,
} from "./HostedRunnerStore.js";
import { createRunnerServiceServer } from "./RunnerService.js";
import { createSandboxCapabilityQualificationObserver } from "./SandboxCapabilityQualificationControl.js";

async function main(): Promise<void> {
  const mode = requireQualificationMode();
  const controlDir = required("KESTREL_QUALIFICATION_CONTROL_DIR");
  const controlToken = required("KESTREL_QUALIFICATION_CONTROL_TOKEN");
  const evidencePath = required("KESTREL_QUALIFICATION_PROVIDER_EVIDENCE");
  await runQualificationReadiness(mode, process.env.KESTREL_QUALIFICATION_REPLAY_ONLY === "1");
  const observer = await createSandboxCapabilityQualificationObserver({ controlDir, token: controlToken });
  const store = await createHostedRunnerStoreFromEnv();
  if (store === undefined) throw new Error("Qualification runner requires a persistent store.");
  const server = await createRunnerServiceServer({
    host: process.env.KESTREL_RUNNER_SERVICE_HOST,
    port: parsePort(process.env.KESTREL_RUNNER_SERVICE_PORT),
    authToken: required("KESTREL_RUNNER_SERVICE_TOKEN"),
    runtimeFactory: createHostedRunnerRuntimeFactory(store.store, {
      sandboxCapabilityFetchImpl: createQualificationProviderFetch(mode, evidencePath),
      sandboxCapabilityQualificationObserver: observer,
      modelRetryCount: 0,
    }),
    runtimeStore: { ready: store.ready, probe: store.probe, close: store.close },
    eventJournal: store.eventJournal,
    ...(store.store.readExactEffectResult === undefined || store.store.claimExactEffectCancellation === undefined ? {} : {
      exactEffectResultStore: {
        readExactEffectResult: store.store.readExactEffectResult.bind(store.store),
        claimExactEffectCancellation: store.store.claimExactEffectCancellation.bind(store.store),
      },
      exactEffectResultTenantId: required("KESTREL_TENANT_ID"),
    }),
    profileSourcePolicy: "registered-only",
  });

  process.stdout.write(`${JSON.stringify({ type: "runner.qualification.started", url: server.url })}\n`);
  const shutdown = async () => await server.close();
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

export function createQualificationProviderFetch(mode: "live" | "controlled", evidencePath: string, liveFetch: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url !== "https://api.tavily.com/search") return await fetch(input, init);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as { query?: string; max_results?: number } : {};
    const authorization = new Headers(init?.headers).get("authorization");
    const requestId = randomUUID();
    const startedAt = Date.now();
    await appendFile(evidencePath, `${JSON.stringify({
      kind: "provider_request",
      mode,
      requestId,
      ...(mode === "controlled" ? { query: body.query } : {}),
      queryDigest: digest(body.query ?? ""),
      maxResults: body.max_results,
      authorizationPresent: authorization !== null,
      observedAt: new Date().toISOString(),
    })}\n`, { encoding: "utf8", mode: 0o600 });
    if (body.query?.startsWith("qualification-block-") === true) {
      const controlDir = required("KESTREL_QUALIFICATION_CONTROL_DIR");
      const token = required("KESTREL_QUALIFICATION_CONTROL_TOKEN");
      const releasePath = `${controlDir}/provider.${body.query}.release`;
      while (init?.signal?.aborted !== true) {
        if ((await readFile(releasePath, "utf8").catch(() => "")).trim() === token) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (init?.signal?.aborted === true) {
        await appendFile(evidencePath, `${JSON.stringify({ kind: "provider_abort", mode, requestId, query: body.query })}\n`);
        throw init.signal.reason ?? new DOMException("Aborted", "AbortError");
      }
    }
    if (mode === "controlled") {
      const reflected = body.query?.includes("reflect-secret") === true ? authorization : undefined;
      const responseBody = JSON.stringify({ results: [{
        title: "Controlled qualification provider",
        url: "https://qualification.invalid/result",
        content: reflected ?? `controlled result for ${body.query ?? "unknown"}`,
      }] });
      await appendProviderReceipt(evidencePath, {
        kind: "provider_response",
        mode,
        requestId,
        status: 200,
        responseDigest: digest(responseBody),
        durationMs: Date.now() - startedAt,
      });
      return new Response(responseBody, { status: 200, headers: { "content-type": "application/json" } });
    }
    try {
      const response = await liveFetch(input, init);
      const responseText = await response.clone().text();
      await appendProviderReceipt(evidencePath, {
        kind: "provider_response",
        mode,
        requestId,
        status: response.status,
        responseDigest: digest(responseText),
        durationMs: Date.now() - startedAt,
      });
      return response;
    } catch (error) {
      await appendProviderReceipt(evidencePath, {
        kind: init?.signal?.aborted === true ? "provider_abort" : "provider_failure",
        mode,
        requestId,
        failureCode: init?.signal?.aborted === true ? "CAPABILITY_CANCELLED" : "CAPABILITY_PROVIDER_FAILED",
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  };
}

async function runQualificationReadiness(mode: "live" | "controlled", replayOnly: boolean): Promise<void> {
  const evidencePath = required("KESTREL_QUALIFICATION_READINESS_EVIDENCE");
  const checks: Array<Record<string, unknown>> = [];
  const record = (name: string, status: "passed" | "failed" | "deferred", code?: string) => {
    checks.push({ name, status, ...(code === undefined ? {} : { code }) });
  };
  try {
    if (replayOnly) {
      record("replay_only", "passed");
      await appendFile(evidencePath, `${JSON.stringify({ mode, replayOnly, status: "passed", checks })}\n`, { encoding: "utf8", mode: 0o600 });
      return;
    }
    await promisify(execFile)("docker", ["info", "--format", "{{.ServerVersion}}"]);
    record("docker", "passed");
    if (mode === "live") {
      await requireTlsOrigin("openrouter.ai", "MODEL_DNS_UNAVAILABLE", "MODEL_TLS_UNAVAILABLE");
      record("openrouter_tls", "passed");
      await requireTlsOrigin("api.tavily.com", "TAVILY_DNS_UNAVAILABLE", "TAVILY_TLS_UNAVAILABLE");
      record("tavily_tls", "passed");
      const authorization = `Bearer ${required("OPENROUTER_API_KEY")}`;
      const auth = await fetch("https://openrouter.ai/api/v1/auth/key", {
        headers: { authorization },
        signal: AbortSignal.timeout(10_000),
      });
      if (!auth.ok) throw new QualificationReadinessError("MODEL_AUTH_INVALID");
      record("openrouter_auth", "passed");
      const model = required("KESTREL_QUALIFICATION_MODEL");
      await verifyOpenRouterModelAvailability(model, authorization);
      record("luna_model", "passed");
      record("tavily_credential", "deferred", "VALIDATED_BY_SINGLE_JOURNEY_REQUEST");
    }
    await appendFile(evidencePath, `${JSON.stringify({ mode, status: "passed", checks })}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    const code = error instanceof QualificationReadinessError ? error.code : "QUALIFICATION_READINESS_FAILED";
    record("readiness", "failed", code);
    await appendFile(evidencePath, `${JSON.stringify({ mode, status: "failed", code, checks })}\n`, { encoding: "utf8", mode: 0o600 });
    throw new Error(`${code}: live qualification readiness failed`);
  }
}

export async function verifyOpenRouterModelAvailability(
  model: string,
  authorization: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl("https://openrouter.ai/api/v1/models", {
    headers: { authorization },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new QualificationReadinessError("MODEL_CATALOG_UNAVAILABLE");
  const payload = await response.json() as unknown;
  const record = typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const entries = Array.isArray(record.data) ? record.data : [];
  const found = entries.some((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    return (entry as Record<string, unknown>).id === model;
  });
  if (!found) throw new QualificationReadinessError("MODEL_UNAVAILABLE");
}

async function requireTlsOrigin(hostname: string, dnsCode: string, tlsCode: string): Promise<void> {
  try {
    await lookup(hostname);
  } catch {
    throw new QualificationReadinessError(dnsCode);
  }
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: hostname, port: 443, servername: hostname });
    const timeout = setTimeout(() => socket.destroy(new Error(tlsCode)), 10_000);
    socket.once("secureConnect", () => {
      clearTimeout(timeout);
      socket.end();
      resolve();
    });
    socket.once("error", () => {
      clearTimeout(timeout);
      reject(new QualificationReadinessError(tlsCode));
    });
  });
}

class QualificationReadinessError extends Error {
  constructor(readonly code: string) { super(code); }
}

function appendProviderReceipt(path: string, value: Record<string, unknown>): Promise<void> {
  return appendFile(path, `${JSON.stringify({ ...value, observedAt: new Date().toISOString() })}\n`, { encoding: "utf8", mode: 0o600 });
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function requireQualificationMode(): "live" | "controlled" {
  const mode = process.env.KESTREL_QUALIFICATION_MODE;
  if (mode !== "controlled" && mode !== "live") {
    throw new Error("Qualification runner requires KESTREL_QUALIFICATION_MODE=controlled or live.");
  }
  return mode;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required qualification variable ${name}.`);
  return value;
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
