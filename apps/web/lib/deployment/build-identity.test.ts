import assert from "node:assert/strict";
import nextConfig, {
  kestrelBuildIdentity,
} from "../../next.config";
import { resolveKestrelBuildIdentity } from "./build-identity";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const vercelRevision = "1".repeat(40);
const gitRevision = "2".repeat(40);
const legacyRevision = "3".repeat(40);

function resolve(
  env: Record<string, string | undefined>,
  readGitRevision: () => string | undefined | void = () => gitRevision
) {
  return resolveKestrelBuildIdentity({
    env,
    manifestVersion: "0.6.0",
    readGitRevision,
  });
}

contractTest("web.hermetic", "Kestrel One manifest version is canonical", () => {
  assert.deepEqual(
    resolve({ KESTREL_APP_VERSION: "0.6.0" }),
    { revision: gitRevision, source: "git", version: "0.6.0" }
  );
  assert.throws(
    () => resolve({ KESTREL_APP_VERSION: "0.5.1" }),
    /must match apps\/web\/package\.json/u
  );
});

contractTest("web.hermetic", "Vercel revision takes precedence over Git and legacy metadata", () => {
  let gitRead = false;
  assert.deepEqual(
    resolve(
      {
        KESTREL_BUILD_REVISION: legacyRevision,
        VERCEL_GIT_COMMIT_SHA: vercelRevision,
      },
      () => {
        gitRead = true;
        return gitRevision;
      }
    ),
    { revision: vercelRevision, source: "vercel", version: "0.6.0" }
  );
  assert.equal(gitRead, false);
});

contractTest("web.hermetic", "Git revision takes precedence over the legacy fallback", () => {
  assert.deepEqual(
    resolve({ KESTREL_BUILD_REVISION: legacyRevision }),
    { revision: gitRevision, source: "git", version: "0.6.0" }
  );
});

contractTest("web.hermetic", "legacy revision is used only when Vercel and Git metadata are absent", () => {
  assert.deepEqual(
    resolve({ KESTREL_BUILD_REVISION: legacyRevision }, () => {}),
    { revision: legacyRevision, source: "legacy", version: "0.6.0" }
  );
});

contractTest("web.hermetic", "malformed revisions are rejected before fallback", () => {
  assert.throws(
    () => resolve({ VERCEL_GIT_COMMIT_SHA: "short" }),
    /full 40-character Git commit SHA/u
  );
  assert.throws(
    () => resolve({}, () => "not-a-sha"),
    /full 40-character Git commit SHA/u
  );
  assert.throws(
    () =>
      resolve({ KESTREL_BUILD_REVISION: "not-a-sha" }, () => {}),
    /full 40-character Git commit SHA/u
  );
});

contractTest("web.hermetic", "production identity fails closed without a revision", () => {
  assert.throws(
    () => resolve({ VERCEL_ENV: "production" }, () => {}),
    /production builds require a full Git revision/u
  );
});

contractTest("web.hermetic", "non-production identity uses an explicit development marker", () => {
  assert.deepEqual(resolve({}, () => {}), {
    revision: "development",
    source: "development",
    version: "0.6.0",
  });
});

contractTest("web.hermetic", "Next configuration embeds non-placeholder build identity", () => {
  assert.equal(nextConfig.env?.KESTREL_APP_VERSION, "0.6.0");
  assert.equal(
    nextConfig.env?.KESTREL_BUILD_REVISION,
    kestrelBuildIdentity.revision
  );
  assert.match(kestrelBuildIdentity.revision, /^[0-9a-f]{40}$/u);
  assert.notEqual(kestrelBuildIdentity.version, "unknown");
  assert.notEqual(kestrelBuildIdentity.revision, "unknown");
});
