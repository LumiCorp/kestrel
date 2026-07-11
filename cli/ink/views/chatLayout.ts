import { buildEditableTextInputRows } from "../components/textInputLayout.js";

export interface ChatLayoutBudget {
  conversationWidth: number;
  bubbleWidth: number;
  wrappedBodyWidth: number;
  transcriptRows: number;
}

const CHAT_MIN_CONVERSATION_WIDTH = 42;
const CHAT_MIN_BODY_WIDTH = 24;
const CHAT_VIEW_HORIZONTAL_PADDING = 2;
const CHAT_WRAP_PADDING = 10;
const CHAT_BODY_PREFIX_WIDTH = 3;
const CHAT_ACTIVE_VIEW_CHROME_ROWS = 2;
const CHAT_SELECTION_SUMMARY_ROWS = 1;
const CHAT_COMPOSER_ROWS = 2;
const CHAT_DETAIL_DRAWER_ROWS = 4;
const CHAT_MIN_ACTIVE_VIEW_ROWS = 6;
const CHAT_MIN_TRANSCRIPT_ROWS = 1;

export function resolveChatLayoutBudget(input: {
  viewportColumns: number;
  viewportRows: number;
  detailDrawerOpen: boolean;
  composerRows?: number | undefined;
}): ChatLayoutBudget {
  const conversationWidth = Math.max(
    CHAT_MIN_CONVERSATION_WIDTH,
    Math.trunc(input.viewportColumns) - CHAT_VIEW_HORIZONTAL_PADDING,
  );
  const wrappedBodyWidth = deriveChatWrappedBodyWidth(conversationWidth);
  const activeViewRows = Math.max(CHAT_MIN_ACTIVE_VIEW_ROWS, Math.trunc(input.viewportRows) - CHAT_ACTIVE_VIEW_CHROME_ROWS);
  const fixedRows =
    CHAT_SELECTION_SUMMARY_ROWS +
    Math.max(1, Math.trunc(input.composerRows ?? CHAT_COMPOSER_ROWS)) +
    (input.detailDrawerOpen ? CHAT_DETAIL_DRAWER_ROWS : 0);

  return {
    conversationWidth,
    bubbleWidth: conversationWidth,
    wrappedBodyWidth,
    transcriptRows: Math.max(1, activeViewRows - fixedRows),
  };
}

export function deriveChatWrappedBodyWidth(conversationWidth: number): number {
  return Math.max(
    CHAT_MIN_BODY_WIDTH,
    Math.trunc(conversationWidth) - CHAT_WRAP_PADDING - CHAT_BODY_PREFIX_WIDTH,
  );
}

export function resolveChatComposerInputRows(input: {
  draft: string;
  inputWidth: number;
  viewportRows: number;
  detailDrawerOpen: boolean;
}): number {
  const desiredRows = buildEditableTextInputRows({
    text: input.draft,
    width: input.inputWidth,
  }).length;
  const activeViewRows = Math.max(
    CHAT_MIN_ACTIVE_VIEW_ROWS,
    Math.trunc(input.viewportRows) - CHAT_ACTIVE_VIEW_CHROME_ROWS,
  );
  const reservedRows =
    CHAT_SELECTION_SUMMARY_ROWS +
    (input.detailDrawerOpen ? CHAT_DETAIL_DRAWER_ROWS : 0) +
    CHAT_MIN_TRANSCRIPT_ROWS;
  const availableComposerRows = Math.max(1, activeViewRows - reservedRows);

  return Math.min(desiredRows, availableComposerRows);
}
