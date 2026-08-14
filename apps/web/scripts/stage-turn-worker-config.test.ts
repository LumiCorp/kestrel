import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNoUnknownManagedTurnWorkerSecrets,
  TURN_WORKER_KNOWN_REMOVALS,
  turnWorkerSecretRemovalNames,
  turnWorkerSecretSetArgs,
} from "./stage-turn-worker-config";

test("turn-worker staging uses discrete staged secret arguments", () => {
  const args = turnWorkerSecretSetArgs({
    DATABASE_URL: "postgres://secret",
    REDIS_URL: "redis://secret",
  });
  assert.deepEqual(args.slice(0, 4), ["secrets", "set", "--stage", "--app"]);
  assert.ok(args.includes("DATABASE_URL=postgres://secret"));
  assert.ok(args.includes("REDIS_URL=redis://secret"));
});

test("turn-worker staging recognizes every explicit removal", () => {
  assert.doesNotThrow(() =>
    assertNoUnknownManagedTurnWorkerSecrets([...TURN_WORKER_KNOWN_REMOVALS]),
  );
});

test("turn-worker staging removes allowed optional secrets absent from canonical configuration", () => {
  assert.deepEqual(
    turnWorkerSecretRemovalNames(
      ["ANTHROPIC_API_KEY", "CRON_SECRET", "DATABASE_URL", "UNMANAGED"],
      { DATABASE_URL: "postgres://canonical" },
    ),
    ["ANTHROPIC_API_KEY", "CRON_SECRET"],
  );
});
