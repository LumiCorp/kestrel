import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeMicrosoft365TeamsChats,
  normalizeMicrosoft365TeamsMessages,
} from "../../src/apps/microsoft365Teams.js";

test("Teams results normalize stable chat, participant, and message fields", () => {
  assert.deepEqual(
    normalizeMicrosoft365TeamsChats([
      {
        id: "chat-1",
        topic: "Planning",
        chatType: "group",
        createdDateTime: "2026-08-27T12:00:00Z",
        lastUpdatedDateTime: "2026-08-27T12:01:00Z",
        webUrl: "https://teams.microsoft.com/l/chat/1",
        members: [{ id: "member-1", displayName: "Alex", email: "alex@example.com" }],
      },
    ]),
    [{
      id: "chat-1",
      topic: "Planning",
      chatType: "group",
      createdAt: "2026-08-27T12:00:00Z",
      lastUpdatedAt: "2026-08-27T12:01:00Z",
      webUrl: "https://teams.microsoft.com/l/chat/1",
      participants: [{ id: "member-1", displayName: "Alex", email: "alex@example.com" }],
    }],
  );
  assert.deepEqual(
    normalizeMicrosoft365TeamsMessages({
      chatId: "chat-1",
      items: [{
        id: "message-1",
        createdDateTime: "2026-08-27T12:02:00Z",
        from: { user: { id: "member-1", displayName: "Alex", userPrincipalName: "alex@example.com" } },
        body: { contentType: "html", content: "<p>Hello</p>" },
      }],
    }),
    [{
      id: "message-1",
      chatId: "chat-1",
      createdAt: "2026-08-27T12:02:00Z",
      lastModifiedAt: null,
      sender: { id: "member-1", displayName: "Alex", email: "alex@example.com" },
      body: { format: "html", content: "<p>Hello</p>" },
    }],
  );
});

test("Teams normalization rejects items without provider-stable identifiers", () => {
  assert.throws(
    () => normalizeMicrosoft365TeamsChats([{}]),
    /Teams chat id is missing/u,
  );
  assert.throws(
    () => normalizeMicrosoft365TeamsMessages({ chatId: "chat-1", items: [{}] }),
    /Teams message id is missing/u,
  );
});
