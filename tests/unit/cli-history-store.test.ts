import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { HistoryStore } from "../../cli/history/HistoryStore.js";

test("HistoryStore merges legacy split assistant segments on read", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-history-store-"));
  const store = new HistoryStore(tempDir);

  await store.append({
    source: "runner",
    eventId: "evt-1",
    timestamp: "2026-03-14T13:15:10.000Z",
    sessionName: "alpha",
    sessionId: "session-1",
    profileId: "reference",
    role: "assistant",
    text: "Across the seas, where iron borders stand,",
    run: {
      runId: "run-1",
      status: "COMPLETED",
      telemetry: {
        stepsExecuted: 1,
        toolCalls: 0,
        modelCalls: 1,
        durationMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
      errors: [],
    },
  });
  await store.append({
    source: "runner",
    eventId: "evt-2",
    timestamp: "2026-03-14T13:15:10.400Z",
    sessionName: "alpha",
    sessionId: "session-1",
    profileId: "reference",
    role: "assistant",
    text: "And pray the far-off cells admit the light.",
  });

  const transcript = await store.readTranscript("session-1");

  assert.equal(transcript.length, 1);
  assert.equal(
    transcript[0]?.text,
    "Across the seas, where iron borders stand,\nAnd pray the far-off cells admit the light.",
  );
  assert.equal(transcript[0]?.run?.runId, "run-1");
});

test("HistoryStore does not merge distinct assistant turns", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-history-store-distinct-"));
  const store = new HistoryStore(tempDir);

  await store.append({
    source: "runner",
    eventId: "evt-1",
    timestamp: "2026-03-14T13:15:10.000Z",
    sessionName: "alpha",
    sessionId: "session-1",
    profileId: "reference",
    role: "assistant",
    text: "First answer.",
    run: {
      runId: "run-1",
      status: "COMPLETED",
      telemetry: {
        stepsExecuted: 1,
        toolCalls: 0,
        modelCalls: 1,
        durationMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
      errors: [],
    },
  });
  await store.append({
    source: "runner",
    eventId: "evt-2",
    timestamp: "2026-03-14T13:15:12.200Z",
    sessionName: "alpha",
    sessionId: "session-1",
    profileId: "reference",
    role: "assistant",
    text: "Second answer.",
    run: {
      runId: "run-2",
      status: "COMPLETED",
      telemetry: {
        stepsExecuted: 1,
        toolCalls: 0,
        modelCalls: 1,
        durationMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
      errors: [],
    },
  });

  const transcript = await store.readTranscript("session-1");

  assert.equal(transcript.length, 2);
  assert.equal(transcript[0]?.text, "First answer.");
  assert.equal(transcript[1]?.text, "Second answer.");
});

test("HistoryStore derives session overviews for launch summaries and artifacts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-history-store-overview-"));
  const store = new HistoryStore(tempDir);

  await store.append({
    source: "runner",
    eventId: "evt-launch",
    timestamp: "2026-03-20T10:00:00.000Z",
    sessionName: "alpha",
    sessionId: "session-1",
    profileId: "reference",
    role: "system",
    text: "Task=Alpha · Profile=Reference · Mode=plan · Workspace=workspace=demo · Launch=empty",
  });
  await store.append({
    source: "runner",
    eventId: "evt-answer",
    timestamp: "2026-03-20T10:01:00.000Z",
    sessionName: "alpha",
    sessionId: "session-1",
    profileId: "reference",
    role: "assistant",
    text: "Wrapped up the investigation.",
    data: {
      ui: {
        artifacts: [{ id: "artifact-1", kind: "console" }],
      },
    },
  });

  const overview = await store.readSessionOverviews(["session-1"]);

  assert.equal(
    overview["session-1"]?.launchSummary,
    "Task=Alpha · Profile=Reference · Mode=plan · Workspace=workspace=demo · Launch=empty",
  );
  assert.equal(overview["session-1"]?.hasSummary, true);
  assert.equal(overview["session-1"]?.hasArtifacts, true);
  assert.equal(overview["session-1"]?.restartAvailable, true);
});
