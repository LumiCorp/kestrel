import assert from "node:assert/strict";
import test from "node:test";
import { isDisallowedToolProviderSignIn } from "./auth-policy";

test("GitHub is link-only and cannot be used to sign in", () => {
  assert.equal(
    isDisallowedToolProviderSignIn({
      path: "/sign-in/social",
      body: { provider: "github" },
    }),
    true
  );
  assert.equal(
    isDisallowedToolProviderSignIn({
      path: "/link-social",
      body: { provider: "github" },
    }),
    false
  );
  assert.equal(
    isDisallowedToolProviderSignIn({
      path: "/sign-in/social",
      body: { provider: "google" },
    }),
    true
  );
  assert.equal(
    isDisallowedToolProviderSignIn({
      path: "/link-social",
      body: { provider: "google" },
    }),
    false
  );
});
