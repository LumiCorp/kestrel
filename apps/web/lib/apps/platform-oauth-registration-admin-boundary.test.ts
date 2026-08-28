import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const routeSource = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../app/api/platform/integrations/route.ts",
  ),
  "utf8",
);

test("Platform OAuth registration route is admin-gated and redacted", () => {
  assert.match(routeSource, /await requireAdmin\(\)/u);
  assert.match(routeSource, /listPlatformOAuthRegistrations\(\)/u);
  assert.match(routeSource, /savePlatformOAuthRegistration\(/u);
  assert.doesNotMatch(
    routeSource,
    /GOOGLE_CLIENT_SECRET|MICROSOFT_CLIENT_SECRET/u,
  );
  assert.doesNotMatch(routeSource, /NextResponse\.json\([^)]*clientSecret/u);
});

test("OAuth registration audit failure cannot turn a committed save into failure", () => {
  const save = routeSource.indexOf("await savePlatformOAuthRegistration");
  const audit = routeSource.indexOf("await logAdminEvent", save);
  const isolatedAuditFailure = routeSource.indexOf(".catch(() =>", audit);
  const successResponse = routeSource.indexOf(
    "return NextResponse.json",
    audit,
  );
  assert.ok(save < audit);
  assert.ok(audit < isolatedAuditFailure);
  assert.ok(isolatedAuditFailure < successResponse);
});
