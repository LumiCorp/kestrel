import type React from "react";
import { Box, Text } from "ink";

import type { ViewScrollState } from "../../contracts.js";
import type { OperatorWorkspaceJourneySnapshot } from "../../../src/operatorShell.js";
import { buildWindow } from "../store/UiStore.js";
import { theme } from "../theme/tokens.js";
import { DetailDrawer } from "../components/DetailDrawer.js";
import { ScreenHeader } from "../components/ScreenHeader.js";
import { StatusChip } from "../components/StatusChip.js";

interface WorkspaceViewProps {
  snapshot: OperatorWorkspaceJourneySnapshot;
  scroll: ViewScrollState;
  listRows: number;
  detailDrawerOpen: boolean;
}

export function WorkspaceView(props: WorkspaceViewProps): React.JSX.Element {
  const actions = props.snapshot.primaryActions.concat(props.snapshot.secondaryActions);
  const windowed = buildWindow(actions, props.scroll, props.listRows);
  const selected = actions[windowed.scroll.cursor];

  return (
    <Box flexDirection="column" flexGrow={1}>
      <ScreenHeader
        title="Workspace"
        right={<StatusChip label={`${props.snapshot.discoveredWorkspaces.length} discovered`} tone={props.snapshot.issueFlags.length > 0 ? "warn" : "muted"} />}
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
      <DetailDrawer open={props.detailDrawerOpen} title="Workspace Details">
        <Text color={theme.text}>{props.snapshot.sessionTitle}</Text>
        <Text color={theme.muted}>recommended={props.snapshot.recommendedLabel}</Text>
        <Text color={theme.muted}>profile={props.snapshot.profileLabel}</Text>
        <Text color={theme.muted}>session-workspace={props.snapshot.currentWorkspaceLabel}</Text>
        <Text color={theme.muted}>launch-workspace={props.snapshot.launchWorkspaceLabel}</Text>
        <Text color={theme.muted}>selected={selected?.label ?? "none"}</Text>
        <Text color={theme.muted}>mismatch={props.snapshot.mismatchSummary ?? "none"}</Text>
        <Text color={theme.muted}>recent={props.snapshot.recentLaunches.length}</Text>
        {props.snapshot.discoveredWorkspaces.map((workspace) => (
          <Text key={workspace.workspaceId ?? workspace.rootPath ?? workspace.label} color={workspace.isCurrentBinding || workspace.isLaunchWorkspace ? theme.text : theme.muted}>
            {workspace.label}
            {workspace.workspaceId !== undefined ? ` id=${workspace.workspaceId}` : ""}
            {workspace.rootPath !== undefined ? ` root=${workspace.rootPath}` : ""}
            {workspace.isCurrentBinding ? " current=yes" : ""}
            {workspace.isLaunchWorkspace ? " launch=yes" : ""}
          </Text>
        ))}
        {props.snapshot.recentLaunches.map((launch) => (
          <Text key={launch.id} color={theme.muted}>
            {launch.title} {launch.modeLabel} {launch.workspaceLabel}
          </Text>
        ))}
      </DetailDrawer>
    </Box>
  );
}
