import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("durable turn events serialize on the parent row without a second lock authority", async () => {
  const source = await readFile(new URL("./store.ts", import.meta.url), "utf8");
  const appendTurnEvent = source.match(
    /async function appendTurnEvent[\s\S]*?\n\}\n\nasync function findNextQueuedTurn/u,
  )?.[0];

  assert.ok(appendTurnEvent, "appendTurnEvent implementation must remain discoverable");
  assert.match(
    appendTurnEvent,
    /from\(schema\.threadTurns\)[\s\S]*?\.for\("update"\)/u,
  );
  assert.doesNotMatch(appendTurnEvent, /pg_advisory_xact_lock/u);
  assert.doesNotMatch(appendTurnEvent, /thread-turn-events:/u);
});
