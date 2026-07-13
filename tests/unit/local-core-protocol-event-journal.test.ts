import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { RunnerEvent } from "../../cli/protocol/contracts.js";
import { LocalCoreProtocolEventJournal } from "../../src/localCore/protocolEventJournal.js";
import {
  closeLocalCoreStore,
  ensureLocalCoreStore,
} from "../../src/localCore/store.js";

test("Local Core protocol journal replays ordered SQL events across store recreation", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-protocol-journal-"));
  try {
    const firstHandle = await ensureLocalCoreStore({ homePath: home });
    const first = runnerPong("event-1", "command-1", "first");
    const unrelated = runnerPong("event-other", "command-other", "other", "run-other");
    const second = runnerPong("event-2", "command-2", "second");
    const journal = new LocalCoreProtocolEventJournal(firstHandle.executor);
    await journal.ready();
    await journal.append(first);
    await journal.append(unrelated);
    await journal.append(second);
    await closeLocalCoreStore(home);

    const restoredHandle = await ensureLocalCoreStore({ homePath: home });
    const restored = new LocalCoreProtocolEventJournal(restoredHandle.executor);
    await restored.ready();
    const replayed: RunnerEvent[] = [];
    assert.deepEqual(
      await restored.replayAfter(
        first.id,
        { runId: "run-journal" },
        (event) => {
          replayed.push(event);
        },
      ),
      { status: "ok" },
    );
    assert.deepEqual(replayed, [second]);
  } finally {
    await closeLocalCoreStore(home);
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core protocol journal rejects an unknown durable cursor", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-protocol-journal-cursor-"));
  try {
    const handle = await ensureLocalCoreStore({ homePath: home });
    const journal = new LocalCoreProtocolEventJournal(handle.executor);
    await journal.ready();
    await journal.append(runnerPong("event-1", "command-1", "first"));

    const replayed: RunnerEvent[] = [];
    assert.deepEqual(
      await journal.replayAfter(
        "missing-event",
        { runId: "run-journal" },
        (event) => {
          replayed.push(event);
        },
      ),
      { status: "cursor_unknown" },
    );
    assert.deepEqual(replayed, []);
  } finally {
    await closeLocalCoreStore(home);
    await rm(home, { recursive: true, force: true });
  }
});

function runnerPong(
  id: string,
  commandId: string,
  nonce: string,
  runId = "run-journal",
): RunnerEvent {
  return {
    id,
    type: "runner.pong",
    ts: "2026-07-13T12:00:00.000Z",
    runId,
    commandId,
    payload: { nonce },
  };
}
