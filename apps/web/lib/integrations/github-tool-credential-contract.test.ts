import test from "node:test";
import assert from "node:assert/strict";
import {
  ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE,
  type EnvironmentToolCredentialTicket,
} from "@lumi/kestrel-environment-auth";
import {
  githubCapabilityForCredentialRequest,
  githubCredentialOperationBinding,
  githubToolCredentialMatchesRequest,
  githubToolCredentialRequestSchema,
} from "./github-tool-credential-contract";


const resourceId = "11111111-1111-4111-8111-111111111111";

function ticket(
  overrides: Partial<EnvironmentToolCredentialTicket> = {}
): EnvironmentToolCredentialTicket {
  return {
    version: 1,
    audience: ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE,
    organizationId: "org-1",
    environmentId: "environment-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    runId: "run-1",
    actorId: "user-1",
    agentId: "agent-1",
    providerKey: "github",
    resourceId,
    capability: "repository.read",
    operation: "git.upload_pack",
    operationBinding: null,
    issuedAt: 1000,
    expiresAt: 1060,
    nonce: "nonce-1",
    ...overrides,
  };
}

test("GitHub read credentials bind upload-pack to one repository resource", () => {
  const request = githubToolCredentialRequestSchema.parse({
    operation: "git.upload_pack",
    resourceId,
  });
  assert.equal(
    githubCapabilityForCredentialRequest(request),
    "repository.read"
  );
  assert.equal(githubCredentialOperationBinding(request), null);
  assert.equal(
    githubToolCredentialMatchesRequest({ ticket: ticket(), request }),
    true
  );
  assert.equal(
    githubToolCredentialMatchesRequest({
      ticket: ticket({ resourceId: crypto.randomUUID() }),
      request,
    }),
    false
  );
});

test("GitHub push credentials bind the exact candidate fingerprint", () => {
  const candidateCommit = "a".repeat(40);
  const request = githubToolCredentialRequestSchema.parse({
    operation: "repository.push_agent_branch",
    resourceId,
    candidateFingerprint: "candidate-sha256",
    candidateCommit,
  });
  assert.equal(
    githubCapabilityForCredentialRequest(request),
    "repository.push_agent_branch"
  );
  const operationBinding = JSON.stringify({
    candidateFingerprint: "candidate-sha256",
    candidateCommit,
  });
  assert.equal(githubCredentialOperationBinding(request), operationBinding);
  assert.equal(
    githubToolCredentialMatchesRequest({
      ticket: ticket({
        capability: "repository.push_agent_branch",
        operation: "repository.push_agent_branch",
        operationBinding,
      }),
      request,
    }),
    true
  );
  assert.equal(
    githubToolCredentialMatchesRequest({
      ticket: ticket({
        capability: "repository.push_agent_branch",
        operation: "repository.push_agent_branch",
        operationBinding: "different-candidate",
      }),
      request,
    }),
    false
  );
});

test("GitHub initialization credentials bind approval, fingerprint, commit, and main", () => {
  const request = githubToolCredentialRequestSchema.parse({
    operation: "repository.initialize",
    resourceId,
    candidateFingerprint: "candidate-sha256",
    candidateCommit: "b".repeat(40),
    approvalId: "approval-1",
    branch: "main",
  });
  assert.equal(
    githubCapabilityForCredentialRequest(request),
    "repository.initialize",
  );
  assert.equal(
    githubCredentialOperationBinding(request),
    JSON.stringify({
      candidateFingerprint: "candidate-sha256",
      candidateCommit: "b".repeat(40),
      approvalId: "approval-1",
      branch: "main",
    }),
  );
});
