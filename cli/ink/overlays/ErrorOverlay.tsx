import React from "react";
import { Box, Text } from "ink";

import type { LayoutProfile } from "../../contracts.js";
import type { UiErrorState } from "../store/UiStore.js";
import { theme } from "../theme/tokens.js";

interface ErrorOverlayProps {
  layoutProfile: LayoutProfile;
  error?: UiErrorState | undefined;
  expanded: boolean;
  scrollOffset: number;
  viewportRows: number;
  viewportColumns: number;
}

export function ErrorOverlay(props: ErrorOverlayProps): React.JSX.Element | null {
  if (props.error === undefined) {
    return null;
  }

  const modalWidth = resolveModalWidth(props.layoutProfile, props.viewportColumns);
  const lineWidth = Math.max(24, modalWidth - 4);
  const lines = buildLines(props.error, props.expanded, lineWidth);
  const bodyRows = props.expanded
    ? Math.max(6, Math.min(14, props.viewportRows - 12))
    : Math.max(4, Math.min(8, props.viewportRows - 18));
  const maxOffset = Math.max(0, lines.length - bodyRows);
  const offset = Math.min(Math.max(0, props.scrollOffset), maxOffset);
  const visible = lines.slice(offset, offset + bodyRows);
  const rangeStart = lines.length === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(lines.length, offset + visible.length);
  const detailsAvailable = props.error.details !== undefined;
  const diagnosticsHint = detailsAvailable ? " | d diagnostics" : "";

  return (
    <Box position="absolute" width="100%" height="100%" justifyContent="center" alignItems="center">
      <Box
        width={modalWidth}
        borderStyle="round"
        borderColor={theme.error}
        paddingX={1}
        flexDirection="column"
        backgroundColor={theme.panel}
      >
        <Text color={theme.error} bold>
          Runtime Error {props.error.code ? `(${props.error.code})` : ""}
        </Text>
        <Box flexDirection="column">
          {visible.map((line, index) => (
            <Text key={`err-${offset + index}`} color={line.tone}>
              {line.text}
            </Text>
          ))}
        </Box>
        <Text color={theme.muted}>
          Esc dismiss{diagnosticsHint} · j/k scroll · PgUp/PgDn page · g/G bounds · {rangeStart}-{rangeEnd}/{Math.max(lines.length, 1)}
        </Text>
      </Box>
    </Box>
  );
}

function resolveModalWidth(layoutProfile: LayoutProfile, viewportColumns: number): number {
  if (layoutProfile === "narrow") {
    return Math.max(32, viewportColumns - 4);
  }
  if (layoutProfile === "wide") {
    return Math.min(96, Math.max(42, viewportColumns - 18));
  }
  return Math.min(84, Math.max(40, viewportColumns - 14));
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "<unserializable>";
  }
}

function buildLines(
  error: UiErrorState,
  expanded: boolean,
  lineWidth: number,
): Array<{ text: string; tone: string }> {
  const lines: Array<{ text: string; tone: string }> = [];
  for (const line of splitLines(error.message, lineWidth)) {
    lines.push({ text: line, tone: theme.text });
  }
  if (expanded && error.details !== undefined) {
    lines.push({ text: "", tone: theme.muted });
    lines.push({ text: "Diagnostics:", tone: theme.text });
    for (const line of splitLines(stringify(error.details), lineWidth)) {
      lines.push({ text: line, tone: theme.muted });
    }
  }
  return lines;
}

function splitLines(value: string, lineWidth: number): string[] {
  const normalized = value.replace(/\r\n/gu, "\n");
  return normalized.split("\n").flatMap((line) => {
    if (line.length <= lineWidth) {
      return [line];
    }
    const chunks: string[] = [];
    for (let idx = 0; idx < line.length; idx += lineWidth) {
      chunks.push(line.slice(idx, idx + lineWidth));
    }
    return chunks;
  });
}
