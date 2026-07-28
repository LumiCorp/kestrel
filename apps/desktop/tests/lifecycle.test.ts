import assert from "node:assert/strict";

import {
  createDesktopBeforeQuitHandler,
  createDesktopShutdownPreparation,
} from "../src/lifecycle.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = () => {};
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

contractTest(
  "desktop.hermetic",
  "shutdown preparation drains project runs, adapters, runner, and database once in order",
  async () => {
    const order: string[] = [];
    const stopRuns = createDeferred();
    const preparation = createDesktopShutdownPreparation({
      stopProjectRuns: async () => {
        order.push("runs:start");
        await stopRuns.promise;
        order.push("runs:done");
      },
      closeAdapters: () => order.push("adapters"),
      stopRunner: () => order.push("runner"),
      closeDatabase: () => order.push("database"),
    });

    const first = preparation.prepare();
    const reentry = preparation.prepare();
    assert.equal(first, reentry);
    assert.deepEqual(order, ["runs:start"]);

    stopRuns.resolve();
    await Promise.all([first, reentry]);
    await preparation.prepare();
    assert.equal(preparation.isPrepared(), true);
    assert.deepEqual(order, [
      "runs:start",
      "runs:done",
      "adapters",
      "runner",
      "database",
    ]);
  },
);

contractTest(
  "desktop.hermetic",
  "failed update preparation rejects and can be retried",
  async () => {
    let attempts = 0;
    const preparation = createDesktopShutdownPreparation({
      stopProjectRuns() {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("drain failed");
        }
      },
    });

    await assert.rejects(preparation.prepare(), /drain failed/u);
    assert.equal(preparation.isPrepared(), false);
    await preparation.prepare();
    assert.equal(preparation.isPrepared(), true);
    assert.equal(attempts, 2);
  },
);

contractTest(
  "desktop.hermetic",
  "normal quit ignores cleanup failure, quits once, and ignores reentry",
  async () => {
    let prevented = 0;
    let quitCalls = 0;
    const preparation = createDesktopShutdownPreparation({
      stopProjectRuns() {
        throw new Error("stop failure");
      },
    });
    const handleBeforeQuit = createDesktopBeforeQuitHandler({
      preparation,
      quitApp: () => {
        quitCalls += 1;
      },
    });

    const event = {
      preventDefault() {
        prevented += 1;
      },
    };
    handleBeforeQuit(event);
    handleBeforeQuit(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(prevented, 1);
    assert.equal(quitCalls, 1);
  },
);
