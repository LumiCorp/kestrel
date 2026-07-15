import "server-only";

import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessageChunk,
} from "ai";
import { getDurableTurn, listDurableTurnEvents } from "@/lib/turns/store";
import { isDurableTurnReplayComplete } from "@/lib/turns/replay-status";

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

export function createDurableTurnReplayResponse(input: {
  turnId: string;
  signal: AbortSignal;
  afterSequence?: number;
}) {
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      let sequence = input.afterSequence ?? 0;
      while (!input.signal.aborted) {
        const events = await listDurableTurnEvents({
          turnId: input.turnId,
          afterSequence: sequence,
        });
        for (const event of events) {
          sequence = event.sequence;
          if (event.type === "ui.message" && event.data) {
            writer.write(event.data as UIMessageChunk);
          }
        }
        const turn = await getDurableTurn(input.turnId);
        if (!turn || isDurableTurnReplayComplete(turn.status)) {
          return;
        }
        await waitForEvents(input.signal);
      }
    },
    onError: (error) =>
      error instanceof Error
        ? error.message
        : "Durable response recovery failed.",
  });
  return createUIMessageStreamResponse({
    stream,
    headers: {
      "cache-control": "no-cache, no-transform",
      "x-kestrel-turn-id": input.turnId,
    },
  });
}
