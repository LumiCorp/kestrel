import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  flyImageReleaseManifestV3Schema,
  FLY_IMAGE_ROLES,
  ROLE_IMAGE_REPOSITORIES,
} from "../apps/web/lib/releases/contracts.js";
import { RELEASE_CONTROLLER_CONTRACT_REVISION } from "../apps/web/lib/releases/controller-contract.js";
import {
  RELEASE_MIGRATION_HEAD,
  RELEASE_MIGRATION_HEAD_SQL_HASH,
  RELEASE_MIGRATION_HISTORY_LOCK_HASH,
} from "../apps/web/lib/releases/migration-identity.js";

const migrationSql = await readFile(
  `apps/web/lib/db/migrations/${RELEASE_MIGRATION_HEAD}.sql`,
);
const migrationHistoryLock = await readFile(
  "apps/web/lib/db/migrations/meta/history-lock.json",
);
assert.equal(sha256(migrationSql), RELEASE_MIGRATION_HEAD_SQL_HASH);
assert.equal(
  `sha256:${sha256(migrationHistoryLock)}`,
  RELEASE_MIGRATION_HISTORY_LOCK_HASH,
);

const revision = "a".repeat(40);
const digest = "b".repeat(64);
const completedAt = "2026-08-13T00:00:00.000Z";

const evidence = flyImageReleaseManifestV3Schema.parse({
  version: 3,
  attempt: {
    id: "11111111-1111-4111-8111-111111111111",
    githubRunId: "1",
    githubRunAttempt: 1,
    forceAll: true,
  },
  controllerContractRevision: RELEASE_CONTROLLER_CONTRACT_REVISION,
  bundleRevision: revision,
  trigger: "manual",
  migration: {
    changed: true,
    head: RELEASE_MIGRATION_HEAD,
    historyLockHash: RELEASE_MIGRATION_HISTORY_LOCK_HASH,
  },
  controller: {
    role: "release-controller",
    image: `registry.fly.io/kestrel-one-control-worker@sha256:${digest}`,
    sourceRevision: revision,
    inputFingerprint: `sha256:${digest}`,
    smoke: { status: "passed", command: "smoke controller", completedAt },
  },
  environmentGateway: { producedVersion: 3 },
  validation: {
    status: "passed",
    commands: ["pnpm validate"],
    completedAt,
  },
  components: FLY_IMAGE_ROLES.map((role) => ({
    role,
    image: `${ROLE_IMAGE_REPOSITORIES[role]}@sha256:${digest}`,
    sourceRevision: revision,
    inputFingerprint: `sha256:${digest}`,
    smoke: { status: "passed", command: `smoke ${role}`, completedAt },
    ...(role === "environment-router"
      ? { environmentGateway: { acceptedVersions: [2, 3] } }
      : {}),
    ...(role === "turn-worker"
      ? { configurationContractFingerprint: `sha256:${digest}` }
      : {}),
  })),
});

assert.equal(evidence.components.length, 5);
assert.equal(evidence.controller.role, "release-controller");
process.stdout.write(
  `${JSON.stringify({ status: "passed", evidence }, null, 2)}\n`,
);

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
