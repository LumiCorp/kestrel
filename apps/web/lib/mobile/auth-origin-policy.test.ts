import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";


const authSecurityPolicySource = fs.readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../auth-security-policy.ts"
  ),
  "utf8"
);
const authRouteSource = fs.readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../app/api/auth/[...all]/route.ts"
  ),
  "utf8"
);

test("native Kestrel One origins are explicit and Expo development origins are not trusted in production", () => {
  assert.match(
    authSecurityPolicySource,
    /KESTREL_ONE_MOBILE_TRUSTED_ORIGINS/u
  );
  assert.match(authSecurityPolicySource, /"kestrelone:\/\/"/u);
  assert.match(
    authSecurityPolicySource,
    /isProduction \? \[\] : \["exp:\/\/"\]/u
  );
});

test("the auth route promotes Expo origin metadata before Better Auth validation", () => {
  assert.match(authRouteSource, /withExpoOrigin\(request\)/u);
});
