import test from "node:test";
import assert from "node:assert/strict";
import {
  mapGithubRepository,
  planGithubRepositoryReconciliation,
} from "./github-oauth";


test("repository mapping preserves GitHub's authoritative actor permissions", () => {
  const repository = mapGithubRepository({
    id: 42,
    node_id: "repository-node-42",
    full_name: "acme/private-repo",
    default_branch: "main",
    private: true,
    html_url: "https://github.com/acme/private-repo",
    permissions: { pull: true, push: true, admin: false },
  }, false);

  assert.deepEqual(repository, {
    repositoryId: "42",
    externalId: "repository-id:42",
    fullName: "acme/private-repo",
    defaultBranch: "main",
    isEmpty: false,
    isPrivate: true,
    htmlUrl: "https://github.com/acme/private-repo",
    canPull: true,
    canPush: true,
    canAdmin: false,
  });
});

test("repository reconciliation preserves IDs across rename, inserts new private repositories, and disables revoked resources", () => {
  const renamed = mapGithubRepository({
    id: 42,
    node_id: "repository-node-42",
    full_name: "acme/renamed-private-repo",
    default_branch: "main",
    private: true,
    html_url: "https://github.com/acme/renamed-private-repo",
    permissions: { pull: true, push: true, admin: false },
  }, false);
  const added = mapGithubRepository({
    id: 99,
    node_id: "repository-node-99",
    full_name: "acme/new-private-repo",
    default_branch: null,
    private: true,
    html_url: "https://github.com/acme/new-private-repo",
    permissions: { pull: true, push: true, admin: true },
  }, true);
  const plan = planGithubRepositoryReconciliation({
    existingResources: [
      {
        id: "resource-preserved",
        externalId: "repository:acme/old-name",
        label: "acme/old-name",
        metadata: { repositoryId: "42" },
      },
      {
        id: "resource-revoked",
        externalId: "repository:acme/revoked",
        label: "acme/revoked",
        metadata: { repositoryId: "77" },
      },
    ],
    repositories: [renamed, added],
  });
  assert.equal(plan.upserts[0]?.existing?.id, "resource-preserved");
  assert.equal(plan.upserts[0]?.repository.fullName, "acme/renamed-private-repo");
  assert.equal(plan.upserts[1]?.existing, null);
  assert.equal(plan.upserts[1]?.repository.isPrivate, true);
  assert.equal(plan.upserts[1]?.repository.isEmpty, true);
  assert.deepEqual(plan.disableResourceIds, ["resource-revoked"]);
});
