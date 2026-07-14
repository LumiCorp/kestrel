import "server-only";

import {
  decodeTurnEventCursor,
  encodeTurnEventCursor,
} from "@/lib/turns/contracts";
import { getDurableTurn, listDurableTurnEvents } from "@/lib/turns/store";

const encoder = new TextEncoder();
const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

function waitForEvents(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(finish, 250);
    signal.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

export function createMobileTurnEventResponse(input: {
  turnId: string;
  request: Request;
}) {
  const cursor = decodeTurnEventCursor(
    input.request.headers.get("last-event-id") ||
      new URL(input.request.url).searchParams.get("cursor")
  );
  let sequence = cursor?.turnId === input.turnId ? cursor.sequence : 0;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (!input.request.signal.aborted) {
          const events = await listDurableTurnEvents({
            turnId: input.turnId,
            afterSequence: sequence,
          });
          for (const event of events) {
            sequence = event.sequence;
            const id = encodeTurnEventCursor(input.turnId, event.sequence);
            controller.enqueue(
              encoder.encode(
                `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify({
                  id,
                  type: event.type,
                  data: event.data,
                  createdAt: event.createdAt.toISOString(),
                })}\n\n`
              )
            );
          }
          const turn = await getDurableTurn(input.turnId);
          if (!turn || terminalStatuses.has(turn.status)) {
            controller.close();
            return;
          }
          await waitForEvents(input.request.signal);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(stream, {
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
      "x-kestrel-turn-id": input.turnId,
    },
  });
}
