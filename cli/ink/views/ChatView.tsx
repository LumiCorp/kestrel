import type React from "react";
import { Box, Text } from "ink";

import type {
  AgentRunLogLine,
  ProgressUpdateV1,
  TranscriptLine,
  TuiSessionMeta,
} from "../../contracts.js";
import { theme } from "../theme/tokens.js";
import { formatRole, formatTimestamp, truncate } from "../ui/format.js";
import { BubbleMessage } from "../components/BubbleMessage.js";
import { ThemedTextInput } from "../components/ThemedTextInput.js";
import { extractWaitPrompt } from "../../app/waitForPrompt.js";
import { buildChatVisualRows, buildChatWindow, type ChatVisualRow } from "./chatRows.js";
import { resolveChatComposerInputRows, resolveChatLayoutBudget } from "./chatLayout.js";
import type { ViewScrollState } from "../../contracts.js";

interface ChatViewProps {
  session: TuiSessionMeta;
  transcript: TranscriptLine[];
  runLogs: AgentRunLogLine[];
  scroll: ViewScrollState;
  statusLine: string;
  draft: string;
  running: boolean;
  composerFocused: boolean;
  progress?: ProgressUpdateV1 | undefined;
  viewportColumns: number;
  viewportRows: number;
  unreadCount: number;
  highlightRunId?: string | undefined;
  onDraftChange: (value: string) => void;
  onSubmit: (line: string) => void;
}

interface MessageCard {
  transcriptIndex: number;
  role: TranscriptLine["role"];
  lines: string[];
  reasoning: boolean;
  meta: string;
  selected: boolean;
  highlightedRun: boolean;
  attention: boolean;
}

