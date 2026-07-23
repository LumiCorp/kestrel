import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  ENVIRONMENT_ROUTER_AUDIENCE,
  ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE,
  PREVIEW_RELAY_TICKET_AUDIENCE,
  PREVIEW_RELAY_TICKET_VERSION,
  signEnvironmentExecutionTicket,
  signEnvironmentToolCredential,
  signPreviewRelayTicket,
  verifyEnvironmentExecutionTicket,
  verifyEnvironmentToolCredential,
  verifyPreviewRelayTicket,
  WORKSPACE_READINESS_TIMEOUT_MS,
  WORKSPACE_READINESS_TIMEOUT_SECONDS,
  type EnvironmentExecutionTicket,
  type EnvironmentToolCredentialTicket,
} from "../src/index.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


const keys = generateKeyPairSync("ed25519");
const privateKey = keys.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const publicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const ticket: EnvironmentExecutionTicket = {
  version: 1,
  audience: ENVIRONMENT_ROUTER_AUDIENCE,
  organizationId: "org-1",
  environmentId: "env-1",
  workspaceId: "workspace-1",
  threadId: "thread-1",
  runId: "run-1",
  actorId: "user-1",
  agentId: "kestrel-one",
  flyAppName: "kestrel-env-1",
  flyMachineId: "machine-1",
  capabilities: ["run.stream", "profile.read"],
  issuedAt: 1000,
  expiresAt: 1300,
  nonce: "nonce-1",
};

contractTest(
  "packages.hermetic",
  "Workspace readiness uses the shared 120 second budget",
  () => {
    assert.equal(WORKSPACE_READINESS_TIMEOUT_SECONDS, 120);
    assert.equal(
      WORKSPACE_READINESS_TIMEOUT_MS,
      WORKSPACE_READINESS_TIMEOUT_SECONDS * 1000,
    );
  },
);

contractTest("packages.hermetic", "execution tickets bind the complete routing identity", () => {
  const token = signEnvironmentExecutionTicket({ ticket, privateKey });
  assert.deepEqual(
    verifyEnvironmentExecutionTicket({ token, publicKey, now: 1100 }),
    ticket,
  );
});

contractTest("packages.hermetic", "preview relay tickets bind one hostname, Workspace Machine, and loopback port", () => {
  const relayTicket = {
    version: PREVIEW_RELAY_TICKET_VERSION,
    audience: PREVIEW_RELAY_TICKET_AUDIENCE,
    organizationId: "org-1",
    environmentId: "environment-1",
    workspaceId: "workspace-1",
    flyAppName: "kestrel-env-1",
    flyMachineId: "machine-1",
    previewId: "preview-1",
    hostname: "p-one.previews.example.com",
    port: 5173,
    issuedAt: 1000,
    expiresAt: 1120,
    nonce: "relay-nonce",
  } as const;
  const token = signPreviewRelayTicket({ ticket: relayTicket, privateKey });
  assert.deepEqual(
    verifyPreviewRelayTicket({ token, publicKey, now: 1050 }),
    relayTicket
  );
  assert.throws(() => verifyPreviewRelayTicket({ token: `${token}x`, publicKey, now: 1050 }));
  assert.throws(() => verifyPreviewRelayTicket({ token, publicKey, now: 1120 }));
});

contractTest("packages.hermetic", "execution tickets reject tampering, expiration, and excessive lifetime", () => {
  const token = signEnvironmentExecutionTicket({ ticket, privateKey });
  assert.throws(() =>
    verifyEnvironmentExecutionTicket({
      token: `${token}x`,
      publicKey,
      now: 1100,
    }),
  );
  assert.throws(() =>
    verifyEnvironmentExecutionTicket({ token, publicKey, now: 1300 }),
  );
  assert.throws(() =>
    signEnvironmentExecutionTicket({
      ticket: { ...ticket, expiresAt: 1301 },
      privateKey,
    }),
  );
});

const toolCredential: EnvironmentToolCredentialTicket = {
  version: 1,
  audience: ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE,
  organizationId: "org-1",
  environmentId: "env-1",
  workspaceId: "workspace-1",
  threadId: "thread-1",
  runId: "run-1",
  actorId: "user-1",
  agentId: "kestrel-one",
  providerKey: "github",
  resourceId: "resource-1",
  capability: "repository.read",
  operation: "git.upload_pack",
  operationBinding: null,
  issuedAt: 1000,
  expiresAt: 1060,
  nonce: "tool-nonce-1",
};

contractTest("packages.hermetic", "tool credentials bind one provider resource capability and operation", () => {
  const token = signEnvironmentToolCredential({
    ticket: toolCredential,
    privateKey,
  });
  assert.deepEqual(
    verifyEnvironmentToolCredential({ token, publicKey, now: 1030 }),
    toolCredential,
  );
  assert.throws(() =>
    verifyEnvironmentExecutionTicket({ token, publicKey, now: 1030 }),
  );
});

contractTest("packages.hermetic", "tool credentials reject tampering expiration and lifetimes over one minute", () => {
  const token = signEnvironmentToolCredential({
    ticket: toolCredential,
    privateKey,
  });
  assert.throws(() =>
    verifyEnvironmentToolCredential({
      token: `${token}x`,
      publicKey,
      now: 1030,
    }),
  );
  assert.throws(() =>
    verifyEnvironmentToolCredential({ token, publicKey, now: 1060 }),
  );
  assert.throws(() =>
    signEnvironmentToolCredential({
      ticket: { ...toolCredential, expiresAt: 1061 },
      privateKey,
    }),
  );
});
