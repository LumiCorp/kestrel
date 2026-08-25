#!/usr/bin/env node

import {
  createHostedRunnerRuntimeFactory,
  createHostedRunnerStoreFromEnv,
} from "./HostedRunnerStore.js";
import { createRunnerServiceServer } from "./RunnerService.js";

async function main(): Promise<void> {
  const store = await createHostedRunnerStoreFromEnv({
    onStoreQuarantined: ({ sqlitePath, recoveryPath }) => {
      process.stdout.write(`${JSON.stringify({
        type: "runner.store.quarantined",
        sqlitePath,
        recoveryPath,
      })}\n`);
    },
  });
  const server = await createRunnerServiceServer({
    host: process.env.KESTREL_RUNNER_SERVICE_HOST,
    port: parsePort(process.env.KESTREL_RUNNER_SERVICE_PORT),
    authToken: process.env.KESTREL_RUNNER_SERVICE_TOKEN,
    ...(store === undefined
      ? {}
      : {
          runtimeFactory: createHostedRunnerRuntimeFactory(store.store),
          runtimeStore: {
            ready: store.ready,
            probe: store.probe,
            close: store.close,
          },
          eventJournal: store.eventJournal,
          ...(store.store.readExactEffectResult === undefined || store.store.claimExactEffectCancellation === undefined ? {} : {
            exactEffectResultStore: {
              readExactEffectResult: store.store.readExactEffectResult.bind(store.store),
              claimExactEffectCancellation: store.store.claimExactEffectCancellation.bind(store.store),
            },
            exactEffectResultTenantId: process.env.KESTREL_TENANT_ID,
          }),
        }),
    profileSourcePolicy: "registered-only",
    onRuntimeStoreEvent: (event) => {
      process.stdout.write(
        `${JSON.stringify({
          ...event,
          occurredAt: new Date().toISOString(),
        })}\n`,
      );
    },
  }).catch(async (error: unknown) => {
    await store?.close().catch(() => {});
    throw error;
  });

  process.stdout.write(`${JSON.stringify({
    type: "runner.service.started",
    url: server.url,
    host: server.host,
    port: server.port,
  })}\n`);

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shutdownPromise ??= server.close();
    return shutdownPromise;
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return ;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
