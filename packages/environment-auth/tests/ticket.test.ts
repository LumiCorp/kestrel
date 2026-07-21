import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  ENVIRONMENT_ROUTER_AUDIENCE,
  ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE,
  signEnvironmentExecutionTicket,
  signEnvironmentToolCredential,
  verifyEnvironmentExecutionTicket,
  verifyEnvironmentToolCredential,
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

contractTest("packages.hermetic", "execution tickets bind the complete routing identity", () => {
  const token = signEnvironmentExecutionTicket({ ticket, privateKey });
  assert.deepEqual(
    verifyEnvironmentExecutionTicket({ token, publicKey, now: 1100 }),
    ticket,
  );
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
