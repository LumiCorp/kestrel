import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  deriveHostedBrowserArtifactId,
  issueHostedBrowserArtifactUploadCapability,
  verifyHostedBrowserArtifactUploadCapability,
  type HostedBrowserArtifactIdentityV1,
} from "../../src/browser/hostedArtifactCapability.js";

const keys = generateKeyPairSync("ed25519");
const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const now = new Date("2026-08-30T12:00:00.000Z");
const identity: HostedBrowserArtifactIdentityV1 = {
  organizationId: "org-1",
  userId: "user-1",
  threadId: "thread-1",
  runId: "run-1",
  sessionId: "browser-session-1",
  generation: 1,
  callId: "call-capture-1",
  artifactKind: "browser-screenshot",
  byteLength: 9,
  sha256: "a".repeat(64),
};

test("hosted artifact capability verifies its exact deterministic identity", () => {
  const issued = issueHostedBrowserArtifactUploadCapability({
    identity,
    expiresAt: "2026-08-30T12:01:00.000Z",
    privateKeyPem,
    now,
  });
  assert.equal(issued.claims.artifactId, deriveHostedBrowserArtifactId(identity));
  assert.deepEqual(
    verifyHostedBrowserArtifactUploadCapability({
      token: issued.token,
      publicKeyPem,
      now,
    }),
    issued.claims,
  );
  assert.notEqual(
    deriveHostedBrowserArtifactId({ ...identity, callId: "call-capture-2" }),
    issued.claims.artifactId,
  );
});

test("hosted artifact capability rejects tampering and expiry", () => {
  const issued = issueHostedBrowserArtifactUploadCapability({
    identity,
    expiresAt: "2026-08-30T12:01:00.000Z",
    privateKeyPem,
    now,
  });
  const [payload, signature] = issued.token.split(".");
  assert.ok(payload && signature);
  const tamperedClaims = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  tamperedClaims.userId = "user-2";
  const tamperedPayload = Buffer.from(JSON.stringify(tamperedClaims), "utf8")
    .toString("base64url");
  assert.throws(() => verifyHostedBrowserArtifactUploadCapability({
    token: `${tamperedPayload}.${signature}`,
    publicKeyPem,
    now,
  }));
  assert.throws(() => verifyHostedBrowserArtifactUploadCapability({
    token: issued.token,
    publicKeyPem,
    now: new Date("2026-08-30T12:01:00.000Z"),
  }), /expired/u);
});
