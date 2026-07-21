import assert from "node:assert/strict";

import {
  SessionController,
  type SessionControllerContext,
} from "../../cli/app/SessionController.js";
import type { TuiSessionMeta } from "../../cli/contracts.js";
import { contractTest } from "../helpers/contract-test.js";


function makeSession(input: Partial<TuiSessionMeta> & { name: string; sessionId: string }): TuiSessionMeta {
  return {
    name: input.name,
    sessionId: input.sessionId,
    profileId: input.profileId ?? "reference",
    createdAt: input.createdAt ?? "2026-05-14T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-05-14T00:00:00.000Z",
    started: input.started ?? true,
    ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    ...(input.actSubmode !== undefined ? { actSubmode: input.actSubmode } : {}),
    ...(input.pendingWaitFor !== undefined ? { pendingWaitFor: input.pendingWaitFor } : {}),
    ...(input.lastRunStatus !== undefined ? { lastRunStatus: input.lastRunStatus } : {}),
  };
}

function createControllerForState(state: {
  activeSession: TuiSessionMeta;
  sessions: TuiSessionMeta[];
}): { controller: SessionController; history: string[] } {
  const history: string[] = [];
  const context = {
    uiStore: {
      getState: () => state,
    },
    appendHistoryLine: async (_role: "system", text: string) => {
      history.push(text);
    },
  } as unknown as SessionControllerContext;
  return {
    controller: new SessionController(context),
    history,
  };
}

contractTest("runtime.hermetic", "SessionController lists sessions with active, mode, wait, and run status markers", async () => {
  const activeSession = makeSession({
    name: "main",
    sessionId: "s-main",
    interactionMode: "build",
    actSubmode: "safe",
  });
  const waitingSession = makeSession({
    name: "blocked",
    sessionId: "s-blocked",
    interactionMode: "plan",
    pendingWaitFor: { kind: "user", eventType: "user.reply" },
    lastRunStatus: "WAITING",
  });
  const { controller, history } = createControllerForState({
    activeSession,
    sessions: [activeSession, waitingSession],
  });

  await controller.handleSessionsCommand();

  assert.equal(
    history[0],
    [
      "Sessions:",
      "main (active) -> s-main mode:Build",
      "blocked -> s-blocked mode:Plan waiting:user.reply status:waiting",
    ].join("\n"),
  );
});

contractTest("runtime.hermetic", "SessionController keeps switch and resume usage copy stable", async () => {
  const activeSession = makeSession({ name: "main", sessionId: "s-main" });
  const { controller, history } = createControllerForState({
    activeSession,
    sessions: [activeSession],
  });

  await controller.handleSwitchOrResumeCommand("switch", []);
  await controller.handleSwitchOrResumeCommand("resume", []);

  assert.deepEqual(history, [
    "Usage: /switch <name|session-id-fragment>",
    "Usage: /resume <name|session-id-fragment|recent>",
  ]);
});
