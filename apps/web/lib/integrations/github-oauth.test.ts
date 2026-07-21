import assert from "node:assert/strict";
import { mapGithubRepository } from "./github-oauth";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "repository mapping preserves GitHub's authoritative actor permissions", () => {
  const repository = mapGithubRepository({
    full_name: "acme/private-repo",
    default_branch: "main",
    private: true,
    html_url: "https://github.com/acme/private-repo",
    permissions: { pull: true, push: true, admin: false },
  });

  assert.deepEqual(repository, {
    externalId: "repository:acme/private-repo",
    fullName: "acme/private-repo",
    defaultBranch: "main",
    isPrivate: true,
    htmlUrl: "https://github.com/acme/private-repo",
    canPull: true,
    canPush: true,
    canAdmin: false,
  });
});
