"use client";

import { useEffect, useState } from "react";
import { shouldAutoCloseReasoning } from "@/lib/agent/kestrel-reasoning-display";
import type { KestrelTerminalStatus } from "@/lib/agent/kestrel-stream-events";
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
      <ReasoningTrigger />
      <ReasoningContent>{reasoning}</ReasoningContent>
    </Reasoning>
  );
}
