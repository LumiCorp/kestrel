import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

test("ticket-authenticated turn-worker routes reach their route-owned authorization", async () => {
  const response = await proxy(
    new NextRequest(
      "https://kestrelagents.dev/internal/turn-worker/turn-canary/attachments/resolve",
      {
        method: "POST",
        headers: { authorization: "Bearer signed-turn-ticket" },
      },
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
  assert.equal(response.headers.get("location"), null);
});

test("nearby internal routes remain browser-session protected", async () => {
  const response = await proxy(
    new NextRequest(
      "https://kestrelagents.dev/internal/turn-worker/turn-canary/attachments/resolve/extra",
      { method: "POST" },
    ),
  );

  assert.equal(response.status, 307);
  assert.equal(
    response.headers.get("location"),
    "https://kestrelagents.dev/sign-in",
  );
});
