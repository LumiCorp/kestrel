import React from "react";
import { Box, Text } from "ink";

import type { ViewScrollState } from "../../contracts.js";
import type { OperatorHistoryHomeEntry, OperatorNextActionsSnapshot } from "../../../src/operatorShell.js";
import { buildWindow } from "../store/UiStore.js";
import { theme } from "../theme/tokens.js";
import { truncate } from "../ui/format.js";
import { DetailDrawer } from "../components/DetailDrawer.js";
import { ScreenHeader } from "../components/ScreenHeader.js";
import { StatusChip } from "../components/StatusChip.js";

interface HistoryHomeViewProps {
  entries: OperatorHistoryHomeEntry[];
  nextActions?: OperatorNextActionsSnapshot | undefined;
  query: string;
  scroll: ViewScrollState;
  listRows: number;
  detailDrawerOpen: boolean;
}

export function HistoryHomeView(props: HistoryHomeViewProps): React.JSX.Element {
  const filtered = filterEntries(props.entries, props.query);
  const windowed = buildWindow(filtered, props.scroll, props.listRows);
  const selected = filtered[windowed.scroll.cursor];

  return (
    <Box flexDirection="column" flexGrow={1}>
      <ScreenHeader
        title="History Home"
        right={<StatusChip label={`${filtered.length}/${props.entries.length}`} tone="muted" />}
      />
      {props.nextActions !== undefined && props.nextActions.orderedActions.length > 0 ? (
        <Box marginBottom={1} flexDirection="column">
          <Text color={theme.muted}>What can I do next? {props.nextActions.rationaleSummary}</Text>
          <Text color={theme.muted}>
            {props.nextActions.orderedActions.map((action) => action.label).join(" · ")}
          </Text>
        </Box>
      ) : null}

      <Box flexDirection="column" flexGrow={1}>
        {windowed.items.length === 0 ? (
          <Text color={theme.muted}>No history entries match query.</Text>
        ) : (
          windowed.items.map((entry, index) => {
            const absoluteIndex = windowed.start + index;
            const selectedRow = absoluteIndex === windowed.scroll.cursor;
            const flags = [
              entry.hasSummary ? "summary" : undefined,
              entry.hasArtifacts ? "artifacts" : undefined,
              entry.restartAvailable ? "restart" : undefined,
            ].filter((value): value is string => value !== undefined);
            return (
              <Text key={entry.id} color={theme.text}>
                {selectedRow ? ">" : " "} {entry.isActive ? "*" : " "} {truncate(entry.title, 34)} [{entry.lifecycle}]
                {` ${truncate(entry.modeLabel, 14)}`}
                {entry.profileLabel !== undefined ? ` ${truncate(entry.profileLabel, 18)}` : ""}
                {flags.length > 0 ? ` ${flags.join("/")}` : ""}
              </Text>
            );
          })
        )}
      </Box>

      <DetailDrawer open={props.detailDrawerOpen} title="History Details">
        {selected === undefined ? (
          <Text color={theme.muted}>Select a history entry to inspect details.</Text>
        ) : (
          <>
            <Text color={theme.text}>{selected.title}</Text>
            <Text color={theme.muted}>id={selected.id}</Text>
            <Text color={theme.muted}>action={selected.recommendedLabel}</Text>
            <Text color={theme.muted}>detail={selected.detail}</Text>
            <Text color={theme.muted}>mode={selected.modeLabel}</Text>
            <Text color={theme.muted}>profile={selected.profileLabel ?? "not recorded"}</Text>
            <Text color={theme.muted}>workspace={selected.workspaceLabel ?? "not recorded"}</Text>
            <Text color={theme.muted}>updated={selected.updatedAt}</Text>
            <Text color={theme.muted}>launch={selected.launchSummary ?? "not recorded"}</Text>
            <Text color={theme.muted}>preview={selected.latestPreview ?? "not recorded"}</Text>
            <Text color={theme.muted}>summary={selected.hasSummary ? "available" : "not recorded"}</Text>
            <Text color={theme.muted}>artifacts={selected.hasArtifacts ? "available" : "not recorded"}</Text>
            <Text color={theme.muted}>restart={selected.restartAvailable ? "available" : "not recorded"}</Text>
          </>
        )}
      </DetailDrawer>
    </Box>
  );
}

function filterEntries(entries: OperatorHistoryHomeEntry[], query: string): OperatorHistoryHomeEntry[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return entries;
  }

  return entries.filter((entry) => {
    const searchable = [
      entry.title,
      entry.profileLabel,
      entry.workspaceLabel,
      entry.launchSummary,
      entry.latestPreview,
      entry.recommendedLabel,
    ]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" ")
      .toLowerCase();
    return searchable.includes(normalized);
  });
}
