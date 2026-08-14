import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyGithubActionsReleaseToken } from "./github-oidc";

const revision = "a".repeat(40);
const now = new Date("2026-08-03T12:00:00.000Z");
const nowSeconds = Math.floor(now.getTime() / 1000);
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = publicKey.export({ format: "jwk" });

test("GitHub release OIDC accepts only the exact main release workflow", async () => {
  const token = tokenFor({ sha: revision });
  const claims = await verifyGithubActionsReleaseToken({
    token,
    expectedSha: revision,
    now,
    fetchImpl: oidcFetch,
  });
  assert.equal(claims.sha, revision);
  assert.equal(claims.run_id, "123456789");
  assert.equal(claims.run_attempt, "2");

  await assert.rejects(
    verifyGithubActionsReleaseToken({
      token,
      expectedSha: "b".repeat(40),
      now,
      fetchImpl: oidcFetch,
    }),
    /SHA does not match/u,
  );
});

test("GitHub release OIDC rejects another workflow or audience", async () => {
  await assert.rejects(
    verifyGithubActionsReleaseToken({
      token: tokenFor({
        workflow_ref:
          "LumiCorp/kestrel/.github/workflows/ci.yml@refs/heads/main",
      }),
      expectedSha: revision,
      now,
      fetchImpl: oidcFetch,
    }),
  );
  await assert.rejects(
    verifyGithubActionsReleaseToken({
      token: tokenFor({ aud: "another-service" }),
      expectedSha: revision,
      now,
      fetchImpl: oidcFetch,
    }),
    /wrong audience/u,
  );
});

test("GitHub release OIDC requires signed run identity claims", async () => {
  await assert.rejects(
    verifyGithubActionsReleaseToken({
      token: tokenFor({ run_id: undefined }),
      expectedSha: revision,
      now,
      fetchImpl: oidcFetch,
    }),
  );
  await assert.rejects(
    verifyGithubActionsReleaseToken({
      token: tokenFor({ run_attempt: "0" }),
      expectedSha: revision,
      now,
      fetchImpl: oidcFetch,
    }),
  );
});

function tokenFor(overrides: Record<string, unknown>) {
  const header = encode({ alg: "RS256", kid: "test-key", typ: "JWT" });
  const claims = encode({
    iss: "https://token.actions.githubusercontent.com",
    aud: "kestrel-one-release-publisher",
    exp: nowSeconds + 300,
    nbf: nowSeconds - 30,
    repository: "LumiCorp/kestrel",
    ref: "refs/heads/main",
    workflow_ref:
      "LumiCorp/kestrel/.github/workflows/fly-image-release.yml@refs/heads/main",
    run_id: "123456789",
    run_attempt: "2",
    sha: revision,
    sub: "repo:LumiCorp/kestrel:ref:refs/heads/main",
    ...overrides,
  });
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${claims}`),
    privateKey,
  ).toString("base64url");
  return `${header}.${claims}.${signature}`;
}

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function oidcFetch(_input: string | URL | Request, _init?: RequestInit) {
  return new Response(
    JSON.stringify({ keys: [{ ...jwk, kid: "test-key", alg: "RS256" }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
