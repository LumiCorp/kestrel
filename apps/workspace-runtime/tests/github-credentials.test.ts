import assert from "node:assert/strict";
import test from "node:test";
import { requestGitHubToolCredential } from "../src/github-credentials.js";
import { WorkspaceRequestError } from "../src/security.js";

test("Workspace exchanges its execution ticket for a scoped GitHub credential", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const credential = await requestGitHubToolCredential({
    controlPlaneUrl: "https://kestrel.example",
    executionAuthorization: "Bearer execution-ticket",
    resourceId: "11111111-1111-4111-8111-111111111111",
    operation: "git.upload_pack",
    fetchImpl: async (url, init) => {
      capturedUrl = url.toString();
      capturedInit = init;
      return Response.json({ token: "scoped-token", expiresAt: 1060 });
    },
  });
  assert.equal(
    capturedUrl,
    "https://kestrel.example/api/runtime/github/credentials",
  );
  assert.equal(
    new Headers(capturedInit?.headers).get("authorization"),
    "Bearer execution-ticket",
  );
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    operation: "git.upload_pack",
    resourceId: "11111111-1111-4111-8111-111111111111",
  });
  assert.deepEqual(credential, {
    authorization: "Bearer scoped-token",
    expiresAt: 1060,
  });
});

test("Workspace binds push credentials to the candidate fingerprint", async () => {
  let body: unknown;
  await requestGitHubToolCredential({
    controlPlaneUrl: "https://kestrel.example",
    executionAuthorization: "Bearer execution-ticket",
    resourceId: "11111111-1111-4111-8111-111111111111",
    operation: "repository.push_agent_branch",
    candidateFingerprint: "candidate-sha256",
    fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ token: "push-token", expiresAt: 1060 });
    },
  });
  assert.deepEqual(body, {
    operation: "repository.push_agent_branch",
    resourceId: "11111111-1111-4111-8111-111111111111",
    candidateFingerprint: "candidate-sha256",
  });
});

test("Workspace preserves broker denial codes", async () => {
  await assert.rejects(
    requestGitHubToolCredential({
      controlPlaneUrl: "https://kestrel.example",
      executionAuthorization: "Bearer execution-ticket",
      resourceId: "11111111-1111-4111-8111-111111111111",
      operation: "git.upload_pack",
      fetchImpl: async () =>
        Response.json(
          { error: { code: "GITHUB_ACTOR_RESOURCE_DENIED" } },
          { status: 403 },
        ),
    }),
    (error: unknown) =>
      error instanceof WorkspaceRequestError &&
      error.status === 403 &&
      error.code === "GITHUB_ACTOR_RESOURCE_DENIED",
  );
});
