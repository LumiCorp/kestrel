import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ENVIRONMENT_ROUTER_AUDIENCE, signEnvironmentExecutionTicket } from "@lumi/kestrel-environment-auth";
import { authorizeWorkspaceRequest, resolveWorkspacePath, WorkspaceRequestError } from "../src/security.js";


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

const logicalToken = signEnvironmentExecutionTicket({
  privateKey,
  ticket: {
    version: 3,
    audience: ENVIRONMENT_ROUTER_AUDIENCE,
    organizationId: "org-1",
    environmentId: "env-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    runId: "run-3",
    actorId: "user-1",
    agentId: "kestrel-one",
    target: { kind: "gateway", gatewayId: "gateway-resource-1" },
    capabilities: ["run.stream"],
    issuedAt: 1000,
    expiresAt: 1300,
    nonce: "nonce-3",
  },
});

test("Workspace service accepts logical v3 scope without Fly identity", () => {
  assert.equal(authorizeWorkspaceRequest({
    authorization: `Bearer ${logicalToken}`,
    publicKey,
    workspaceId: "workspace-1",
    organizationId: "org-1",
    environmentId: "env-1",
    now: 1100,
  }).threadId, "thread-1");
});

test("Workspace service revalidates the signed tenant boundary", () => {
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

test("Workspace service exposes the typed execution expiry", () => {
  assert.throws(
    () => authorizeWorkspaceRequest({
      authorization: `Bearer ${token}`,
      publicKey,
      workspaceId: "workspace-1",
      organizationId: "org-1",
      environmentId: "env-1",
      machineId: "machine-1",
      now: 1301,
    }),
    (error: unknown) =>
      error instanceof WorkspaceRequestError &&
      error.code === "EXECUTION_AUTH_EXPIRED",
  );
});

test("Workspace paths cannot escape the mounted volume", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-workspace-security-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "app.ts"), "export {};");
    assert.equal(
      await resolveWorkspacePath(root, "src/app.ts"),
      path.join(await realpath(root), "src", "app.ts"),
    );
    await assert.rejects(resolveWorkspacePath(root, "../secret"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Workspace paths reject external symlinks for existing and missing targets", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "kestrel-workspace-security-"));
  const root = path.join(parent, "workspace");
  const external = path.join(parent, "external");
  try {
    await mkdir(root);
    await mkdir(external);
    await writeFile(path.join(external, "secret.txt"), "secret");
    await symlink(external, path.join(root, "escape"));

    for (const requested of ["escape/secret.txt", "escape/new-file.txt"]) {
      await assert.rejects(
        resolveWorkspacePath(root, requested),
        (error: unknown) =>
          error instanceof WorkspaceRequestError &&
          error.status === 403 &&
          error.code === "WORKSPACE_PATH_FORBIDDEN",
      );
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