export function ChatView(props: ChatViewProps): React.JSX.Element {
  const pendingWait = props.session.pendingWaitFor;
  const waitPrompt = extractWaitPrompt(pendingWait);
  const waitingForInput = pendingWait?.kind === "user";
  const provisionalLayout = resolveChatLayoutBudget({
    viewportColumns: props.viewportColumns,
    viewportRows: props.viewportRows,
    detailDrawerOpen: false,
  });
  const composerInputWidth = Math.max(1, provisionalLayout.conversationWidth - 2);
  const composerInputRows = resolveChatComposerInputRows({
    draft: props.draft,
    inputWidth: composerInputWidth,
    viewportRows: props.viewportRows,
    detailDrawerOpen: false,
  });
  const { conversationWidth, bubbleWidth, wrappedBodyWidth, transcriptRows } = resolveChatLayoutBudget({
    viewportColumns: props.viewportColumns,
    viewportRows: props.viewportRows,
    detailDrawerOpen: false,
    composerRows: composerInputRows + 1,
  });
  const visualRows = buildChatVisualRows(props.transcript, wrappedBodyWidth);
  const windowed = buildChatWindow(visualRows, props.scroll, transcriptRows);
  const selectedVisualRow = visualRows[windowed.scroll.cursor];
  const selectedTranscriptIndex = selectedVisualRow?.transcriptIndex;
  const cards = buildMessageCards({
    rows: windowed.items,
    selectedTranscriptIndex,
    highlightRunId: props.highlightRunId,
  });
  const selectionSummary = buildSelectionSummary({
    visualRows,
    windowed,
    selectedTranscriptIndex,
    transcriptCount: props.transcript.length,
    unreadCount: props.unreadCount,
    highlightRunId: props.highlightRunId,
  });
  const composerStatus = buildComposerStatus({
    running: props.running,
    waitingForInput,
    waitPrompt,
    unreadCount: props.unreadCount,
    tailLocked: props.scroll.tailLocked,
    maxWidth: conversationWidth,
  });
  const clippedSelectionSummary = selectionSummary === undefined
    ? undefined
    : truncate(selectionSummary, conversationWidth);
  const composerStatusColor = waitingForInput ? theme.warn : theme.muted;

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="column" height={transcriptRows} overflow="hidden" paddingX={1}>
        {cards.length === 0 ? (
          <Text color={theme.muted}>No transcript lines yet.</Text>
        ) : (
          cards.map((card) => (
            <BubbleMessage
              key={`${card.transcriptIndex}-${card.meta}`}
              role={card.role}
              lines={card.lines}
              reasoning={card.reasoning}
              meta={card.meta}
              selected={card.selected}
              highlightedRun={card.highlightedRun}
              attention={card.attention}
              width={bubbleWidth}
            />
          ))
        )}
      </Box>

      <Box height={1} overflow="hidden" paddingX={1}>
        <Text color={theme.muted}>{clippedSelectionSummary ?? " "}</Text>
      </Box>

      <Box
        height={composerInputRows + 1}
        marginTop={0}
        flexDirection="column"
        overflow="hidden"
        paddingX={1}
      >
        <Box height={1} overflow="hidden">
          <Text color={composerStatusColor}>{composerStatus ?? " "}</Text>
        </Box>
        <Box height={composerInputRows} overflow="hidden" width={conversationWidth}>
          <Box width={2}>
            <Text color={theme.brand}>&gt;</Text>
            <Text color={theme.text}> </Text>
          </Box>
          <Box height={composerInputRows} overflow="hidden" width={composerInputWidth}>
            <ThemedTextInput
              value={props.draft}
              onChange={props.onDraftChange}
              onSubmit={props.onSubmit}
              focus={props.composerFocused}
              width={composerInputWidth}
              maxRows={composerInputRows}
            />
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

function buildMessageCards(input: {
  rows: ChatVisualRow[];
  selectedTranscriptIndex: number | undefined;
  highlightRunId: string | undefined;
}): MessageCard[] {
  const cards: MessageCard[] = [];

  for (const row of input.rows) {
    const previous = cards[cards.length - 1];
    const highlightedRun = input.highlightRunId !== undefined && row.run?.runId === input.highlightRunId;
    if (previous !== undefined && previous.transcriptIndex === row.transcriptIndex) {
      previous.lines.push(row.text);
      previous.selected = previous.selected || row.transcriptIndex === input.selectedTranscriptIndex;
      previous.highlightedRun = previous.highlightedRun || highlightedRun;
      previous.reasoning = previous.reasoning || row.reasoning;
      previous.attention = previous.attention || row.attention;
      continue;
    }

    cards.push({
      transcriptIndex: row.transcriptIndex,
      role: row.role,
      lines: [row.text],
      reasoning: row.reasoning,
      meta: formatTimestamp(row.timestamp),
      selected: row.transcriptIndex === input.selectedTranscriptIndex,
      highlightedRun,
      attention: row.attention,
    });
  }

  return cards;
}

export function resolveChatLayout(viewportColumns: number): {
  conversationWidth: number;
  bubbleWidth: number;
} {
  const layout = resolveChatLayoutBudget({
    viewportColumns,
    viewportRows: 40,
    detailDrawerOpen: false,
  });
  return { conversationWidth: layout.conversationWidth, bubbleWidth: layout.bubbleWidth };
}

function buildSelectionSummary(input: {
  visualRows: ChatVisualRow[];
  windowed: ReturnType<typeof buildChatWindow>;
  selectedTranscriptIndex: number | undefined;
  transcriptCount: number;
  unreadCount: number;
  highlightRunId?: string | undefined;
}): string | undefined {
  if (input.windowed.scroll.tailLocked && input.unreadCount === 0 && input.highlightRunId === undefined) {
    return ;
  }

  const cursorRow = input.visualRows[input.windowed.scroll.cursor];
  const rowPosition = input.visualRows.length === 0 ? "0/0 rows" : `${input.windowed.scroll.cursor + 1}/${input.visualRows.length} rows`;
  const messagePosition =
    input.selectedTranscriptIndex === undefined
      ? "0/0 msgs"
      : `${input.selectedTranscriptIndex + 1}/${input.transcriptCount} msgs`;
  const tailState = input.windowed.scroll.tailLocked ? "live tail" : "history";
  const unreadState = input.unreadCount > 0 ? `${input.unreadCount} unread` : "caught up";
  const runState = input.highlightRunId !== undefined ? `run ${truncate(input.highlightRunId, 12)}` : undefined;
  const roleState = cursorRow !== undefined ? formatRole(cursorRow.role) : undefined;

  return [messagePosition, rowPosition, tailState, unreadState, roleState, runState]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(" · ");
}

function buildComposerStatus(input: {
  running: boolean;
  waitingForInput: boolean;
  waitPrompt: string | undefined;
  unreadCount: number;
  tailLocked: boolean;
  maxWidth: number;
}): string | undefined {
  if (input.waitingForInput) {
    return truncate(`Waiting · ${input.waitPrompt ?? "Enter input to resume."}`, input.maxWidth);
  }
  if (input.running) {
    return "Run in progress";
  }
  if (input.waitPrompt !== undefined) {
    return truncate(`Waiting · ${input.waitPrompt}`, input.maxWidth);
  }
  if (input.tailLocked === false && input.unreadCount > 0) {
    return `Browsing history · ${input.unreadCount} unread`;
  }
  if (input.tailLocked === false) {
    return "Browsing history";
  }
  return ;
}
