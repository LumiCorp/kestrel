import React from "react";
import { Box, Text } from "ink";

import type { ViewScrollState } from "../../contracts.js";
import type { OperatorRecoveryCenterSnapshot } from "../../../src/operatorShell.js";
import { buildWindow } from "../store/UiStore.js";
import { theme } from "../theme/tokens.js";
import { DetailDrawer } from "../components/DetailDrawer.js";
import { ScreenHeader } from "../components/ScreenHeader.js";
import { StatusChip } from "../components/StatusChip.js";

interface RecoveryCenterViewProps {
  snapshot: OperatorRecoveryCenterSnapshot;
  scroll: ViewScrollState;
  listRows: number;
  detailDrawerOpen: boolean;
}

export function RecoveryCenterView(props: RecoveryCenterViewProps): React.JSX.Element {
  const actions = props.snapshot.primaryActions.concat(props.snapshot.secondaryActions);
  const windowed = buildWindow(actions, props.scroll, props.listRows);
  const selected = actions[windowed.scroll.cursor];

  return (
    <Box flexDirection="column" flexGrow={1}>
      <ScreenHeader
        title="Recovery Center"
        right={<StatusChip label={`${props.snapshot.timeline.length} anchors`} tone={props.snapshot.issueFlags.length > 0 ? "warn" : "muted"} />}
      />
      <Text color={theme.text}>{props.snapshot.headline}</Text>
      <Text color={theme.muted}>{props.snapshot.subline}</Text>
      <Text color={theme.muted}>{props.snapshot.statusChips.join(" · ")}</Text>
      {props.snapshot.nextActions !== undefined && props.snapshot.nextActions.orderedActions.length > 0 ? (
        <Text color={theme.muted}>
          What can I do next? {props.snapshot.nextActions.orderedActions.map((action) => action.label).join(" · ")}
        </Text>
      ) : null}
      <Text color={theme.muted}>incident={props.snapshot.incident.summary}</Text>
      <Text color={theme.muted}>cause={props.snapshot.incident.cause}</Text>
      <Text color={theme.muted}>next-valid={props.snapshot.incident.nextValidAction}</Text>
      {props.snapshot.issueFlags.length > 0 ? (
        <Text color={theme.warn}>issues={props.snapshot.issueFlags.join(" | ")}</Text>
      ) : null}
      {props.snapshot.restorePreview !== undefined ? (
        <Text color={theme.muted}>
          restore-preview={props.snapshot.restorePreview.label} consequence={props.snapshot.restorePreview.consequence}
        </Text>
      ) : (
        <Text color={theme.muted}>restore-preview=none (runtime recovery still available)</Text>
      )}
      <Text color={theme.muted}>timeline:</Text>
      {props.snapshot.timeline.slice(0, 3).map((entry) => (
        <Text key={`timeline-row:${entry.id}`} color={theme.muted}>
          - {entry.label} [{entry.origin}/{entry.disposition}] consequence={entry.actionConsequence}
        </Text>
      ))}
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
      <DetailDrawer open={props.detailDrawerOpen} title="Recovery Details">
        <Text color={theme.text}>{props.snapshot.sessionTitle}</Text>
        <Text color={theme.muted}>recommended={props.snapshot.recommendedLabel}</Text>
        <Text color={theme.muted}>profile={props.snapshot.profileLabel}</Text>
        <Text color={theme.muted}>workspace={props.snapshot.workspaceLabel ?? "not recorded"}</Text>
        <Text color={theme.muted}>root={props.snapshot.workspaceRoot ?? "not recorded"}</Text>
        <Text color={theme.muted}>selected={selected?.label ?? "none"}</Text>
        <Text color={theme.muted}>evidence={props.snapshot.latestEvidence ?? "not recorded"}</Text>
        <Text color={theme.muted}>incident={props.snapshot.incident.summary}</Text>
        <Text color={theme.muted}>cause={props.snapshot.incident.cause}</Text>
        <Text color={theme.muted}>next={props.snapshot.incident.recommendedAction}</Text>
        <Text color={theme.muted}>next-valid={props.snapshot.incident.nextValidAction}</Text>
        <Text color={theme.muted}>post-run={props.snapshot.postRunSummary.outcome}</Text>
        <Text color={theme.muted}>approvals={props.snapshot.postRunSummary.approvalsUsed.join(", ") || "none"}</Text>
        {props.snapshot.restorePreview !== undefined ? (
          <>
            <Text color={theme.muted}>restore={props.snapshot.restorePreview.label}</Text>
            <Text color={theme.muted}>restore-root={props.snapshot.restorePreview.workspaceRoot ?? "not recorded"}</Text>
            <Text color={theme.muted}>{props.snapshot.restorePreview.consequence}</Text>
          </>
        ) : null}
        {props.snapshot.timeline.map((entry) => (
          <Text key={`${entry.kind}:${entry.id}`} color={entry.kind === "workspace_checkpoint" ? theme.muted : theme.text}>
            {entry.kind} {entry.origin} {entry.disposition} {entry.label} {entry.detail}
            {` consequence=${entry.actionConsequence}`}
            {entry.actionHint !== undefined ? ` action=${entry.actionHint}` : ""}
          </Text>
        ))}
        {props.snapshot.notebook.map((entry) => (
          <Text key={entry.id} color={theme.muted}>
            {entry.kind} {entry.label} {entry.detail}
          </Text>
        ))}
      </DetailDrawer>
    </Box>
  );
}
