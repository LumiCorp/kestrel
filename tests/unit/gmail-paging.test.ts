import assert from "node:assert/strict";
import test from "node:test";
import { createGmailPageCursor, readGmailPageCursor } from "../../src/apps/gmailPaging.js";

const secret = "gmail-cursor-secret-that-is-long-enough-for-tests";
const context = {
  accountId: "account-1",
  projectId: "project-1",
  threadId: "thread-1",
  operation: "gmail.messages.search" as const,
  query: "from:billing@example.com newer_than:30d",
  maxResults: 25,
};

test("Gmail cursors hide provider page tokens and bind their complete read context", () => {
  const cursor = createGmailPageCursor({ secret, context, pageToken: "google-page-token", now: 1_000 });
  assert.doesNotMatch(cursor, /google-page-token/u);
  assert.deepEqual(readGmailPageCursor({ secret, cursor, context, now: 1_001 }), { pageToken: "google-page-token" });
  for (const changed of [
    { ...context, accountId: "account-2" },
    { ...context, projectId: "project-2" },
    { ...context, threadId: "thread-2" },
    { ...context, query: "is:unread" },
  ]) {
    assert.throws(() => readGmailPageCursor({ secret, cursor, context: changed, now: 1_001 }), /does not match/u);
  }
});

test("Gmail cursors reject tampering and expiry before a provider call", () => {
  const cursor = createGmailPageCursor({ secret, context, pageToken: "google-page-token", now: 1_000 });
  assert.throws(() => readGmailPageCursor({ secret, cursor: `${cursor}x`, context, now: 1_001 }), /invalid/u);
  assert.throws(() => readGmailPageCursor({ secret, cursor, context, now: 901_000 }), /does not match/u);
});
