import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const route = fs.readFileSync(
  path.resolve(
    import.meta.dirname,
    "../../app/api/projects/[id]/schedules/[scheduleId]/test/route.ts",
  ),
  "utf8",
);

test("schedule test endpoint materializes and enqueues one durable run", () => {
  assert.match(route, /requestId: z\.string\(\)\.uuid\(\)/u);
  assert.match(route, /createProjectPromptScheduleTestRun/u);
  assert.match(route, /materializeProjectPromptScheduleRun\(run\.runId\)/u);
  assert.match(route, /enqueueDurableThreadTurn\(turnId\)/u);
  assert.match(route, /failProjectPromptScheduleRun/u);
  assert.match(route, /\{ runId: run\.runId, threadId: run\.threadId \}/u);
});
