import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("signup navigates to onboarding when verification delivery fails", async () => {
  const source = await readFile(
    new URL("./access-code-sign-up.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /const verification = await client\.sendVerificationEmail/u,
  );
  assert.match(
    source,
    /verificationDeliveryFailed = Boolean\(verification\?\.error\)/u,
  );
  assert.match(
    source,
    /catch \{\s*verificationDeliveryFailed = true;/u,
  );
  assert.match(
    source,
    /router\.push\("\/onboarding\?verificationDelivery=failed"\)/u,
  );
  assert.match(source, /router\.push\("\/onboarding"\)/u);
});

test("signup code expiration edits preserve untouched UTC instants", async () => {
  const source = await readFile(
    new URL("./settings/signup-codes-client.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /isoInstantToLocalDateTimeInput\(item\.expiresAt\)/u);
  assert.match(source, /Expiration \(optional, local time\)/u);
  assert.match(source, /Expiration \(local time\)/u);
  assert.match(
    source,
    /if \(expiry !== initialExpiry\) \{\s*change\.expiresAt = localDateTimeInputToIsoInstant\(expiry\);/u,
  );
  assert.doesNotMatch(source, /expiresAt\.slice\(0, 16\)/u);
});
