import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { DesktopPreviewTunnelRegistry } from "../src/desktop-tunnels.js";

class FakeConnector extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];

  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason });
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason ?? ""));
  }

  send() {}
}

test("replacing a Desktop connector cannot let the old close remove the new connection", () => {
  const registry = new DesktopPreviewTunnelRegistry();
  const first = new FakeConnector();
  const replacement = new FakeConnector();

  registry.attachConnector("preview-1", first as unknown as WebSocket);
  registry.attachConnector("preview-1", replacement as unknown as WebSocket);

  assert.deepEqual(first.closeCalls, [{ code: 4001, reason: "replaced" }]);
  assert.equal(registry.isConnected("preview-1"), true);
  registry.close();
});

test("expired Desktop tunnel authorization closes an established connector", () => {
  const registry = new DesktopPreviewTunnelRegistry();
  const connector = new FakeConnector();

  registry.attachConnector("preview-1", connector as unknown as WebSocket, {
    expiresAtMs: Date.now() - 1,
  });

  assert.equal(registry.isConnected("preview-1"), false);
  assert.equal(connector.closeCalls[0]?.code, 4003);
  registry.close();
});

test("revoked Desktop tunnel authorization closes an established connector", async () => {
  const registry = new DesktopPreviewTunnelRegistry({ revalidateMs: 1 });
  const connector = new FakeConnector();
  const closed = new Promise<void>((resolve) =>
    connector.once("close", () => resolve()),
  );

  registry.attachConnector("preview-1", connector as unknown as WebSocket, {
    expiresAtMs: Date.now() + 60_000,
    revalidate: async () => false,
  });

  await Promise.race([
    closed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("connector was not revoked")), 500),
    ),
  ]);
  assert.equal(registry.isConnected("preview-1"), false);
  assert.equal(connector.closeCalls[0]?.code, 4003);
  registry.close();
});
