import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  HOSTED_BROWSER_CAPABILITY_VERSION,
  issueHostedBrowserOperationCapability,
  verifyHostedBrowserOperationCapability,
} from "./capability";

const keys = generateKeyPairSync("ed25519");
const privateKeyPem = keys.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const publicKeyPem = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const now = new Date("2026-08-30T12:00:00.000Z");
const expected = {
  version: HOSTED_BROWSER_CAPABILITY_VERSION,
  organizationId: "org-1",
  environmentId: "env-1",
  projectId: "project-1",
  userId: "user-1",
  threadId: "thread-1",
  sessionId: "session-1",
  generation: 2,
  operationId: "call-1",
  effectiveAllowlistRevision: "revision-4",
} as const;

test("operation capability binds every hosted Browser authority dimension", () => {
  const token = issueHostedBrowserOperationCapability({
    privateKeyPem,
    now,
    claims: {
      ...expected,
      expiresAt: "2026-08-30T12:00:30.000Z",
    },
  });
  assert.deepEqual(
    verifyHostedBrowserOperationCapability({
      token,
      publicKeyPem,
      expected,
      now,
    }),
    { ...expected, expiresAt: "2026-08-30T12:00:30.000Z" },
  );
  for (const [field, value] of [
    ["organizationId", "org-2"],
    ["environmentId", "env-2"],
    ["projectId", "project-2"],
    ["userId", "user-2"],
    ["threadId", "thread-2"],
    ["sessionId", "session-2"],
    ["generation", 3],
    ["operationId", "call-2"],
    ["effectiveAllowlistRevision", "revision-5"],
  ] as const) {
    assert.throws(() =>
      verifyHostedBrowserOperationCapability({
        token,
        publicKeyPem,
        expected: { ...expected, [field]: value },
        now,
      }),
    );
  }
});

test("workers cannot verify expired, altered, or wrong-key capabilities", () => {
  const token = issueHostedBrowserOperationCapability({
    privateKeyPem,
    now,
    claims: { ...expected, expiresAt: "2026-08-30T12:00:01.000Z" },
  });
  assert.throws(() =>
    verifyHostedBrowserOperationCapability({
      token,
      publicKeyPem,
      expected,
      now: new Date("2026-08-30T12:00:02.000Z"),
    }),
  );
  const wrong = generateKeyPairSync("ed25519").publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  assert.throws(() =>
    verifyHostedBrowserOperationCapability({
      token,
      publicKeyPem: wrong,
      expected,
      now,
    }),
  );
  const [payload, signature] = token.split(".");
  assert.ok(payload && signature);
  const alteredSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  assert.throws(() =>
    verifyHostedBrowserOperationCapability({
      token: `${payload}.${alteredSignature}`,
      publicKeyPem,
      expected,
      now,
    }),
  );
});
