import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Browser approval revalidation and personal grant creation share the locked decision transaction", async () => {
  const source = await readFile(new URL("./store.ts", import.meta.url), "utf8");
  const start = source.indexOf(
    "export async function resolveDurableRuntimeInteraction",
  );
  const end = source.indexOf(
    "export async function recordDurableRuntimeStarted",
    start,
  );
  const boundary = source.slice(start, end);
  const browserStart = boundary.indexOf("lockedEnvironmentGrant");
  const browserEnd = boundary.indexOf(
    'decision === "remember_approval"',
    browserStart,
  );
  const browserBoundary = boundary.slice(browserStart, browserEnd);

  assert.match(boundary, /return knowledgeDb\.transaction\(async \(tx\) =>/u);
  assert.match(
    boundary,
    /isBrowserDomainGrantApproval && decision === "remember_approval"[\s\S]*throw new DurableTurnError/u,
  );
  assert.match(
    browserBoundary,
    /environmentAppCapabilityGrants[\s\S]*\.for\("update"\)/u,
  );
  assert.match(browserBoundary, /projectApps[\s\S]*\.for\("update"\)/u);
  assert.match(
    browserBoundary,
    /projectAppCapabilityPolicies[\s\S]*\.for\("update"\)/u,
  );
  assert.match(
    browserBoundary,
    /environmentCapabilitySubjectRestrictions[\s\S]*\.for\("update"\)/u,
    "actor and hosted-agent restrictions must be locked before Browser grant revalidation",
  );
  assert.ok(
    browserBoundary.indexOf(".for(\"update\")") <
      browserBoundary.indexOf("resolveHostedBrowserPublicGrantDecision"),
    "policy rows must be locked before current authority is resolved",
  );
  assert.match(
    browserBoundary,
    /currentDecision\.decision === "approval_required"[\s\S]*createOrReactivateHostedBrowserPersonalDomainInTransaction/u,
  );
  assert.doesNotMatch(
    browserBoundary,
    /currentDecision\.decision === "already_allowed"[\s\S]*createOrReactivate/u,
  );
  assert.doesNotMatch(browserBoundary, /rememberedToolApprovals/u);
  assert.match(
    source,
    /grant\.sessionMode !== "operator"[\s\S]*Browser domain approval presentation is invalid/u,
    "hosted approval parsing must fail closed unless the card is operator-only",
  );
  assert.match(
    browserBoundary,
    /sessionMode: browserDomainGrant\.sessionMode/u,
    "revalidation must use the validated Browser approval mode instead of a hardcoded value",
  );
  assert.doesNotMatch(
    browserBoundary,
    /sessionMode: "operator"/u,
    "store revalidation must not invent operator authority",
  );
  assert.match(
    source,
    /stableToolIdentity\.toolId !== "browser\.request_grant"[\s\S]*preparedInvocationId\.length === 0[\s\S]*TURN_CONFLICT/u,
    "wrong prepared identities must fail before personal authority is created",
  );
  assert.match(
    source,
    /grant\.requestingActorId !== approval\.approval\.requestingActor\.actorId[\s\S]*grant\.approvalAuthorityRevision !==[\s\S]*stableToolIdentity\.approvalAuthorityRevision/u,
    "the Browser presentation must remain bound to the exact actor and prepared approval authority",
  );
  assert.match(
    browserBoundary,
    /if \(error instanceof HostedBrowserDomainError\)[\s\S]*else \{\s*throw error;/u,
    "unexpected persistence failures must abort and roll back the decision transaction",
  );
  assert.ok(
    boundary.indexOf(
      "createOrReactivateHostedBrowserPersonalDomainInTransaction",
      browserStart,
    ) < boundary.indexOf(".update(schema.threadInteractions)", browserStart),
    "the grant must be created before the interaction is settled in one transaction",
  );
});
