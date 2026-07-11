import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HistoryStore } from "../../cli/history/HistoryStore.js";
import { resolveLocalCoreStoreClient } from "../../cli/localCoreStoreClient.js";
import { SessionStore } from "../../cli/session/SessionStore.js";
import { WorkspaceStore } from "../../cli/workspace/WorkspaceStore.js";

test("Local Core shell store client ignores an inherited missing API socket", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-missing-core-socket-"));
  const missingSocketPath = path.join(home, "core", "api.sock");
  const env = {
    KESTREL_CORE_HOME: home,
    KESTREL_LOCAL_CORE_API_SOCKET: missingSocketPath,
    KESTREL_LOCAL_CORE_API_TOKEN: "token",
  };

  try {
    assert.equal(resolveLocalCoreStoreClient(home, env), undefined);

    await writeFile(path.join(home, "sessions.json"), JSON.stringify({
      version: 5,
      activeSessionName: "recoverable",
      sessions: [{
        name: "recoverable",
        sessionId: "session-recoverable",
        profileId: "reference",
        createdAt: "2026-07-06T00:00:00.000Z",
        updatedAt: "2026-07-06T00:00:00.000Z",
        started: true,
      }],
    }, null, 2), "utf8");

    const previousCoreHome = process.env.KESTREL_CORE_HOME;
    const previousSocket = process.env.KESTREL_LOCAL_CORE_API_SOCKET;
    const previousToken = process.env.KESTREL_LOCAL_CORE_API_TOKEN;
    try {
      process.env.KESTREL_CORE_HOME = home;
      process.env.KESTREL_LOCAL_CORE_API_SOCKET = missingSocketPath;
      process.env.KESTREL_LOCAL_CORE_API_TOKEN = "token";

      const sessions = await new SessionStore(home).load();
      assert.equal(sessions.activeSessionName, "recoverable");
      assert.equal(sessions.sessions[0]?.sessionId, "session-recoverable");

      await writeFile(path.join(home, "history.jsonl"), `${JSON.stringify({
        source: "runner",
        eventId: "event-1",
        sessionId: "session-recoverable",
        sessionName: "recoverable",
        profileId: "reference",
        timestamp: "2026-07-06T00:00:01.000Z",
        role: "assistant",
        text: "continued locally",
      })}\n`, "utf8");
      const transcript = await new HistoryStore(home).readTranscript("session-recoverable");
      assert.equal(transcript[0]?.text, "continued locally");

      await writeFile(path.join(home, "workspaces.json"), JSON.stringify({
        version: 3,
        workspaces: [{
          workspaceId: "ws-recoverable",
          rootPath: home,
          automationEnabled: false,
          discoveredAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:00:00.000Z",
        }],
      }, null, 2), "utf8");
      const workspaces = await new WorkspaceStore(home).load();
      assert.equal(workspaces.workspaces[0]?.workspaceId, "ws-recoverable");
    } finally {
      restoreEnv("KESTREL_CORE_HOME", previousCoreHome);
      restoreEnv("KESTREL_LOCAL_CORE_API_SOCKET", previousSocket);
      restoreEnv("KESTREL_LOCAL_CORE_API_TOKEN", previousToken);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
