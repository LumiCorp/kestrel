import type React from "react";
import { Box, Text } from "ink";

import type {
  OperatorSupervisedChildSummary,
  TuiSessionMeta,
  ViewScrollState,
} from "../../contracts.js";
import type { OperatorChildResultSummary } from "../../../src/orchestration/contracts.js";
import { buildWindow } from "../store/UiStore.js";
import { theme } from "../theme/tokens.js";
import { truncate } from "../ui/format.js";
import { DetailDrawer } from "../components/DetailDrawer.js";
import { ScreenHeader } from "../components/ScreenHeader.js";
import { StatusChip } from "../components/StatusChip.js";

interface TasksViewProps {
  tasks: TuiSessionMeta[];
  scroll: ViewScrollState;
  listRows: number;
  detailDrawerOpen: boolean;
}

export function TasksView(props: TasksViewProps): React.JSX.Element {
  const windowed = buildWindow(props.tasks, props.scroll, props.listRows);
  const selected = props.tasks[windowed.scroll.cursor];

  return (
    <Box flexDirection="column" flexGrow={1}>
      <ScreenHeader
        title="Tasks"
        right={<StatusChip label={`${props.tasks.length}`} tone="muted" />}
      />
      <Box flexDirection="column" flexGrow={1}>
        {windowed.items.length === 0 ? (
          <Text color={theme.muted}>No child tasks for this session.</Text>
        ) : (
          windowed.items.map((session, index) => {
            const absoluteIndex = windowed.start + index;
            const selectedRow = absoluteIndex === windowed.scroll.cursor;
            const delegation = session.delegation;
            const status = readTaskStatus(session);
            const title = truncate(delegation?.title ?? session.name, 42);
            const provider = delegation !== undefined ? `${delegation.provider}/${delegation.model}` : session.profileId;
            const assembly = session.operatorState?.assembly?.label ?? session.operatorState?.assembly?.bundleId;
            const variant = session.operatorState?.assembly?.provider?.promptVariant;
            const compatibilityStatus = session.operatorState?.assembly?.compatibility?.status;
            const adaptationStatus = session.operatorState?.latestAdaptation?.status;
            const evidenceAttempts = session.operatorState?.latestEvidenceRecovery?.attempts;
            const childSummary = summarizeChildThreads(session.operatorState?.childThreads);
            return (
              <Text
                key={session.sessionId}
                color={theme.text}
              >
                {selectedRow ? ">" : " "} {title} [{status}] {truncate(provider, 28)}
                {assembly !== undefined ? ` ${truncate(assembly, 20)}` : ""}
                {variant !== undefined ? ` var:${truncate(variant, 16)}` : ""}
                {compatibilityStatus === "downgraded" ? " !downgraded" : ""}
                {adaptationStatus !== undefined ? ` adapt:${adaptationStatus}` : ""}
                {evidenceAttempts !== undefined ? ` ev:${evidenceAttempts}` : ""}
                {childSummary !== undefined ? ` children:${childSummary.active}/${childSummary.total}` : ""}
                {childSummary !== undefined && childSummary.superseded > 0 ? ` superseded:${childSummary.superseded}` : ""}
              </Text>
            );
          })
        )}
      </Box>

      <DetailDrawer open={props.detailDrawerOpen} title="Task Details">
        {selected?.delegation === undefined ? (
          <Text color={theme.muted}>Select a task to inspect details.</Text>
        ) : (
          <>
            <Text color={theme.text}>{selected.delegation.title}</Text>
            <Text color={theme.muted}>task={selected.delegation.taskId}</Text>
            <Text color={theme.muted}>session={selected.sessionId}</Text>
            <Text color={theme.muted}>
              provider={selected.delegation.provider}/{selected.delegation.model}
            </Text>
            <Text color={theme.muted}>status={selected.delegation.status}</Text>
            <Text color={theme.muted}>
              launchedBy={selected.delegation.launchedBy ?? "operator"}
            </Text>
            <Text color={theme.muted}>
              skill={selected.delegation.skillPackId ?? "none"}
            </Text>
            <Text color={theme.muted}>
              result={selected.delegation.resultSummary ?? "pending"}
            </Text>
            <Text color={theme.muted}>
              resultStatus={selected.delegation.result?.status ?? "not recorded"}
            </Text>
            <Text color={theme.muted}>
              errorCode={selected.delegation.errorCode ?? selected.delegation.result?.error?.code ?? "none"}
            </Text>
            <Text color={theme.muted}>
              references=
              {selected.delegation.references !== undefined && selected.delegation.references.length > 0
                ? selected.delegation.references.join(", ")
                : selected.delegation.result?.references !== undefined && selected.delegation.result.references.length > 0
                  ? selected.delegation.result.references.join(", ")
                  : "none"}
            </Text>
            <Text color={theme.muted}>
              assembly=
              {selected.operatorState?.assembly?.label ??
                selected.operatorState?.assembly?.bundleId ??
                (selected.operatorState?.assembly?.mode === "implicit_legacy" ? "implicit/legacy" : "not recorded")}
            </Text>
            <Text color={theme.muted}>
              assemblyProvider=
              {selected.operatorState?.assembly?.provider !== undefined
                ? `${selected.operatorState.assembly.provider.id}/${selected.operatorState.assembly.provider.model}`
                : "not recorded"}
            </Text>
            <Text color={theme.muted}>
              assemblyVariant={selected.operatorState?.assembly?.provider?.promptVariant ?? "not recorded"}
            </Text>
            <Text color={theme.muted}>
              compatibility={selected.operatorState?.assembly?.compatibility?.status ?? "not recorded"}
            </Text>
            <Text color={theme.muted}>
              compatibilitySource={selected.operatorState?.assembly?.compatibility?.decisionSource ?? "not recorded"}
            </Text>
            <Text color={theme.muted}>
              compatibilityProfile={selected.operatorState?.assembly?.compatibility?.compatibilityProfile ?? "not recorded"}
            </Text>
            <Text color={theme.muted}>
              downgradeReason={selected.operatorState?.assembly?.compatibility?.downgradeReason ?? "none"}
            </Text>
            <Text color={theme.muted}>
              capabilityLossReason={selected.operatorState?.assembly?.compatibility?.capabilityLossReason ?? "none"}
            </Text>
            <Text color={theme.muted}>
              blocker={selected.operatorState?.blockReason?.summary ?? "none"}
            </Text>
            <Text color={theme.muted}>
              dominantBlocker={selected.operatorState?.dominantBlocker ?? "none"}
            </Text>
            <Text color={theme.muted}>
              blockerChain=
              {selected.operatorState?.blockerChain !== undefined &&
              selected.operatorState.blockerChain.length > 0
                ? selected.operatorState.blockerChain.join(" -> ")
                : "not recorded"}
            </Text>
            <Text color={theme.muted}>
              childThreads=
              {selected.operatorState?.childThreads !== undefined && selected.operatorState.childThreads.length > 0
                ? readChildThreadSummary(selected.operatorState.childThreads)
                : "not recorded"}
            </Text>
            <Text color={theme.muted}>
              supervision=
              {selected.operatorState?.supervision !== undefined
                ? `${selected.operatorState.supervision.status} children:${selected.operatorState.supervision.childCount} active:${selected.operatorState.supervision.activeCount} terminal:${selected.operatorState.supervision.terminalCount}`
                : "not recorded"}
            </Text>
            <Text color={theme.muted}>
              childOutcomes=
              {selected.operatorState?.childThreads !== undefined && selected.operatorState.childThreads.length > 0
                ? selected.operatorState.childThreads
                    .map((child) => formatSubAgentFields(child.threadId, child))
                    .join(" | ")
                : "not recorded"}
            </Text>
            <Text color={theme.muted}>
              childResults=
              {selected.operatorState?.childResults !== undefined && selected.operatorState.childResults.length > 0
                ? selected.operatorState.childResults
                    .map((child) => formatSubAgentFields(child.threadId, child))
                    .join(" | ")
                : "not recorded"}
            </Text>
            <Text color={theme.muted}>
              supersededChildren=
              {selected.operatorState?.childThreads !== undefined &&
              selected.operatorState.childThreads.some((child) => child.superseded === true)
                ? selected.operatorState.childThreads
                    .filter((child) => child.superseded === true)
                    .map((child) => child.threadId)
                    .join(", ")
                : "none"}
            </Text>
            <Text color={theme.muted}>
              blockerChainDetail=
              {selected.operatorState?.childBlockerChainDetails !== undefined &&
              selected.operatorState.childBlockerChainDetails.length > 0
                ? selected.operatorState.childBlockerChainDetails
                    .map((entry) => {
                      const detail = [
                        entry.status.toLowerCase(),
                        entry.waitEventType,
                        entry.reason,
                      ].filter((value): value is string => value !== undefined);
                      return `${entry.threadId}${entry.delegationId !== undefined ? ` via ${entry.delegationId}` : ""}${detail.length > 0 ? ` (${detail.join(" | ")})` : ""}`;
                    })
                    .join(" -> ")
                : "not recorded"}
            </Text>
            <Text color={theme.muted}>
              checkpoint={selected.operatorState?.latestCheckpoint?.recommendedAction ?? "none"}
            </Text>
            <Text color={theme.muted}>
              checkpointDisposition={selected.operatorState?.latestCheckpointDisposition ?? "not recorded"}
            </Text>
            <Text color={theme.muted}>
              fanInCheckpoint=
              {selected.operatorState?.latestFanInDisposition !== undefined
                ? `${selected.operatorState.latestFanInDisposition.status}${selected.operatorState.latestFanInDisposition.checkpointId !== undefined ? ` (${selected.operatorState.latestFanInDisposition.checkpointId})` : ""}`
                : "not recorded"}
            </Text>
            <Text color={theme.muted}>
              steering={selected.operatorState?.latestSteering?.message ?? "none"}
            </Text>
            <Text color={theme.muted}>
              reasoning={selected.operatorState?.latestReasoning?.message ?? "not recorded"}
            </Text>
            <Text color={theme.muted}>
              nextAction={selected.operatorState?.nextAction ?? "not recorded"}
            </Text>
            <Text color={theme.muted}>
              contextPosture={selected.operatorState?.contextPosture ?? "not recorded"}
            </Text>
            <Text color={theme.muted}>
              adaptation=
              {selected.operatorState?.latestAdaptation !== undefined
                ? `${selected.operatorState.latestAdaptation.status} action=${selected.operatorState.latestAdaptation.recommendedAction ?? "not recorded"}`
                : "not recorded"}
            </Text>
            <Text color={theme.muted}>
              adaptationReason={selected.operatorState?.latestAdaptation?.reason ?? "not recorded"}
            </Text>
            <Text color={theme.muted}>
              evidenceRecovery=
              {selected.operatorState?.latestEvidenceRecovery !== undefined
                ? `attempts:${selected.operatorState.latestEvidenceRecovery.attempts} lowSignal:${selected.operatorState.latestEvidenceRecovery.lowSignalAttempts} consecutiveLowSignal:${selected.operatorState.latestEvidenceRecovery.consecutiveLowSignal}`
                : "not recorded"}
            </Text>
            <Text color={theme.muted}>
              evidenceQuality={selected.operatorState?.latestEvidenceRecovery?.latestQuality ?? "not recorded"}
            </Text>
            <Text color={theme.muted}>
              evidenceIssues=
              {selected.operatorState?.latestEvidenceRecovery?.latestIssues !== undefined &&
              selected.operatorState.latestEvidenceRecovery.latestIssues.length > 0
                ? selected.operatorState.latestEvidenceRecovery.latestIssues.join(", ")
                : "not recorded"}
            </Text>
            <Text color={theme.muted}>
              evidenceOutcome={selected.operatorState?.latestEvidenceRecovery?.terminalOutcome ?? "not recorded"}
            </Text>
          </>
        )}
      </DetailDrawer>
    </Box>
  );
}

