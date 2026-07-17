import type React from "react";
import { Box, Text } from "ink";

import type { ViewScrollState } from "../../contracts.js";
import type {
  OperatorDelegationChildEntry,
  OperatorDelegationOutcomeEntry,
  OperatorDelegationWorkspaceSnapshot,
} from "../../../src/operatorShell.js";
import { buildWindow } from "../store/UiStore.js";
import { theme } from "../theme/tokens.js";
import { DetailDrawer } from "../components/DetailDrawer.js";
import { ScreenHeader } from "../components/ScreenHeader.js";
import { StatusChip } from "../components/StatusChip.js";

interface DelegationReviewViewProps {
  snapshot: OperatorDelegationWorkspaceSnapshot;
  scroll: ViewScrollState;
  listRows: number;
  detailDrawerOpen: boolean;
}

export function DelegationReviewView(props: DelegationReviewViewProps): React.JSX.Element {
  const actions = props.snapshot.primaryActions.concat(props.snapshot.secondaryActions);
  const windowed = buildWindow(actions, props.scroll, props.listRows);
  const selected = actions[windowed.scroll.cursor];

  return (
    <Box flexDirection="column" flexGrow={1}>
      <ScreenHeader
        title="Delegation Review"
        right={<StatusChip label={`${props.snapshot.childThreads.length} child`} tone={props.snapshot.issueFlags.length > 0 ? "warn" : "muted"} />}
      />
      <Text color={theme.text}>{props.snapshot.headline}</Text>
      <Text color={theme.muted}>{props.snapshot.subline}</Text>
      <Text color={theme.muted}>{props.snapshot.statusChips.join(" · ")}</Text>
      {props.snapshot.nextActions !== undefined && props.snapshot.nextActions.orderedActions.length > 0 ? (
        <Text color={theme.muted}>
          What can I do next? {props.snapshot.nextActions.orderedActions.map((action) => action.label).join(" · ")}
        </Text>
      ) : null}
      <Text color={theme.muted}>next-valid={props.snapshot.nextValidActionSummary ?? "not recorded"}</Text>
      {props.snapshot.issueFlags.length > 0 ? (
        <Text color={theme.warn}>issues={props.snapshot.issueFlags.join(" | ")}</Text>
      ) : null}
      <Box marginTop={1} flexDirection="column" flexGrow={1}>
        {windowed.items.map((action, index) => {
          const absoluteIndex = windowed.start + index;
          const selectedRow = absoluteIndex === windowed.scroll.cursor;
          return (
            <Text key={action.id} color={theme.text}>
              {selectedRow ? ">" : " "} {action.label}
            </Text>
          );
        })}
      </Box>
      <DetailDrawer open={props.detailDrawerOpen} title="Delegation Details">
        <Text color={theme.text}>{props.snapshot.sessionTitle}</Text>
        <Text color={theme.muted}>recommended={props.snapshot.recommendedLabel}</Text>
        <Text color={theme.muted}>profile={props.snapshot.profileLabel}</Text>
        <Text color={theme.muted}>workspace={props.snapshot.workspaceLabel ?? "not recorded"}</Text>
        <Text color={theme.muted}>selected={selected?.label ?? "none"}</Text>
        <Text color={theme.muted}>next={props.snapshot.nextActionSummary ?? "not recorded"}</Text>
        <Text color={theme.muted}>next-valid={props.snapshot.nextValidActionSummary ?? "not recorded"}</Text>
        <Text color={theme.muted}>fan-in={props.snapshot.fanInSummary ?? "not recorded"}</Text>
        <Text color={theme.muted}>blocker={props.snapshot.activeBlocker ?? "not recorded"}</Text>
        {props.snapshot.missionDraft !== undefined ? (
          <>
            <Text color={theme.muted}>mission={props.snapshot.missionDraft.title}</Text>
            <Text color={theme.muted}>scope={props.snapshot.missionDraft.scope}</Text>
            <Text color={theme.muted}>return={props.snapshot.missionDraft.returnCondition}</Text>
            <Text color={theme.muted}>mode={props.snapshot.missionDraft.modeLabel}</Text>
          </>
        ) : null}
        <Text color={theme.muted}>children={props.snapshot.childThreads.length}</Text>
        {props.snapshot.childThreads.map((child) => (
          <Text key={child.threadId} color={child.status === "FAILED" || child.status === "WAITING" ? theme.warn : theme.muted}>
            {formatSubAgentFields(child.title, child)}
          </Text>
        ))}
        <Text color={theme.muted}>outcomes={props.snapshot.childOutcomes.length}</Text>
        {props.snapshot.childOutcomes.map((child) => (
          <Text key={child.threadId} color={theme.muted}>
            {formatSubAgentFields(child.title, child)}
          </Text>
        ))}
      </DetailDrawer>
    </Box>
  );
}

function formatSubAgentFields(
  label: string,
  child: OperatorDelegationChildEntry | OperatorDelegationOutcomeEntry,
): string {
  const wait = "waitEventType" in child ? child.waitEventType : undefined;
  const summary = "summary" in child ? child.summary : undefined;
  const reason = "reason" in child ? child.reason : undefined;
  const resultStatus = child.resultStatus ?? child.result?.status;
  const result = summary ?? child.result?.result;
  const errorCode = child.errorCode ?? child.result?.error?.code;
  const error = child.error ?? reason ?? child.result?.error?.message;
  const references = child.references ?? child.result?.references;
  return [
    label,
    `status=${child.status}`,
    wait !== undefined ? `wait=${wait}` : undefined,
    resultStatus !== undefined ? `resultStatus=${resultStatus}` : undefined,
    result !== undefined ? `result=${result}` : undefined,
    errorCode !== undefined ? `errorCode=${errorCode}` : undefined,
    error !== undefined ? `error=${error}` : undefined,
    references !== undefined && references.length > 0 ? `references=${references.join(",")}` : undefined,
  ].filter((value): value is string => value !== undefined).join(" ");
}
