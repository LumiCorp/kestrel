import test from "node:test";
import assert from "node:assert/strict";

import { GET as getApps } from "./apps/route";
import { POST as postWebhook } from "./webhooks/[platform]/route";

test("Apps route rejects an unauthenticated request", async () => {
  const apps = await getApps();
  assert.equal(apps.status, 401);
});

test("webhook route rejects an invalid platform before dispatch", async () => {
  const { NextRequest } = await import("next/server");
  const request = new NextRequest("http://localhost/api/webhooks/not-a-platform", {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json" },
  });
  const response = await postWebhook(request, {
    params: Promise.resolve({ platform: "not-a-platform" }),
  });
  assert.equal(response.status, 400);
});
