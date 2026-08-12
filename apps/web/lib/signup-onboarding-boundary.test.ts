import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("public signup keeps the three-field invite-code contract", async () => {
  const source = await readFile(
    new URL("../components/access-code-sign-up.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /params\.get\("invite"\)/u);
  assert.match(source, /id="signup-email"/u);
  assert.match(source, /id="signup-password"/u);
  assert.match(source, /id="signup-invite-code"/u);
  assert.doesNotMatch(source, /password_confirmation|Profile Image|first-name|last-name/u);
  assert.match(source, /SIGNUP_ACCESS_CODE_HEADER/u);
  assert.match(source, /sendVerificationEmail/u);
  assert.match(source, /router\.push\("\/onboarding"\)/u);
});

test("signup onboarding has no skip and limits AI providers", async () => {
  const [setupSource, onboardingSource, routeSource] = await Promise.all([
    readFile(new URL("../components/settings/setup-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/signup-onboarding-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/onboarding/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(setupSource, /mode !== "signup" \|\| option\.key !== "lumi"/u);
  assert.match(setupSource, /Approve and use default/u);
  assert.match(setupSource, /Save, test, and continue/u);
  assert.match(onboardingSource, /Resend verification email/u);
  assert.match(onboardingSource, /I have verified my email/u);
  assert.match(onboardingSource, /if \(result\.error\)/u);
  assert.match(onboardingSource, /setDeliveryWarning\(false\)/u);
  assert.match(routeSource, /z\.discriminatedUnion\("action"/u);
  for (const action of [
    "replace-invite-code",
    "connect-provider",
    "select-default-model",
    "configure-fly",
    "retry-default-environment",
    "complete",
  ]) {
    assert.match(routeSource, new RegExp(`z\\.literal\\("${action}"\\)`, "u"));
  }
  assert.match(setupSource, /fetch\("\/api\/onboarding"/u);
  assert.doesNotMatch(routeSource, /x-active-organization-id|x-organization-id/u);
  assert.doesNotMatch(`${setupSource}\n${onboardingSource}`, />Skip</u);
});
