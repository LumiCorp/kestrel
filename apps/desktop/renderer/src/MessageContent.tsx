import React from "react";
import { Streamdown } from "streamdown";

interface MessageContentProps {
  messageRole: "user" | "assistant" | "system";
  text: string;
  streaming?: boolean | undefined;
}

export function MessageContent({ messageRole, text, streaming = false }: MessageContentProps) {
  if (messageRole !== "assistant") {
    return <div className="message-body message-body-plain">{text}</div>;
  }

  return (
    <Streamdown
      className="message-body message-body-markdown"
      controls={false}
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown={streaming}
    >
      {text}
    </Streamdown>
  );
}
