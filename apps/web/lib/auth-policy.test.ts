import assert from "node:assert/strict";
import { isDisallowedToolProviderSignIn } from "./auth-policy";
import { contractTest } from "../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "GitHub is link-only and cannot be used to sign in", () => {
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
  assert.equal(
    isDisallowedToolProviderSignIn({
      path: "/sign-in/oauth2",
      body: { providerId: "microsoft-entra-id" },
    }),
    true
  );
  assert.equal(
    isDisallowedToolProviderSignIn({
      path: "/oauth2/link",
      body: { providerId: "microsoft-entra-id" },
    }),
    false
  );
});
