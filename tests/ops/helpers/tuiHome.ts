import { mkdir } from "node:fs/promises";
import path from "node:path";

import { HistoryStore } from "../../../cli/history/HistoryStore.js";
import { SessionStore } from "../../../cli/session/SessionStore.js";
import type { SessionsFile, TuiHistoryRecord, TuiSessionMeta } from "../../../cli/contracts.js";
import { OPS_FIXTURE_IDS } from "./fixtures.js";

export async function seedTuiHome(baseDir: string): Promise<void> {
  await mkdir(baseDir, { recursive: true });

  const now = "2026-03-16T12:40:00.000Z";
  const sessions: SessionsFile = {
    version: 4,
    activeSessionName: "ops-approval-child",
    sessions: [
      {
        name: "ops-root",
        sessionId: OPS_FIXTURE_IDS.root.sessionId,
        profileId: "reference",
        createdAt: now,
        updatedAt: now,
        started: true,
        lastRunStatus: "WAITING",
        lastMessagePreview: "Parent thread is blocked on child approval.",
        pendingWaitFor: {
          kind: "approval",
          eventType: "delegation.waiting",
          metadata: {
            prompt: "Child thread is waiting for approval.",
          },
        },
        delegation: {
          taskId: OPS_FIXTURE_IDS.root.delegationId,
          parentSessionId: OPS_FIXTURE_IDS.root.sessionId,
          parentRunId: OPS_FIXTURE_IDS.root.runId,
          title: "Investigate operator approval",
          status: "WAITING",
          childSessionId: OPS_FIXTURE_IDS.approvalChild.sessionId,
          childSessionName: "ops-approval-child",
          profileId: "reference",
          provider: "openrouter",
          model: "google/gemini-3.1-flash-lite-preview",
          waitEventType: "user.approval",
          launchedBy: "agent",
          createdAt: now,
          updatedAt: now,
        },
      } satisfies TuiSessionMeta,
      {
        name: "ops-approval-child",
        sessionId: OPS_FIXTURE_IDS.approvalChild.sessionId,
        profileId: "reference",
        createdAt: now,
        updatedAt: now,
        started: true,
        lastRunStatus: "WAITING",
        lastMessagePreview: "Approve child thread before continuing.",
        pendingWaitFor: {
          kind: "approval",
          eventType: "user.approval",
          metadata: {
            prompt: "Approve child thread before continuing.",
          },
        },
      } satisfies TuiSessionMeta,
      {
        name: "ops-mode-blocked",
        sessionId: OPS_FIXTURE_IDS.modeBlocked.sessionId,
        profileId: "reference",
        createdAt: now,
        updatedAt: now,
        started: true,
        lastRunStatus: "WAITING",
        lastMessagePreview: "Switch to Build to continue.",
        pendingWaitFor: {
          kind: "user",
          eventType: "user.mode_switch",
          metadata: {
            reason: "route_mode_blocked",
            requiredToolClass: "sandboxed_only",
            prompt: "Switch to Build to continue.",
          },
        },
      } satisfies TuiSessionMeta,
    ],
  };

  const home = path.join(baseDir, ".kestrel");
  const sessionStore = new SessionStore(home);
  await sessionStore.save(sessions);

  const historyStore = new HistoryStore(home);
  for (const record of historyRecords()) {
    await historyStore.append(record);
  }
}

function historyRecords(): TuiHistoryRecord[] {
  const now = "2026-03-16T12:40:01.000Z";
  return [
    {
      source: "runner",
      eventId: "hist-root",
      timestamp: now,
      sessionName: "ops-root",
      sessionId: OPS_FIXTURE_IDS.root.sessionId,
      profileId: "reference",
      role: "system",
      text: "Task waiting for 'user.approval'.",
    },
    {
      source: "runner",
      eventId: "hist-approval",
      timestamp: "2026-03-16T12:40:02.000Z",
      sessionName: "ops-approval-child",
      sessionId: OPS_FIXTURE_IDS.approvalChild.sessionId,
      profileId: "reference",
      role: "system",
      text: "Waiting for 'user.approval'. Approve child thread before continuing. Enter input to resume.",
    },
    {
      source: "runner",
      eventId: "hist-mode",
      timestamp: "2026-03-16T12:40:03.000Z",
      sessionName: "ops-mode-blocked",
      sessionId: OPS_FIXTURE_IDS.modeBlocked.sessionId,
      profileId: "reference",
      role: "system",
      text: "Waiting for 'user.mode_switch'. Required tool class: sandboxed_only. Switch to Build to continue. Switch with /mode build or reply 'switch to build', or reply with a narrower request.",
    },
  ];
}
