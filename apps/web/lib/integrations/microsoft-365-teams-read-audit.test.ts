import test from "node:test";
import assert from "node:assert/strict";

import { microsoft365TeamsReadAuditMetadata } from "./microsoft-365-teams-read-audit";

test("Teams chat-read audit metadata retains identifiers and paging state, not chat content", () => {
  const metadata = microsoft365TeamsReadAuditMetadata({
    input: { operation: "chat.messages.list", chatId: "chat-1", cursor: "sealed-token" },
    result: {
      items: [
        { id: "message-1", body: { content: "do not retain this Teams message" } },
      ],
      nextCursor: "another-sealed-token",
    },
  });

  assert.deepEqual(metadata, {
    cursorState: "continued",
    pageState: "more",
    resultCount: 1,
    providerChatId: "chat-1",
    providerMessageIds: ["message-1"],
  });
  assert.doesNotMatch(JSON.stringify(metadata), /do not retain|sealed-token/iu);
});

test("Teams chat-list audit metadata records failed pages without a cursor token", () => {
  assert.deepEqual(
    microsoft365TeamsReadAuditMetadata({
      input: { operation: "chats.list" },
    }),
    {
      cursorState: "initial",
      pageState: "unavailable",
      resultCount: 0,
      providerChatIds: [],
    },
  );
});
