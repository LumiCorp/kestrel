import React from "react";
import { Streamdown } from "streamdown";

interface MessageContentProps {
  role: "user" | "assistant" | "system";
  text: string;
  streaming?: boolean | undefined;
}

export function MessageContent({ role, text, streaming = false }: MessageContentProps) {
  if (role !== "assistant") {
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
