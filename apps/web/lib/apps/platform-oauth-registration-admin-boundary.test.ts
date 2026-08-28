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
const registrationSource = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "platform-oauth-registrations.ts",
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

test("OAuth registration mutation and audit evidence share one transaction", () => {
  const transaction = registrationSource.indexOf(
    "await knowledgeDb.transaction",
  );
  const mutation = registrationSource.indexOf(
    ".update(schema.platformOAuthRegistrations)",
    transaction,
  );
  const audit = registrationSource.indexOf(
    "await insertAdminEvent(transaction",
    transaction,
  );
  assert.ok(transaction >= 0);
  assert.ok(mutation > transaction);
  assert.ok(audit > mutation);
  assert.doesNotMatch(routeSource, /logAdminEvent|\.catch\(\(\) =>/u);
});

test("Platform OAuth packs derive their capability scopes from operation descriptors", () => {
  assert.match(registrationSource, /GOOGLE_WORKSPACE_OPERATION_DESCRIPTORS/u);
  assert.match(registrationSource, /MICROSOFT_365_OPERATION_DESCRIPTORS/u);
  assert.doesNotMatch(registrationSource, /_PACK_SCOPES/u);
  assert.doesNotMatch(registrationSource, /outlook|sharepoint/u);
});
