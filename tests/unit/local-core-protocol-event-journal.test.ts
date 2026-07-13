import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EXECUTION_PROTOCOL_VERSION } from "@kestrel-agents/protocol";

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

test("Local Core protocol journal expires cursors from an older execution protocol", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-protocol-journal-version-"));
  try {
    const handle = await ensureLocalCoreStore({ homePath: home });
    const journal = new LocalCoreProtocolEventJournal(handle.executor);
    await journal.ready();
    const legacyCursor = runnerPong("event-legacy", "command-legacy", "legacy");
    await insertRawProtocolEvent(handle.executor, { ...legacyCursor }, { legacy: true });
    await journal.append(runnerPong("event-current", "command-current", "current"));

    const replayed: RunnerEvent[] = [];
    let boundaryCalls = 0;
    assert.deepEqual(
      await journal.replayAfter(
        legacyCursor.id,
        {},
        (event) => {
          replayed.push(event);
        },
        {
          onReplayBoundary: () => {
            boundaryCalls += 1;
          },
        },
      ),
      { status: "cursor_expired" },
    );
    assert.equal(boundaryCalls, 1);
    assert.deepEqual(replayed, []);
  } finally {
    await closeLocalCoreStore(home);
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core protocol journal rejects unknown event discriminants during replay", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-protocol-journal-event-type-"));
  try {
    const handle = await ensureLocalCoreStore({ homePath: home });
    const journal = new LocalCoreProtocolEventJournal(handle.executor);
    await journal.ready();
    const cursor = runnerPong("event-cursor", "command-cursor", "cursor");
    await journal.append(cursor);
    await insertRawProtocolEvent(handle.executor, {
      id: "event-unknown-type",
      type: "runner.unsupported",
      payload: {},
    });

    await assert.rejects(
      journal.replayAfter(cursor.id, {}, () => {}),
      /runner event/i,
    );
  } finally {
    await closeLocalCoreStore(home);
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core protocol journal rejects malformed event envelopes during replay", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-protocol-journal-envelope-"));
  try {
    const handle = await ensureLocalCoreStore({ homePath: home });
    const journal = new LocalCoreProtocolEventJournal(handle.executor);
    await journal.ready();
    const cursor = runnerPong("event-cursor", "command-cursor", "cursor");
    await journal.append(cursor);
    await insertRawProtocolEvent(handle.executor, {
      id: "event-missing-payload",
      type: "runner.pong",
    });

    await assert.rejects(
      journal.replayAfter(cursor.id, {}, () => {}),
      /runner event/i,
    );
  } finally {
    await closeLocalCoreStore(home);
    await rm(home, { recursive: true, force: true });
  }
});

async function insertRawProtocolEvent(
  executor: ConstructorParameters<typeof LocalCoreProtocolEventJournal>[0],
  event: Record<string, unknown>,
  options: { legacy?: boolean } = {},
): Promise<void> {
  const id = String(event.id);
  const type = String(event.type);
  const occurredAt = "2026-07-13T12:00:01.000Z";
  await executor.query(
    `INSERT INTO runner_protocol_events (
       event_id,
       event_type,
       occurred_at,
       run_id,
       session_id,
       thread_id,
       command_id,
       event_json
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      type,
      occurredAt,
      null,
      null,
      null,
      null,
      options.legacy === true ? {
        id,
        type,
        ts: occurredAt,
        ...event,
      } : {
        executionProtocolVersion: EXECUTION_PROTOCOL_VERSION,
        event: {
          id,
          type,
          ts: occurredAt,
          ...event,
        },
      },
    ],
  );
}

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
