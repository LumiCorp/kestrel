import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  ENVIRONMENT_RUNTIME_PROMOTION_AUDIENCE,
  ENVIRONMENT_RUNTIME_WORKFLOW_REF,
  verifyEnvironmentRuntimeWorkflowToken,
} from "./github-actions-oidc";

const revision = "a".repeat(40);
const now = new Date("2026-08-14T12:00:00.000Z");
const nowSeconds = Math.floor(now.getTime() / 1000);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });

test("runtime OIDC accepts only the production workflow, SHA, and run identity", async () => {
  const claims = await verifyEnvironmentRuntimeWorkflowToken({
    token: tokenFor({}),
    expectedWorkflowSha: revision,
    expectedRunId: "123456789",
    expectedRunAttempt: 2,
    now,
    fetchImpl: oidcFetch,
  });
  assert.equal(claims.ref, "refs/heads/production");
  await assert.rejects(
    verifyEnvironmentRuntimeWorkflowToken({
      token: tokenFor({ ref: "refs/heads/main" }),
      expectedWorkflowSha: revision,
      expectedRunId: "123456789",
      expectedRunAttempt: 2,
      now,
      fetchImpl: oidcFetch,
    }),
  );
  await assert.rejects(
    verifyEnvironmentRuntimeWorkflowToken({
      token: tokenFor({ aud: "wrong" }),
      expectedWorkflowSha: revision,
      expectedRunId: "123456789",
      expectedRunAttempt: 2,
      now,
      fetchImpl: oidcFetch,
    }),
    /wrong audience/u,
  );
  for (const overrides of [
    { repository: "other/repository" },
    {
      workflow_ref:
        "LumiCorp/kestrel/.github/workflows/other.yml@refs/heads/production",
    },
    { workflow_sha: "b".repeat(40) },
    { sha: "b".repeat(40) },
    { run_id: "987654321" },
    { run_attempt: "3" },
    { exp: nowSeconds },
  ]) {
    await assert.rejects(
      verifyEnvironmentRuntimeWorkflowToken({
        token: tokenFor(overrides),
        expectedWorkflowSha: revision,
        expectedRunId: "123456789",
        expectedRunAttempt: 2,
        now,
        fetchImpl: oidcFetch,
      }),
    );
  }
  const [header, encodedClaims] = tokenFor({}).split(".");
  await assert.rejects(
    verifyEnvironmentRuntimeWorkflowToken({
      token: `${header}.${encodedClaims}.${Buffer.alloc(256).toString("base64url")}`,
      expectedWorkflowSha: revision,
      expectedRunId: "123456789",
      expectedRunAttempt: 2,
      now,
      fetchImpl: oidcFetch,
    }),
    /signature is invalid/u,
  );
});

function tokenFor(overrides: Record<string, unknown>) {
  const header = encode({ alg: "RS256", kid: "test-key", typ: "JWT" });
  const claims = encode({
    iss: "https://token.actions.githubusercontent.com",
    aud: ENVIRONMENT_RUNTIME_PROMOTION_AUDIENCE,
    exp: nowSeconds + 300,
    nbf: nowSeconds - 30,
    repository: "LumiCorp/kestrel",
    ref: "refs/heads/production",
    workflow_ref: ENVIRONMENT_RUNTIME_WORKFLOW_REF,
    workflow_sha: revision,
    run_id: "123456789",
    run_attempt: "2",
    sha: revision,
    sub: "repo:LumiCorp/kestrel:ref:refs/heads/production",
    ...overrides,
  });
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), privateKey).toString("base64url");
  return `${header}.${claims}.${signature}`;
}

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function oidcFetch() {
  return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "test-key", alg: "RS256" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
