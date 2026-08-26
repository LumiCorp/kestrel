import assert from "node:assert/strict";
import test from "node:test";
import { startWorkerHealthServer } from "./worker-health";

test("private worker health is closed until ready and closes during shutdown", async () => {
  const health = await startWorkerHealthServer({
    role: "turn-worker",
    buildId: "operator-aug16",
    port: 0,
    host: "127.0.0.1",
  });
  const url = `http://127.0.0.1:${health.port}/healthz`;
  try {
    assert.equal((await fetch(url)).status, 503);
    health.markReady();
    const ready = await fetch(url);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), {
      ok: true,
      role: "turn-worker",
      buildId: "operator-aug16",
    });
    health.markUnhealthy();
    assert.equal((await fetch(url)).status, 503);
  } finally {
    await health.close();
  }
});
