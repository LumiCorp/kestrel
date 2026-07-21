import assert from "node:assert/strict";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

import { GET as getApps } from "./apps/route";
import { POST as postWebhook } from "./webhooks/[platform]/route";

contractTest("web.hermetic", "Apps route rejects an unauthenticated request", async () => {
  const apps = await getApps();
  assert.equal(apps.status, 401);
});

contractTest("web.hermetic", "webhook route rejects an invalid platform before dispatch", async () => {
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
