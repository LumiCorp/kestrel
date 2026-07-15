"use client";

import { ActivityIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { shouldAutoCloseReasoning } from "@/lib/agent/kestrel-reasoning-display";
import type { KestrelTerminalStatus } from "@kestrel-agents/ai-sdk";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "./elements/reasoning";

type MessageReasoningProps = {
  isLoading: boolean;
  reasoning: string;
  terminalStatus?: KestrelTerminalStatus | null;
};

export function MessageReasoning({
  isLoading,
  reasoning,
  terminalStatus,
}: MessageReasoningProps) {
  const [hasBeenStreaming, setHasBeenStreaming] = useState(isLoading);

  useEffect(() => {
    if (isLoading) {
      setHasBeenStreaming(true);
    }
  }, [isLoading]);

  return (
    <Reasoning
      data-testid="message-reasoning"
      defaultOpen={
        hasBeenStreaming || !shouldAutoCloseReasoning(terminalStatus)
      }
      isStreaming={isLoading}
      terminalStatus={terminalStatus}
    >
      <ReasoningTrigger className="px-2 py-1 text-xs">
        <ActivityIcon className="size-3.5" />
        <span>{isLoading ? "Model reasoning — live" : "Model reasoning"}</span>
        {isLoading ? (
          <span
            aria-label="Agent is working"
            className="ml-1 size-1.5 animate-pulse rounded-full bg-primary"
          />
        ) : null}
      </ReasoningTrigger>
      <ReasoningContent className="text-xs">{reasoning}</ReasoningContent>
    </Reasoning>
  );
}
