"use client";

import { useEffect, useMemo, useState } from "react";
import { readChatFirstTurnHandoff } from "@/lib/chat/first-turn-handoff";
import type { ChatFirstTurnHandoff } from "@/lib/types";
import { getTextFromMessage } from "@/lib/utils";

export function ThreadRouteLoading({ threadId }: { threadId: string }) {
  const [handoff, setHandoff] = useState<ChatFirstTurnHandoff | null>(null);

  useEffect(() => {
    setHandoff(readChatFirstTurnHandoff(threadId));
  }, [threadId]);

  const userText = useMemo(() => {
    if (!handoff) return "";
    return getTextFromMessage({
      id: handoff.messageId,
      role: "user",
      parts: handoff.messageParts,
    });
  }, [handoff]);

  return (
    <div
      aria-busy="true"
      className="flex min-h-0 flex-1 flex-col"
      data-testid="thread-route-loading"
    >
      <header className="flex h-14 shrink-0 items-center border-b px-4">
        <h1 className="font-semibold">New Thread</h1>
      </header>
      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col justify-end gap-6 px-4 py-6">
        {userText ? (
          <div className="ml-auto max-w-[80%] rounded-2xl bg-[#006cff] px-3 py-2 text-white">
            {userText}
          </div>
        ) : null}
        <div
          aria-live="polite"
          className="text-muted-foreground text-sm"
          role="status"
        >
          Starting the agent and saving this Thread…
        </div>
        <div className="min-h-28 rounded-2xl border bg-background px-4 py-3 text-muted-foreground">
          Your message is saved locally while the durable Thread opens.
        </div>
      </div>
    </div>
  );
}
