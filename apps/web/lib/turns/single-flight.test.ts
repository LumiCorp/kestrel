import assert from "node:assert/strict";
import test from "node:test";
import { createSingleFlightOperation } from "./single-flight";

test("concurrent maintenance requests share one active drain", async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = createSingleFlightOperation(async () => {
    calls += 1;
    await gate;
  });

  const first = run();
  const second = run();
  assert.equal(first, second);
  assert.equal(calls, 1);

  release?.();
  await Promise.all([first, second]);
});

test("maintenance can run again after the active drain settles", async () => {
  let calls = 0;
  const run = createSingleFlightOperation(async () => {
    calls += 1;
  });

  await run();
  await run();
  assert.equal(calls, 2);
});
