import assert from "node:assert/strict";
import test from "node:test";
import {
  githubRepositoryUpstreamUrl,
  isGitUploadPackRequest,
} from "./github-git-proxy-contract";

test("Git proxy exposes upload-pack reads and never receive-pack writes", () => {
  assert.equal(
    isGitUploadPackRequest({
      method: "GET",
      path: ["info", "refs"],
      service: "git-upload-pack",
    }),
    true
  );
  assert.equal(
    isGitUploadPackRequest({
      method: "GET",
      path: ["info", "refs"],
      service: "git-receive-pack",
    }),
    false
  );
  assert.equal(
    isGitUploadPackRequest({
      method: "POST",
      path: ["git-receive-pack"],
      service: null,
    }),
    false
  );
});

test("Git proxy derives the GitHub URL from the authorized resource", () => {
  assert.equal(
    githubRepositoryUpstreamUrl({
      repository: "acme/private repo",
      path: ["info", "refs"],
      search: "?service=git-upload-pack",
    }).toString(),
    "https://github.com/acme/private%20repo.git/info/refs?service=git-upload-pack"
  );
});
