import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const authSource = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../auth.ts"),
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
  assert.match(authSource, /KESTREL_ONE_MOBILE_TRUSTED_ORIGINS/u);
  assert.match(authSource, /"kestrelone:\/\/"/u);
  assert.match(
    authSource,
    /process\.env\.NODE_ENV === "production" \? \[\] : \["exp:\/\/"\]/u
  );
});

test("the auth route promotes Expo origin metadata before Better Auth validation", () => {
  assert.match(authRouteSource, /withExpoOrigin\(request\)/u);
});
