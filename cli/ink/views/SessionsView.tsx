import React from "react";
import { Box, Text } from "ink";

import type {
  OperatorSupervisedChildSummary,
  TuiSessionMeta,
  ViewScrollState,
} from "../../contracts.js";
import { buildWindow } from "../store/UiStore.js";
import { theme } from "../theme/tokens.js";
import { truncate } from "../ui/format.js";
import { filterSessions } from "./sessionSelectors.js";
import { DetailDrawer } from "../components/DetailDrawer.js";
import { ScreenHeader } from "../components/ScreenHeader.js";
import { StatusChip } from "../components/StatusChip.js";

interface SessionsViewProps {
  sessions: TuiSessionMeta[];
  activeSessionName: string;
  query: string;
  scroll: ViewScrollState;
  listRows: number;
  detailDrawerOpen: boolean;
}

export function SessionsView(props: SessionsViewProps): React.JSX.Element {
  const filtered = filterSessions(props.sessions, props.query);
  const windowed = buildWindow(filtered, props.scroll, props.listRows);
  const selected = filtered[windowed.scroll.cursor];
  const selectedBlockerDiagnostics = selected !== undefined ? formatBlockerDiagnostics(selected) : undefined;

  return (
    <Box flexDirection="column" flexGrow={1}>
      <ScreenHeader
        title="Sessions"
        right={
          <StatusChip label={`${filtered.length}/${props.sessions.length}`} tone="muted" />
        }
      />

      <Box flexDirection="column" flexGrow={1}>
        {windowed.items.length === 0 ? (
          <Text color={theme.muted}>No sessions match query.</Text>
        ) : (
          windowed.items.map((session, index) => {
            const absoluteIndex = windowed.start + index;
            const selectedRow = absoluteIndex === windowed.scroll.cursor;
            const active = session.name === props.activeSessionName;
            const status = readSessionStatus(session);
            const compactName = truncate(session.name, 42);
            const childSummary = summarizeChildThreads(session.operatorState?.childThreads);
            const attention = summarizeSessionAttention(session);
            const activity = summarizeSessionActivity(session);
            return (
              <Text key={session.sessionId} color={theme.text}>
                {selectedRow ? ">" : " "} {active ? "*" : " "} {compactName} [{status}]
                {attention !== undefined ? ` ${attention}` : ""}
                {activity !== undefined ? ` ${activity}` : ""}
                {childSummary !== undefined ? ` childAgents:${childSummary.active}/${childSummary.total}` : ""}
              </Text>
            );
          })
        )}
      </Box>

      <DetailDrawer open={props.detailDrawerOpen} title="Session Details">
        {selected === undefined ? (
          <Text color={theme.muted}>Select a session to inspect details.</Text>
        ) : (
          <>
            <Text color={theme.text}>{selected.name}</Text>
            <Text color={theme.muted}>id={selected.sessionId}</Text>
            <Text color={theme.muted}>profile={selected.profileId}</Text>
            <Text color={theme.muted}>status={readSessionStatus(selected)}</Text>
            <Text color={theme.muted}>preview={selected.lastMessagePreview ?? "n/a"}</Text>
            <Text color={theme.muted}>updated={selected.updatedAt}</Text>
            <Text color={theme.muted}>focusedThread={selected.focusedThreadId ?? selected.operatorState?.focusedThreadId ?? selected.sessionId}</Text>
            <Text color={theme.text}>attention={summarizeSessionAttention(selected) ?? "none"}</Text>
            <Text color={theme.muted}>activity={summarizeSessionActivity(selected) ?? "idle"}</Text>
            <Text color={theme.muted}>inbox={formatInboxSummary(selected)}</Text>
            <Text color={theme.muted}>blocker={selected.operatorState?.blockReason?.summary ?? selected.operatorState?.dominantBlocker ?? "none"}</Text>
            {selectedBlockerDiagnostics !== undefined ? (
              <Text color={theme.muted}>blockerDiagnostics={selectedBlockerDiagnostics}</Text>
            ) : null}
            <Text color={theme.muted}>
              childThreads=
              {selected.operatorState?.childThreads !== undefined && selected.operatorState.childThreads.length > 0
                ? readChildThreadSummary(selected.operatorState.childThreads)
                : "not recorded"}
            </Text>
            <Text color={theme.muted}>checkpoint={formatCheckpointSummary(selected)}</Text>
            <Text color={theme.muted}>assembly={formatAssemblySummary(selected)}</Text>
            <Text color={theme.muted}>evidence={formatEvidenceSummary(selected)}</Text>
          </>
        )}
      </DetailDrawer>
    </Box>
  );
}

function readWaitingEventType(session: TuiSessionMeta): string | undefined {
  const pending = session.pendingWaitFor?.eventType;
  if (pending !== undefined) {
    return pending;
  }
  if (session.operatorState?.latestCheckpoint?.status === "PENDING") {
    return "checkpoint";
  }
  if ((session.operatorState?.inbox?.stalled ?? 0) > 0) {
    return "stalled";
  }
  if (session.operatorState?.childBlocker !== undefined) {
    return "delegation";
  }
  if (session.operatorState?.wait?.eventType !== undefined) {
    return session.operatorState.wait.eventType;
  }
  return undefined;
}

function readSessionStatus(session: TuiSessionMeta): string {
  const waitingEventType = readWaitingEventType(session);
  return waitingEventType !== undefined
    ? `WAITING:${waitingEventType}`
    : (session.lastRunStatus ?? "IDLE");
}

