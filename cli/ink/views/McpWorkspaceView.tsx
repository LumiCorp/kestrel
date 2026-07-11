import React from "react";
import { Box, Text } from "ink";

import type { ViewScrollState } from "../../contracts.js";
import type { OperatorMcpWorkspaceSnapshot } from "../../../src/operatorShell.js";
import { buildWindow } from "../store/UiStore.js";
import { theme } from "../theme/tokens.js";
import { DetailDrawer } from "../components/DetailDrawer.js";
import { ScreenHeader } from "../components/ScreenHeader.js";
import { StatusChip } from "../components/StatusChip.js";

interface McpWorkspaceViewProps {
  snapshot: OperatorMcpWorkspaceSnapshot;
  scroll: ViewScrollState;
  listRows: number;
  detailDrawerOpen: boolean;
}

export function McpWorkspaceView(props: McpWorkspaceViewProps): React.JSX.Element {
  const actions = props.snapshot.primaryActions.concat(props.snapshot.secondaryActions);
  const windowed = buildWindow(actions, props.scroll, props.listRows);
  const selected = actions[windowed.scroll.cursor];

  return (
    <Box flexDirection="column" flexGrow={1}>
      <ScreenHeader
        title="MCP Workspace"
        right={<StatusChip label={props.snapshot.healthLabel} tone={props.snapshot.issueFlags.length > 0 ? "warn" : "muted"} />}
      />
      <Text color={theme.text}>{props.snapshot.headline}</Text>
      <Text color={theme.muted}>{props.snapshot.subline}</Text>
      <Text color={theme.muted}>
        {props.snapshot.statusChips.join(" · ")}
      </Text>
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
      <DetailDrawer open={props.detailDrawerOpen} title="MCP Details">
        <Text color={theme.text}>{props.snapshot.sessionTitle}</Text>
        <Text color={theme.muted}>recommended={props.snapshot.recommendedLabel}</Text>
        <Text color={theme.muted}>profile={props.snapshot.profileLabel}</Text>
        <Text color={theme.muted}>workspace={props.snapshot.workspaceLabel ?? "not recorded"}</Text>
        <Text color={theme.muted}>selected={selected?.label ?? "none"}</Text>
        <Text color={theme.muted}>servers={props.snapshot.servers.length}</Text>
        {props.snapshot.servers.map((server) => (
          <Text key={server.id} color={server.healthy ? theme.muted : theme.warn}>
            {server.id} transport={server.transport} enabled={server.enabled ? "true" : "false"} healthy={server.healthy ? "true" : "false"} tools={server.toolCount}
            {server.error !== undefined ? ` error=${server.error}` : ""}
          </Text>
        ))}
        <Text color={theme.muted}>tools={props.snapshot.tools.length}</Text>
      </DetailDrawer>
    </Box>
  );
}
