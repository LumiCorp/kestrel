import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { ENVIRONMENT_ROUTER_AUDIENCE, signEnvironmentExecutionTicket } from "@lumi/kestrel-environment-auth";
import { authorizeWorkspaceRequest, resolveWorkspacePath } from "../src/security.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


const keys = generateKeyPairSync("ed25519");
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const token = signEnvironmentExecutionTicket({
  privateKey,
  ticket: {
    version: 1,
    audience: ENVIRONMENT_ROUTER_AUDIENCE,
    organizationId: "org-1",
    environmentId: "env-1",
    machineId: "machine-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    runId: "run-1",
    actorId: "user-1",
    agentId: "kestrel-one",
    flyAppName: "app-1",
    flyMachineId: "machine-1",
    capabilities: ["run.stream"],
    issuedAt: 1000,
    expiresAt: 1300,
    nonce: "nonce-1",
  },
});

contractTest("services.hermetic", "Workspace service revalidates the signed tenant boundary", () => {
  assert.equal(authorizeWorkspaceRequest({
    authorization: `Bearer ${token}`,
    publicKey,
    workspaceId: "workspace-1",
    organizationId: "org-1",
    environmentId: "env-1",
    machineId: "machine-1",
    now: 1100,
  }).threadId, "thread-1");
  assert.throws(() => authorizeWorkspaceRequest({
    authorization: `Bearer ${token}`,
    publicKey,
    workspaceId: "workspace-2",
    organizationId: "org-1",
    environmentId: "env-1",
    now: 1100,
  }));
});

contractTest("services.hermetic", "Workspace paths cannot escape the mounted volume", () => {
  assert.equal(resolveWorkspacePath("/workspace", "src/app.ts"), "/workspace/src/app.ts");
  assert.throws(() => resolveWorkspacePath("/workspace", "../secret"));
});
