import assert from "node:assert/strict";
import test from "node:test";
import { isDisallowedGithubSignIn } from "./auth-policy";

test("GitHub is link-only and cannot be used to sign in", () => {
  assert.equal(
    isDisallowedGithubSignIn({
      path: "/sign-in/social",
      body: { provider: "github" },
    }),
    true
  );
  assert.equal(
    isDisallowedGithubSignIn({
      path: "/link-social",
      body: { provider: "github" },
    }),
    false
  );
  assert.equal(
    isDisallowedGithubSignIn({
      path: "/sign-in/social",
      body: { provider: "google" },
    }),
    false
  );
});