function readTaskStatus(session: TuiSessionMeta): string {
  if (session.operatorState?.latestCheckpoint?.status === "PENDING") {
    return "WAITING:checkpoint";
  }
  if ((session.operatorState?.inbox?.stalled ?? 0) > 0) {
    return "WAITING:stalled";
  }
  if (session.operatorState?.childBlocker !== undefined) {
    return "WAITING:delegation";
  }
  if (session.operatorState?.wait?.eventType !== undefined) {
    return `WAITING:${session.operatorState.wait.eventType}`;
  }
  return session.delegation?.status ?? session.lastRunStatus ?? "IDLE";
}

function summarizeChildThreads(
  children: OperatorSupervisedChildSummary[] | undefined,
): {
  total: number;
  active: number;
  superseded: number;
} | undefined {
  if (children === undefined || children.length === 0) {
    return ;
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

function formatSubAgentFields(
  label: string,
  child: OperatorSupervisedChildSummary | OperatorChildResultSummary,
): string {
  const envelope = typeof child.result === "object" ? child.result : undefined;
  const resultText =
    "outcomeSummary" in child && child.outcomeSummary !== undefined
      ? child.outcomeSummary
      : typeof child.result === "string"
        ? child.result
        : envelope?.result;
  const resultStatus =
    "resultStatus" in child && child.resultStatus !== undefined
      ? child.resultStatus
      : envelope?.status;
  const errorCode = child.errorCode ?? envelope?.error?.code;
  const error =
    "errorMessage" in child && child.errorMessage !== undefined
      ? child.errorMessage
      : envelope?.error?.message;
  const references = child.references ?? envelope?.references;
  return [
    label,
    `status=${child.status}`,
    child.waitEventType !== undefined ? `wait=${child.waitEventType}` : undefined,
    resultStatus !== undefined ? `resultStatus=${resultStatus}` : undefined,
    resultText !== undefined ? `result=${truncate(resultText, 28)}` : undefined,
    errorCode !== undefined ? `errorCode=${errorCode}` : undefined,
    error !== undefined ? `error=${truncate(error, 28)}` : undefined,
    references !== undefined && references.length > 0 ? `references=${references.join(",")}` : undefined,
  ].filter((value): value is string => value !== undefined).join(" ");
}
