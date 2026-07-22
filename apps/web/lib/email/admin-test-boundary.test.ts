import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const routeSource = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../app/api/platform/email/test/route.ts"
  ),
  "utf8"
);

contractTest("web.hermetic", "email tests authenticate before provider or state access", () => {
  const authentication = routeSource.indexOf("await requireAdmin()");
  const configurationRead = routeSource.indexOf("await resolveEmailConfig()");
  const providerAttempt = routeSource.indexOf("await sendEmailIntegrationTest");

  assert.notEqual(authentication, -1);
  assert.ok(authentication < configurationRead);
  assert.ok(authentication < providerAttempt);
});

contractTest("web.hermetic", "email test failures require authenticated delivery authority before mutation", () => {
  assert.match(
    routeSource,
    /actorUserId\s*&&\s*deliveryAttempted\s*&&\s*testedConfigFingerprint\s*&&\s*testedConfigRevision/
  );
});

contractTest("web.hermetic", "email test audit failure cannot turn committed readiness into failure", () => {
  const resultWrite = routeSource.indexOf("await recordEmailTestResult");
  const audit = routeSource.indexOf("await logAdminEvent", resultWrite);
  const isolatedAuditFailure = routeSource.indexOf(".catch(() =>", audit);
  const successResponse = routeSource.indexOf(
    "return NextResponse.json",
    audit
  );

  assert.notEqual(resultWrite, -1);
  assert.ok(resultWrite < audit);
  assert.ok(audit < isolatedAuditFailure);
  assert.ok(isolatedAuditFailure < successResponse);
  assert.doesNotMatch(
    routeSource.slice(isolatedAuditFailure, successResponse),
    /throw|return responseFor/
  );
});
