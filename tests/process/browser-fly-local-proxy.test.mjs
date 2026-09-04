import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { createFlyLocalProxy, permittedRequest } from "../../apps/web/tests/browser/fly-local-proxy.mjs";

test("Fly local exposure is exact and does not expose other Web routes", () => {
  const config = "/api/runtime/environments/test-environment/gateway/config";
  assert.equal(permittedRequest("GET", config, "test-environment"), true);
  assert.equal(permittedRequest("POST", config, "test-environment"), false);
  for (const route of [config + "?x=1", config + "/", config.replace("test-environment", "other"), "/dashboard", "/api/auth/session", "/api/runtime/apps/built_in.browser/open/auto/control/%70olicy", "/api/runtime/apps/other/open/auto/control/policy"]) {
    assert.equal(permittedRequest("GET", route, "test-environment"), false);
    assert.equal(permittedRequest("POST", route, "test-environment"), false);
  }
  assert.equal(permittedRequest("POST", "/api/runtime/apps/built_in.browser/open/auto/control/policy", "test-environment"), true);
  for (const [capability, action] of [["capture", "artifact"], ["request_grant", "adopt-complete"], ["upload", "prepare-upload"], ["download", "prepare-download"], ["download", "release-download"]]) {
    assert.equal(permittedRequest("POST", `/api/runtime/apps/built_in.browser/${capability}/auto/control/${action}`, "test-environment"), true);
  }
  assert.equal(permittedRequest("POST", "/api/runtime/apps/built_in.browser/screenshot/auto/control/accept", "test-environment"), false);
});

test("Fly local proxy preserves authority/body and bounds the transfer fixture", async () => {
  let received;
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = { authorization: req.headers.authorization, body: Buffer.concat(chunks), cookie: req.headers.cookie };
    res.writeHead(409, { "content-type": "application/json" }).end('{"error":"expected"}');
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const proxy = createFlyLocalProxy({ environmentId: "test-environment", webPort: upstream.address().port });
  proxy.server.listen(0, "127.0.0.1"); await once(proxy.server, "listening");
  try {
    const base = `http://127.0.0.1:${proxy.server.address().port}`;
    const body = Buffer.from('{"prepared":"synthetic"}');
    const result = await fetch(base + "/api/runtime/apps/built_in.browser/open/auto/control/accept", { method: "POST", headers: { authorization: "Bearer synthetic", cookie: "not-forwarded", "content-type": "application/json" }, body });
    assert.equal(result.status, 409);
    assert.deepEqual(received, { authorization: "Bearer synthetic", body, cookie: undefined });
    assert.deepEqual(await result.json(), { error: "expected" });
    const uploaded = await fetch(base + "/fixture/upload", { method: "POST", body });
    assert.deepEqual(await uploaded.json(), { receivedBytes: body.length, sha256: createHash("sha256").update(body).digest("hex") });
    assert.deepEqual(proxy.uploads, [body]);
    proxy.uploads.length = 0;
    const oversized = await fetch(base + "/fixture/upload", { method: "POST", body: Buffer.alloc(65537) });
    assert.equal(oversized.status, 413);
    assert.deepEqual(proxy.uploads, []);
    assert.equal((await fetch(base + "/dashboard")).status, 404);
  } finally {
    proxy.server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => proxy.server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  }
});
