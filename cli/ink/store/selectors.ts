import type { AgentRunLogLine, TuiSessionMeta, UiLogFilters } from "../../contracts.js";
import type { PaletteAction } from "../overlays/CommandPalette.js";
import { filterRunLogs } from "../views/logSelectors.js";
import { filterSessions } from "../views/sessionSelectors.js";

export interface UiDerivedCollections {
  filteredLogs: AgentRunLogLine[];
  filteredSessions: TuiSessionMeta[];
  filteredPaletteActions: PaletteAction[];
}

export function createUiDerivedSelectors(): {
  filterLogs: (lines: AgentRunLogLine[], filters: UiLogFilters) => AgentRunLogLine[];
  filterSessions: (sessions: TuiSessionMeta[], query: string) => TuiSessionMeta[];
  filterPaletteActions: (actions: PaletteAction[], query: string, maxItems: number) => PaletteAction[];
  build: (input: {
    logs: AgentRunLogLine[];
    logFilters: UiLogFilters;
    sessions: TuiSessionMeta[];
    sessionQuery: string;
    actions: PaletteAction[];
    paletteQuery: string;
    paletteMaxItems: number;
  }) => UiDerivedCollections;
} {
  let lastLogsRef: AgentRunLogLine[] | undefined;
  let lastLogFiltersKey = "";
  let lastLogsResult: AgentRunLogLine[] = [];

  let lastSessionsRef: TuiSessionMeta[] | undefined;
  let lastSessionQuery = "";
  let lastSessionsResult: TuiSessionMeta[] = [];

  let lastPaletteRef: PaletteAction[] | undefined;
  let lastPaletteQuery = "";
  let lastPaletteMax = 0;
  let lastPaletteResult: PaletteAction[] = [];

  const filterLogsMemo = (lines: AgentRunLogLine[], filters: UiLogFilters): AgentRunLogLine[] => {
    const key = `${filters.level}|${filters.eventQuery}|${filters.runIdQuery}`;
    if (lastLogsRef === lines && lastLogFiltersKey === key) {
      return lastLogsResult;
    }
    lastLogsRef = lines;
    lastLogFiltersKey = key;
    lastLogsResult = filterRunLogs(lines, filters);
    return lastLogsResult;
  };

  const filterSessionsMemo = (sessions: TuiSessionMeta[], query: string): TuiSessionMeta[] => {
    if (lastSessionsRef === sessions && lastSessionQuery === query) {
      return lastSessionsResult;
    }
    lastSessionsRef = sessions;
    lastSessionQuery = query;
    lastSessionsResult = filterSessions(sessions, query);
    return lastSessionsResult;
  };

  const filterPaletteActionsMemo = (
    actions: PaletteAction[],
    query: string,
    maxItems: number,
  ): PaletteAction[] => {
    if (lastPaletteRef === actions && lastPaletteQuery === query && lastPaletteMax === maxItems) {
      return lastPaletteResult;
    }

    const needle = query.trim().toLowerCase();
    const filtered =
      needle.length === 0
        ? actions
        : actions.filter(
            (action) => {
              const haystack =
                action.searchText ??
                [action.label, action.detail, action.command, action.draft]
                  .filter((value): value is string => value !== undefined)
                  .join(" ");
              return haystack.toLowerCase().includes(needle);
            },
          );

    lastPaletteRef = actions;
    lastPaletteQuery = query;
    lastPaletteMax = maxItems;
    lastPaletteResult = filtered.slice(0, Math.max(1, maxItems));
    return lastPaletteResult;
  };

  return {
    filterLogs: filterLogsMemo,
    filterSessions: filterSessionsMemo,
    filterPaletteActions: filterPaletteActionsMemo,
    build: (input) => ({
      filteredLogs: filterLogsMemo(input.logs, input.logFilters),
      filteredSessions: filterSessionsMemo(input.sessions, input.sessionQuery),
      filteredPaletteActions: filterPaletteActionsMemo(
        input.actions,
        input.paletteQuery,
        input.paletteMaxItems,
      ),
    }),
  };
}
