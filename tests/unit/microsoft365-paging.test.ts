import assert from "node:assert/strict";
import test from "node:test";

import {
  createMicrosoft365ChatMessagesCursor,
  createMicrosoft365TeamsCursor,
  readMicrosoft365ChatMessagesCursor,
  readMicrosoft365TeamsCursor,
} from "../../src/apps/microsoft365Paging.js";

const secret = "cursor-secret-for-microsoft-365-tests";
const context = {
  accountId: "account-1",
  projectId: "project-1",
  chatId: "chat-1",
  maxResults: 20,
};
const nextLink =
  "https://graph.microsoft.com/v1.0/chats/chat-1/messages?$skiptoken=provider-secret";

test("Microsoft 365 message cursors are opaque and bound to their request context", () => {
  const cursor = createMicrosoft365ChatMessagesCursor({
    secret,
    context,
    nextLink,
    now: 1000,
  });
  assert.doesNotMatch(cursor, /graph\.microsoft\.com|provider-secret/u);
  assert.deepEqual(
    readMicrosoft365ChatMessagesCursor({ secret, cursor, context, now: 1001 }),
    { nextLink },
  );
  assert.throws(
    () =>
      readMicrosoft365ChatMessagesCursor({
        secret,
        cursor,
        context: { ...context, projectId: "project-2" },
        now: 1001,
      }),
    /does not match/u,
  );
});

test("Microsoft 365 message cursors reject tampering and expiry", () => {
  const cursor = createMicrosoft365ChatMessagesCursor({
    secret,
    context,
    nextLink,
    now: 1000,
  });
  assert.throws(
    () =>
      readMicrosoft365ChatMessagesCursor({
        secret,
        cursor: `${cursor}x`,
        context,
        now: 1001,
      }),
    /invalid/u,
  );
  assert.throws(
    () =>
      readMicrosoft365ChatMessagesCursor({
        secret,
        cursor,
        context,
        now: 1000 + 15 * 60 * 1000,
      }),
    /does not match/u,
  );
});

test("Microsoft 365 chat-list cursors cannot be replayed as message cursors", () => {
  const cursor = createMicrosoft365TeamsCursor({
    secret,
    context: {
      accountId: "account-1",
      projectId: "project-1",
      operation: "chats.list",
      maxResults: 20,
    },
    nextLink: "https://graph.microsoft.com/v1.0/me/chats?$skiptoken=provider-secret",
    now: 1000,
  });
  assert.doesNotMatch(cursor, /graph\.microsoft\.com|provider-secret/u);
  assert.deepEqual(
    readMicrosoft365TeamsCursor({
      secret,
      cursor,
      context: {
        accountId: "account-1",
        projectId: "project-1",
        operation: "chats.list",
        maxResults: 20,
      },
      now: 1001,
    }),
    {
      nextLink: "https://graph.microsoft.com/v1.0/me/chats?$skiptoken=provider-secret",
    },
  );
  assert.throws(
    () =>
      readMicrosoft365ChatMessagesCursor({ secret, cursor, context, now: 1001 }),
    /does not match/u,
  );
});
