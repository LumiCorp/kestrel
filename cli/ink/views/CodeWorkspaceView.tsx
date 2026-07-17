import type React from "react";
import { Box, Text } from "ink";

import type { ViewScrollState } from "../../contracts.js";
import type { OperatorCodeWorkspaceSnapshot } from "../../../src/operatorShell.js";
import { buildWindow } from "../store/UiStore.js";
import { theme } from "../theme/tokens.js";
import { DetailDrawer } from "../components/DetailDrawer.js";
import { ScreenHeader } from "../components/ScreenHeader.js";
import { StatusChip } from "../components/StatusChip.js";

interface CodeWorkspaceViewProps {
  snapshot: OperatorCodeWorkspaceSnapshot;
  scroll: ViewScrollState;
  listRows: number;
  detailDrawerOpen: boolean;
}

export function CodeWorkspaceView(props: CodeWorkspaceViewProps): React.JSX.Element {
  const actions = props.snapshot.primaryActions.concat(props.snapshot.secondaryActions);
  const windowed = buildWindow(actions, props.scroll, props.listRows);
  const selected = actions[windowed.scroll.cursor];

  return (
    <Box flexDirection="column" flexGrow={1}>
      <ScreenHeader
        title="Code Workspace"
        right={<StatusChip label={props.snapshot.enabled ? "enabled" : "disabled"} tone={props.snapshot.enabled ? "success" : "warn"} />}
      />
      <Text color={theme.text}>{props.snapshot.headline}</Text>
      <Text color={theme.muted}>{props.snapshot.subline}</Text>
      <Text color={theme.muted}>{props.snapshot.statusChips.join(" · ")}</Text>
      {props.snapshot.nextActions !== undefined && props.snapshot.nextActions.orderedActions.length > 0 ? (
        <Text color={theme.muted}>
          What can I do next? {props.snapshot.nextActions.orderedActions.map((action) => action.label).join(" · ")}
        </Text>
      ) : null}
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
      <DetailDrawer open={props.detailDrawerOpen} title="Code Details">
        <Text color={theme.text}>{props.snapshot.sessionTitle}</Text>
        <Text color={theme.muted}>recommended={props.snapshot.recommendedLabel}</Text>
        <Text color={theme.muted}>profile={props.snapshot.profileLabel}</Text>
        <Text color={theme.muted}>workspace={props.snapshot.workspaceLabel ?? "not recorded"}</Text>
        <Text color={theme.muted}>selected={selected?.label ?? "none"}</Text>
        <Text color={theme.muted}>approval={props.snapshot.approvalMode}</Text>
        <Text color={theme.muted}>sandbox={props.snapshot.sandboxSummary}</Text>
        <Text color={theme.muted}>retention={props.snapshot.retentionSummary}</Text>
        <Text color={theme.muted}>languages={props.snapshot.languages.join(",") || "none"}</Text>
        <Text color={theme.muted}>latest={props.snapshot.latestHint ?? "not recorded"}</Text>
      </DetailDrawer>
    </Box>
  );
}
