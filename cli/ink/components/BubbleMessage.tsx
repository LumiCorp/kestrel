import type React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme/tokens.js";

interface BubbleMessageProps {
  role: "user" | "assistant" | "system";
  lines: string[];
  reasoning: boolean;
  meta: string;
  selected: boolean;
  highlightedRun: boolean;
  attention: boolean;
  width: number;
}

export function BubbleMessage(props: BubbleMessageProps): React.JSX.Element {
  const roleLabel =
    props.role === "user"
      ? "YOU"
      : props.role === "assistant"
        ? props.reasoning
          ? "AGENT (REASONING)"
          : "AGENT"
        : "SYSTEM";
  const roleColor =
    props.role === "user"
      ? theme.text
      : props.role === "assistant"
        ? props.reasoning
          ? theme.muted
          : theme.text
        : theme.warn;
  const headerColor = props.selected || props.highlightedRun ? theme.text : roleColor;
  const lineColor = props.attention
    ? theme.warn
    : props.role === "system" || props.reasoning
      ? theme.muted
      : theme.text;
  const accent = props.selected ? ">" : props.highlightedRun ? "*" : " ";
  const roleMarker = props.role === "user" ? ">>" : props.role === "assistant" ? (props.reasoning ? ".." : "<<") : "!!";
  const linePrefix = props.role === "user" ? ">> " : props.role === "assistant" ? (props.reasoning ? ".. " : "<< ") : "!! ";
  const continuationPrefix = props.role === "user" ? "   " : props.role === "assistant" ? "   " : "   ";
  const header = `${accent} ${roleMarker} ${roleLabel} · ${props.meta}`;

  const trailingMargin = props.role === "assistant" ? 2 : 1;

  return (
    <Box flexDirection="column" marginBottom={trailingMargin}>
      <Text color={headerColor} bold>
        {header}
      </Text>
      {props.lines.length === 0 ? (
        <Text color={lineColor}>{linePrefix}</Text>
      ) : (
        props.lines.map((line, index) => (
          <Text key={`${props.role}-${index}`} color={lineColor}>
            {index === 0 ? linePrefix : continuationPrefix}
            {line}
          </Text>
        ))
      )}
    </Box>
  );
}
