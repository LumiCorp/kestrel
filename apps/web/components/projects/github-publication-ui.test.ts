import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Project GitHub settings expose grants, private labels, and refresh", async () => {
  const source = await readFile(
    new URL("./github-project-repository-grants.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /Repository grants/u);
  assert.match(source, /Private/u);
  assert.match(source, /\/api\/apps\/github\/sync/u);
  assert.match(source, /repositoryIds/u);
  assert.match(source, /Workspace source/u);
});

test("Workspace GitHub publication requires a target and fingerprint review", async () => {
  const source = await readFile(
    new URL(
      "../../app/(workspace)/threads/[id]/workspace/workspace-client.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(source, /Select a repository/u);
  assert.match(source, /Push agent branch/u);
  assert.match(source, /Publish to main/u);
  assert.match(source, /selectedPublicationRepository\.isEmpty === true/u);
  assert.match(source, /Candidate: \{promotionPreview\?\.candidateFingerprint\}/u);
  assert.match(source, /will not[\s\S]*change the[\s\n]+repository visibility/u);
  assert.match(source, /payload\.error\?\.code/u);
  for (const code of [
    "GITHUB_REPOSITORY_NOT_SYNCED",
    "GITHUB_REPOSITORY_NOT_GRANTED",
    "GITHUB_REPOSITORY_READ_DENIED",
    "GITHUB_REPOSITORY_PUSH_DENIED",
    "GITHUB_REPOSITORY_INITIALIZATION_REQUIRED",
    "GITHUB_REPOSITORY_NOT_EMPTY",
    "GITHUB_PUSH_CANDIDATE_CHANGED",
    "GITHUB_CONTENT_NOT_FOUND",
  ]) {
    assert.match(source, new RegExp(code, "u"));
  }
});
