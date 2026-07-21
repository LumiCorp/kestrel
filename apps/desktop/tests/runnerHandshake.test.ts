import assert from "node:assert/strict";

import { ensureDesktopRunnerResponsive, type RunnerHandshakeTransport } from "../src/runnerHandshake.js";
import type { RunnerProtocolObserver } from "../src/runnerTransport.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


class FakeRunnerHandshakeTransport implements RunnerHandshakeTransport {
  private observer: RunnerProtocolObserver | undefined;
  public ensureStartedCalls = 0;
  public sentLines: string[] = [];
  public lastCommandId: string | undefined;

  observe(observer: RunnerProtocolObserver): () => void {
    this.observer = observer;
    return () => {
      if (this.observer === observer) {
        this.observer = undefined;
      }
    };
  }

  ensureStarted(): void {
    this.ensureStartedCalls += 1;
  }

  send(line: string): void {
    this.sentLines.push(line);
    const command = JSON.parse(line) as { id: string; type: string };
    this.lastCommandId = command.id;
  }

  emitStdout(line: string): void {
    this.observer?.onLine?.(line);
  }

  emitExit(code: number | null): void {
    this.observer?.onExit?.(code);
  }
}

contractTest("desktop.hermetic", "ensureDesktopRunnerResponsive resolves only after a matching runner.pong", async () => {
  const transport = new FakeRunnerHandshakeTransport();
  const handshake = ensureDesktopRunnerResponsive(transport, { timeoutMs: 100 });

  await Promise.resolve();
  assert.equal(transport.ensureStartedCalls, 1);
  assert.equal(transport.sentLines.length, 1);

  transport.emitStdout(JSON.stringify({
    id: "event-1",
    type: "runner.pong",
    commandId: transport.lastCommandId,
    ts: new Date("2026-04-21T12:00:00.000Z").toISOString(),
    payload: {
      nonce: transport.lastCommandId,
    },
  }));

  await handshake;
});

contractTest("desktop.hermetic", "ensureDesktopRunnerResponsive surfaces top-level runner startup errors with their original code", async () => {
  const transport = new FakeRunnerHandshakeTransport();
  const handshake = ensureDesktopRunnerResponsive(transport, { timeoutMs: 100 });

  await Promise.resolve();
  transport.emitStdout(JSON.stringify({
    id: "event-2",
    type: "runner.error",
    ts: new Date("2026-04-21T12:00:00.000Z").toISOString(),
    payload: {
      code: "STORE_SQLITE_INIT_FAILED",
      message: "Failed to initialize local runtime store.",
    },
  }));

  await assert.rejects(handshake, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, "STORE_SQLITE_INIT_FAILED");
    assert.match(String((error as Error).message), /Failed to initialize local runtime store/u);
    return true;
  });
});

contractTest("desktop.hermetic", "ensureDesktopRunnerResponsive preserves diagnostics for malformed runner errors", async () => {
  const transport = new FakeRunnerHandshakeTransport();
  const handshake = ensureDesktopRunnerResponsive(transport, { timeoutMs: 100 });

  await Promise.resolve();
  transport.emitStdout(JSON.stringify({
    id: "event-malformed-error",
    type: "runner.error",
    ts: new Date("2026-04-21T12:00:00.000Z").toISOString(),
    payload: {
      code: "STORE_SQLITE_INIT_FAILED",
    },
  }));

  await assert.rejects(handshake, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, "STORE_SQLITE_INIT_FAILED");
    assert.match(
      String((error as Error).message),
      /STORE_SQLITE_INIT_FAILED before completing startup verification/u,
    );
    return true;
  });
});

contractTest("desktop.hermetic", "ensureDesktopRunnerResponsive handles synchronous observer errors without sending ping", async () => {
  let sendCalls = 0;
  const transport: RunnerHandshakeTransport = {
    observe(observer) {
      observer.onLine?.(JSON.stringify({
        id: "event-sync-error",
        type: "runner.error",
        ts: new Date("2026-04-21T12:00:00.000Z").toISOString(),
        payload: {
          code: "RUNNER_BOOT_FAILED",
          message: "Runner failed during boot.",
        },
      }));
      return () => {};
    },
    ensureStarted() {
      throw new Error("ensureStarted should not run after synchronous settlement");
    },
    send() {
      sendCalls += 1;
    },
  };

  await assert.rejects(
    ensureDesktopRunnerResponsive(transport, { timeoutMs: 100 }),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "RUNNER_BOOT_FAILED");
      assert.match(String((error as Error).message), /Runner failed during boot/u);
      return true;
    },
  );
  assert.equal(sendCalls, 0);
});

contractTest("desktop.hermetic", "ensureDesktopRunnerResponsive rejects when the runner exits before responding", async () => {
  const transport = new FakeRunnerHandshakeTransport();
  const handshake = ensureDesktopRunnerResponsive(transport, { timeoutMs: 100 });

  await Promise.resolve();
  transport.emitExit(1);

  await assert.rejects(handshake, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, "desktop.runner_exited_during_handshake");
    assert.match(String((error as Error).message), /exited with code 1/u);
    return true;
  });
});
