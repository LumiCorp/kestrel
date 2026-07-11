import React from "react";
import { Box, Text } from "ink";

import type { AgentRunLogLine, UiLogFilters, ViewScrollState } from "../../contracts.js";
import { buildWindow } from "../store/UiStore.js";
import { theme } from "../theme/tokens.js";
import { formatTimestamp, stringifyJson, truncate } from "../ui/format.js";
import { filterRunLogs } from "./logSelectors.js";
import { DetailDrawer } from "../components/DetailDrawer.js";
import { ScreenHeader } from "../components/ScreenHeader.js";
import { StatusChip } from "../components/StatusChip.js";
import { formatActivityPresentation } from "./activityFormat.js";

interface LogsViewProps {
  logs: AgentRunLogLine[];
  filters: UiLogFilters;
  scroll: ViewScrollState;
  listRows: number;
  detailDrawerOpen: boolean;
}

export function LogsView(props: LogsViewProps): React.JSX.Element {
  const filtered = filterRunLogs(props.logs, props.filters);
  const windowed = buildWindow(filtered, props.scroll, props.listRows);
  const selected = filtered[windowed.scroll.cursor];
  const statusLabel =
    props.filters.level === "ALL"
      ? `${props.filters.paused ? "PAUSED" : "LIVE"} · ${filtered.length}`
      : `${props.filters.paused ? "PAUSED" : "LIVE"} · ${props.filters.level} · ${filtered.length}`;

  return (
    <Box flexDirection="column" flexGrow={1}>
      <ScreenHeader
        title="Activity Feed"
        right={
          <StatusChip label={statusLabel} tone={props.filters.paused ? "warn" : "success"} />
        }
      />

      <Box flexDirection="column" flexGrow={1}>
        {windowed.items.length === 0 ? (
          <Text color={theme.muted}>No logs match current filters.</Text>
        ) : (
          windowed.items.map((line, index) => {
            const absoluteIndex = windowed.start + index;
            const selectedRow = absoluteIndex === windowed.scroll.cursor;
            const levelColor = line.level === "ERROR" ? theme.error : line.level === "WARN" ? theme.warn : theme.success;
            const presentation = formatActivityPresentation(line);
            const summary = truncate(presentation.summary, 140);
            const context = presentation.context;

            return (
              <Box key={`${line.timestamp}-${absoluteIndex}`} flexDirection="column">
                <Box>
                  <Text color={theme.text}>{selectedRow ? ">" : " "}</Text>
                  <Text color={theme.text}> </Text>
                  <Text color={selectedRow ? theme.text : levelColor}>[{line.level}]</Text>
                  <Text color={theme.text}> </Text>
                  <Text color={theme.text}>{summary}</Text>
                </Box>
                {selectedRow ? (
                  <Box>
                    <Text color={theme.muted}>  {formatTimestamp(line.timestamp)} · {context}</Text>
                  </Box>
                ) : null}
              </Box>
            );
          })
        )}
      </Box>

      <DetailDrawer open={props.detailDrawerOpen} title="Log Metadata">
        {selected === undefined ? (
          <Text color={theme.muted}>Select an activity row to inspect metadata.</Text>
        ) : (
          <>
            <Text color={theme.text}>
              {formatTimestamp(selected.timestamp)} {selected.level} {selected.eventName}
            </Text>
            <Text color={theme.muted}>
              run={selected.runId ?? "n/a"} step={selected.stepIndex ?? "n/a"}
            </Text>
            {selected.metadata !== undefined ? (
              <Text color={theme.muted}>{stringifyJson(selected.metadata)}</Text>
            ) : (
              <Text color={theme.muted}>No metadata</Text>
            )}
          </>
        )}
      </DetailDrawer>
    </Box>
  );
}
