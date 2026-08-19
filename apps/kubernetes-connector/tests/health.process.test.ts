import assert from "node:assert/strict";
import test from "node:test";
import { createHealthServer } from "../src/server.js";

test("health distinguishes liveness from readiness", async () => {
  let ready = false;
  const server = createHealthServer(() => ready);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/health/live`)).status, 200);
  assert.equal((await fetch(`${base}/health/ready`)).status, 503);
  ready = true;
  assert.equal((await fetch(`${base}/health/ready`)).status, 200);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
