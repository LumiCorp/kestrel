import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { ProtocolClient, type ProtocolTransport } from "../../cli/client/ProtocolClient.js";
import { CommandRouter } from "../../cli/runner/CommandRouter.js";
import { createDurableSessionDescriber } from "../../cli/runner/DurableSessionDescriber.js";
import { EventWriter } from "../../cli/runner/EventWriter.js";
import { RunnerHost } from "../../cli/runner/RunnerHost.js";
import { InMemorySessionStore } from "../../src/store/InMemorySessionStore.js";

class RouterTransport implements ProtocolTransport {
  private handlers?: Parameters<ProtocolTransport["start"]>[0];
  private router?: CommandRouter;
  private readonly output = new PassThrough();
  private buffered = "";

  start(handlers: Parameters<ProtocolTransport["start"]>[0]): void {
    this.handlers = handlers;
    this.output.on("data", (chunk: Buffer) => {
      this.buffered += chunk.toString("utf8");
      const lines = this.buffered.split("\n");
      this.buffered = lines.pop() ?? "";
      for (const line of lines) {
        handlers.onLine(line);
      }
    });
  }

  createWriter(): EventWriter {
    return new EventWriter(this.output);
  }

  setRouter(router: CommandRouter): void {
    this.router = router;
  }

  send(line: string): void {
    if (this.router === undefined) {
      throw new Error("router transport is not configured");
    }
    void this.router.acceptLine(line).catch((error: unknown) => {
      this.handlers?.onTransportError?.(
        (JSON.parse(line) as { id: string }).id,
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  }

  async stop(): Promise<void> {
    this.output.end();
  }
}

for (const code of [
  "SESSION_ENVIRONMENT_IDENTITY_CONFLICT",
  "SESSION_ENVIRONMENT_IDENTITY_UNSUPPORTED",
] as const) {
  test(`session.describe preserves ${code} through RunnerHost, CommandRouter, and ProtocolClient`, async () => {
    const sessionId = `session-${code}`;
    const threadId = `thread-main:${sessionId}`;
    const bundleId = `bundle:${code}`;
    const store = new InMemorySessionStore();
    await store.ensureSession(sessionId, "agent.loop");
    await store.upsertThread({
      threadId,
      sessionId,
      title: "Environment protocol failure",
      status: "WAITING",
      environmentPresetId: "cli_dev_local",
      effectiveAssemblyId: bundleId,
      metadata: { mainThread: true },
      createdAt: "2026-08-28T12:00:00.000Z",
      updatedAt: "2026-08-28T12:01:00.000Z",
    });
    await store.upsertAssemblyBundle({
      bundleId,
      label: "Environment protocol failure",
      source: "profile_default",
      toolAllowlist: [],
      specialistIds: [],
      metadata: {
        environmentPresetId:
          code === "SESSION_ENVIRONMENT_IDENTITY_CONFLICT"
            ? "cli_safe_local"
            : "cli_future_local",
      },
      createdAt: "2026-08-28T12:00:00.000Z",
      updatedAt: "2026-08-28T12:00:00.000Z",
    });
    await store.appendThreadAssemblyRecord({
      recordId: `record:${code}`,
      threadId,
      bundleId,
      cause: "thread_start",
      authority: "profile",
      createdAt: "2026-08-28T12:00:00.000Z",
    });

    const transport = new RouterTransport();
    const writer = transport.createWriter();
    let runtimeCreations = 0;
    const host = new RunnerHost(
      writer,
      () => {
        runtimeCreations += 1;
        return {
          runTurn: async () => { throw new Error("runtime must not be created"); },
          close: async () => {},
        };
      },
      undefined,
      {
        sessionDescriber: createDurableSessionDescriber(store),
      },
    );
    transport.setRouter(new CommandRouter(host, writer));
    const client = new ProtocolClient(transport);

    await assert.rejects(
      client.sendCommandWithId(`command-${code}`, "session.describe", {
        sessionId,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, code);
        return true;
      },
    );
    assert.equal(runtimeCreations, 0);

    await client.close();
    await host.close();
  });
}