function summarizeSessionAttention(session: TuiSessionMeta): string | undefined {
  const pending = readWaitingEventType(session);
  if (pending !== undefined) {
    return `needs:${pending}`;
  }
  const inbox = session.operatorState?.inbox;
  if (inbox !== undefined && inbox.actionable > 0) {
    return `actionable:${inbox.actionable}`;
  }
  if (session.operatorState?.assembly?.compatibility?.status === "downgraded") {
    return "downgraded";
  }
  return undefined;
}

function summarizeSessionActivity(session: TuiSessionMeta): string | undefined {
  const nextAction = session.operatorState?.nextAction ?? session.operatorState?.recommendedAction?.code;
  if (nextAction !== undefined) {
    return `next:${truncate(nextAction, 24)}`;
  }
  const reasoning = session.operatorState?.latestReasoning?.message;
  if (reasoning !== undefined) {
    return `thinking:${truncate(reasoning, 24)}`;
  }
  return undefined;
}

function formatInboxSummary(session: TuiSessionMeta): string {
  const inbox = session.operatorState?.inbox;
  if (inbox === undefined) {
    return "not recorded";
  }
  return `total:${inbox.total} actionable:${inbox.actionable} approvals:${inbox.approvals} replies:${inbox.userInputs}`;
}

function formatCheckpointSummary(session: TuiSessionMeta): string {
  const checkpoint = session.operatorState?.latestCheckpoint;
  const fanIn = session.operatorState?.latestFanInDisposition;
  if (checkpoint === undefined && fanIn === undefined) {
    return "none";
  }
  return [
    checkpoint !== undefined ? `${checkpoint.status.toLowerCase()}:${checkpoint.recommendedAction}` : undefined,
    fanIn !== undefined ? `fan-in:${fanIn.status.toLowerCase()}` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");
}

function formatAssemblySummary(session: TuiSessionMeta): string {
  const assembly = session.operatorState?.assembly;
  if (assembly === undefined) {
    return "not recorded";
  }
  const provider = assembly.provider !== undefined ? `${assembly.provider.id}/${assembly.provider.model}` : undefined;
  return [
    assembly.label ?? assembly.bundleId ?? (assembly.mode === "implicit_legacy" ? "implicit/legacy" : undefined),
    provider,
    assembly.provider?.promptVariant !== undefined ? `variant:${assembly.provider.promptVariant}` : undefined,
    assembly.compatibility?.status !== undefined ? `compat:${assembly.compatibility.status}` : undefined,
    assembly.compatibility?.downgradeReason !== undefined ? `downgrade:${assembly.compatibility.downgradeReason}` : undefined,
  ]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(" ");
}

function formatEvidenceSummary(session: TuiSessionMeta): string {
  const evidence = session.operatorState?.latestEvidenceRecovery;
  if (evidence === undefined) {
    return "not recorded";
  }
  return [
    `attempts:${evidence.attempts}`,
    `lowSignal:${evidence.lowSignalAttempts}`,
    evidence.latestQuality !== undefined ? `quality:${evidence.latestQuality}` : undefined,
    evidence.terminalOutcome !== undefined ? `outcome:${evidence.terminalOutcome}` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");
}

function formatBlockerDiagnostics(session: TuiSessionMeta): string | undefined {
  const blocker = session.operatorState?.childBlocker;
  const chain = session.operatorState?.blockerChain;
  const chainDetails = session.operatorState?.childBlockerChainDetails;
  const parts = [
    blocker !== undefined
      ? `child:${blocker.childThreadId} delegation:${blocker.delegationId} status:${blocker.status.toLowerCase()}${blocker.reason !== undefined ? ` reason:${truncate(blocker.reason, 32)}` : ""}`
      : undefined,
    chain !== undefined && chain.length > 0 ? `chain:${chain.join(" -> ")}` : undefined,
    chainDetails !== undefined && chainDetails.length > 0
      ? `detail:${chainDetails
          .map((entry) =>
            [
              entry.threadId,
              entry.delegationId !== undefined ? `via:${entry.delegationId}` : undefined,
              `status:${entry.status.toLowerCase()}`,
              entry.waitEventType !== undefined ? `wait:${entry.waitEventType}` : undefined,
            ]
              .filter((value): value is string => value !== undefined && value.length > 0)
              .join("/"),
          )
          .join(",")}`
      : undefined,
  ].filter((value): value is string => value !== undefined && value.length > 0);

  return parts.length > 0 ? parts.join(" ") : undefined;
}

function summarizeChildThreads(
  children: OperatorSupervisedChildSummary[] | undefined,
): {
  total: number;
  active: number;
  superseded: number;
} | undefined {
  if (children === undefined || children.length === 0) {
    return undefined;
  }
  return {
    total: children.length,
    active: children.filter((child) => child.status === "RUNNING" || child.status === "WAITING").length,
    superseded: children.filter((child) => child.superseded === true).length,
  };
}

function readChildThreadSummary(
  children: OperatorSupervisedChildSummary[] | undefined,
): string {
  if (children === undefined || children.length === 0) {
    return "not recorded";
  }
  const waiting = children.filter((child) => child.status === "WAITING").length;
  const running = children.filter((child) => child.status === "RUNNING").length;
  const completed = children.filter((child) => child.status === "COMPLETED").length;
  const failed = children.filter((child) => child.status === "FAILED").length;
  const cancelled = children.filter((child) => child.delegationStatus === "CANCELLED").length;
  return `total:${children.length} running:${running} waiting:${waiting} completed:${completed} failed:${failed} cancelled:${cancelled}`;
}
