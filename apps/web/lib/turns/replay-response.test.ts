import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isDurableTurnReplayComplete } from "./replay-status";

const replayResponseSource = readFileSync(
  new URL("./replay-response.ts", import.meta.url),
  "utf8"
);

test("a waiting durable turn closes its current replay stream", () => {
  assert.equal(isDurableTurnReplayComplete("waiting_for_input"), true);
  assert.equal(isDurableTurnReplayComplete("completed"), true);
  assert.equal(isDurableTurnReplayComplete("failed"), true);
  assert.equal(isDurableTurnReplayComplete("cancelled"), true);
  assert.equal(isDurableTurnReplayComplete("queued"), false);
  assert.equal(isDurableTurnReplayComplete("running"), false);
});

test("durable replay responses close before the serverless hard timeout", () => {
  const match = replayResponseSource.match(
    /DURABLE_TURN_REPLAY_RESPONSE_MAX_MS\s*=\s*(\d+)_000/u
  );
  assert.ok(match, "replay response timeout must be explicit");
  const maxMs = Number(match[1]) * 1000;
  assert.ok(
    maxMs < 300_000,
    "replay responses must close before Vercel's 300 second runtime timeout"
  );
  assert.ok(
    maxMs >= 30_000,
    "replay responses should stay open long enough to avoid hot polling"
  );
  assert.match(replayResponseSource, /Date\.now\(\)\s*<\s*deadline/u);
});
