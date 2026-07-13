import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { KestrelClient } from "../../../packages/sdk/src/runner.js";
import { sdkE2eContext } from "./helpers.js";

test("subscription async iteration fails on malformed SSE after partial delivery over real HTTP", async (t) => {
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/events/stream") {
      response.statusCode = 404;
      response.end("not found");
      return;
    }

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(
      `event: task.updated\ndata: ${JSON.stringify({
        id: "evt-task-updated",
        type: "task.updated",
        ts: new Date().toISOString(),
        sessionId: "fault-session",
        payload: {
          task: {
            taskId: "task-1",
          },
          kind: "waiting",
          assistantText: null,
        },
      })}\n\n`,
    );
    response.write("event: task.updated\ndata: {broken-json\n\n");
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(() => {
    server.close();
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const client = new KestrelClient({
    target: {
      kind: "remote",
      baseUrl: `http://127.0.0.1:${address.port}`,
    },
  });
  t.after(async () => {
    await client.close();
  });

  const stream = client.subscribe(
    {
      sessionId: "fault-session",
      eventTypes: ["task.updated"],
    },
    sdkE2eContext,
  );

  const iterator = stream[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value?.type, "task.updated");

  await assert.rejects(
    iterator.next(),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as Error & { code?: string }).code === "RUNNER_PROTOCOL_ERROR",
  );
});
