#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";

import {
  createHostedRunnerRuntimeFactory,
  createHostedRunnerStoreFromEnv,
} from "./HostedRunnerStore.js";
import { createRunnerServiceServer } from "./RunnerService.js";
import { createSandboxCapabilityQualificationObserver } from "./SandboxCapabilityQualificationControl.js";

async function main(): Promise<void> {
  requireQualificationMode();
  const controlDir = required("KESTREL_QUALIFICATION_CONTROL_DIR");
  const controlToken = required("KESTREL_QUALIFICATION_CONTROL_TOKEN");
  const evidencePath = required("KESTREL_QUALIFICATION_PROVIDER_EVIDENCE");
  const observer = await createSandboxCapabilityQualificationObserver({ controlDir, token: controlToken });
  const store = await createHostedRunnerStoreFromEnv();
  if (store === undefined) throw new Error("Qualification runner requires a persistent store.");
  const server = await createRunnerServiceServer({
    host: process.env.KESTREL_RUNNER_SERVICE_HOST,
    port: parsePort(process.env.KESTREL_RUNNER_SERVICE_PORT),
    authToken: required("KESTREL_RUNNER_SERVICE_TOKEN"),
    runtimeFactory: createHostedRunnerRuntimeFactory(store.store, {
      sandboxCapabilityFetchImpl: createControlledProviderFetch(evidencePath),
      sandboxCapabilityQualificationObserver: observer,
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

function createControlledProviderFetch(evidencePath: string): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url !== "https://api.tavily.com/search") return await fetch(input, init);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as { query?: string; max_results?: number } : {};
    const authorization = new Headers(init?.headers).get("authorization");
    await appendFile(evidencePath, `${JSON.stringify({
      kind: "provider_request",
      query: body.query,
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
        await appendFile(evidencePath, `${JSON.stringify({ kind: "provider_abort", query: body.query })}\n`);
        throw init.signal.reason ?? new DOMException("Aborted", "AbortError");
      }
    }
    const reflected = body.query?.includes("reflect-secret") === true ? authorization : undefined;
    return new Response(JSON.stringify({ results: [{
      title: "Controlled qualification provider",
      url: "https://qualification.invalid/result",
      content: reflected ?? `controlled result for ${body.query ?? "unknown"}`,
    }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

function requireQualificationMode(): void {
  if (process.env.KESTREL_QUALIFICATION_MODE !== "controlled") {
    throw new Error("Qualification runner requires KESTREL_QUALIFICATION_MODE=controlled.");
  }
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

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
