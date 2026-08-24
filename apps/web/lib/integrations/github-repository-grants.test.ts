import assert from "node:assert/strict";
import test from "node:test";
import {
  parseGitHubRepositoryGrants,
  withGitHubRepositoryGrants,
} from "./github-repository-grants";

test("GitHub repository grants parse only stable provider IDs", () => {
  assert.deepEqual(
    parseGitHubRepositoryGrants({
      repositoryGrantsV1: [
        { repositoryId: "42", fullName: "acme/private" },
        { repositoryId: "", fullName: "invalid/empty-id" },
        { resourceId: crypto.randomUUID(), fullName: "invalid/resource-uuid" },
      ],
    }),
    [{ repositoryId: "42", fullName: "acme/private" }],
  );
});

test("GitHub repository grant updates preserve unrelated Project settings", () => {
  assert.deepEqual(
    withGitHubRepositoryGrants(
      { retained: true, repositoryGrantsV1: [] },
      [{ repositoryId: "42", fullName: "acme/private" }],
    ),
    {
      retained: true,
      repositoryGrantsV1: [
        { repositoryId: "42", fullName: "acme/private" },
      ],
    },
  );
});
