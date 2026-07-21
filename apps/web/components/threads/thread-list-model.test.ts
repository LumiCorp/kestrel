import assert from "node:assert/strict";
import test from "node:test";
import { filterAndSortThreads } from "./thread-list-model";

const threads = [
  {
    id: "one",
    title: "Runtime review",
    updatedAt: "2026-07-20T12:00:00.000Z",
    unreadCount: 0,
  },
  {
    id: "two",
    title: "Agent contracts",
    updatedAt: "2026-07-19T12:00:00.000Z",
    unreadCount: 3,
  },
];

test("filters thread titles without changing the source collection", () => {
  assert.deepEqual(filterAndSortThreads(threads, "agent", "recent"), [
    threads[1],
  ]);
  assert.equal(threads[0]?.id, "one");
});

test("sorts threads by explicit recent, oldest, title, and unread modes", () => {
  assert.deepEqual(
    filterAndSortThreads(threads, "", "recent").map((thread) => thread.id),
    ["one", "two"]
  );
  assert.deepEqual(
    filterAndSortThreads(threads, "", "oldest").map((thread) => thread.id),
    ["two", "one"]
  );
  assert.deepEqual(
    filterAndSortThreads(threads, "", "title").map((thread) => thread.id),
    ["two", "one"]
  );
  assert.deepEqual(
    filterAndSortThreads(threads, "", "unread").map((thread) => thread.id),
    ["two", "one"]
  );
});
