import assert from "node:assert/strict";
import test from "node:test";
import { isThreadListCacheKey } from "./cache-keys";

test("Thread list cache keys include every unfiltered and scoped list", () => {
  assert.equal(isThreadListCacheKey("/api/threads?limit=30"), true);
  assert.equal(isThreadListCacheKey("/api/threads?limit=100"), true);
  assert.equal(
    isThreadListCacheKey("/api/threads?project_id=project-1&limit=100"),
    true,
  );
  assert.equal(
    isThreadListCacheKey("/api/threads?standalone=true&limit=100"),
    true,
  );
});

test("Thread list cache keys exclude detail, stream, and unrelated caches", () => {
  assert.equal(isThreadListCacheKey("/api/threads/thread-1"), false);
  assert.equal(isThreadListCacheKey("/api/threads/thread-1/stream"), false);
  assert.equal(isThreadListCacheKey("/api/projects"), false);
  assert.equal(isThreadListCacheKey(["/api/threads?limit=100"]), false);
  assert.equal(isThreadListCacheKey(null), false);
});
