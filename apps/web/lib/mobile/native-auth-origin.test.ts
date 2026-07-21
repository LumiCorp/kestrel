import assert from "node:assert/strict";
import { withExpoOrigin } from "./native-auth-origin";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "promotes the Expo origin on native auth requests", async () => {
  const request = new Request("https://kestrel.one/api/auth/sign-in/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "expo-origin": "kestrelone://",
    },
    body: JSON.stringify({
      email: "user@example.com",
      password: "test-password",
    }),
  });

  const normalized = await withExpoOrigin(request);

  assert.notEqual(normalized, request);
  assert.equal(normalized.headers.get("origin"), "kestrelone://");
  assert.equal(normalized.headers.get("expo-origin"), "kestrelone://");
  assert.deepEqual(await normalized.json(), {
    email: "user@example.com",
    password: "test-password",
  });
});

contractTest("web.hermetic", "preserves an existing browser origin", async () => {
  const request = new Request("https://kestrel.one/api/auth/sign-in/email", {
    method: "POST",
    headers: {
      origin: "https://kestrel.one",
      "expo-origin": "kestrelone://",
    },
  });

  assert.equal(await withExpoOrigin(request), request);
  assert.equal(request.headers.get("origin"), "https://kestrel.one");
});

contractTest("web.hermetic", "leaves requests without origin metadata unchanged", async () => {
  const request = new Request("https://kestrel.one/api/auth/get-session");

  assert.equal(await withExpoOrigin(request), request);
  assert.equal(request.headers.get("origin"), null);
});
