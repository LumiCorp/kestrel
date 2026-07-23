#!/usr/bin/env node

import { createRunnerServiceServer } from "./RunnerService.js";
import {
  KestrelChatRuntime,
  createRuntimeFactoryWithStore,
} from "../runtime/KestrelChatRuntime.js";
import { createSessionStoreFromEnv } from "../../src/store/createSessionStore.js";

async function main(): Promise<void> {
  const storeHandle = createSessionStoreFromEnv();
  const sharedRuntimeFactory = createRuntimeFactoryWithStore(
    storeHandle.store,
  );
  const server = await createRunnerServiceServer({
    host: process.env.KESTREL_RUNNER_SERVICE_HOST,
    port: parsePort(process.env.KESTREL_RUNNER_SERVICE_PORT),
    authToken: process.env.KESTREL_RUNNER_SERVICE_TOKEN,
    runtimeFactory: (
      profile,
      onRunLog,
      _onProgress,
      onConsole,
      _onReasoning,
      onTaskUpdate,
      onRunEvent,
    ) =>
      new KestrelChatRuntime(profile, sharedRuntimeFactory, {
        onRunLog,
        onConsole,
        onTaskUpdate,
        onRunEvent,
      }),
    runtimeStore: {
      ready: storeHandle.ready,
      probe: storeHandle.probe,
      close: storeHandle.close,
    },
    onRuntimeStoreEvent: (event) => {
      process.stdout.write(
        `${JSON.stringify({
          ...event,
          occurredAt: new Date().toISOString(),
        })}\n`,
      );
    },
  }).catch(async (error: unknown) => {
    await storeHandle.close().catch(() => {});
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
