import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme/tokens.js";

interface StatusChipProps {
  label: string;
  tone?: "brand" | "muted" | "warn" | "error" | "success";
}

export function StatusChip(props: StatusChipProps): React.JSX.Element {
  const tone = props.tone ?? "muted";
  const color =
    tone === "brand"
      ? theme.text
      : tone === "warn"
        ? theme.warn
        : tone === "error"
          ? theme.error
          : tone === "success"
            ? theme.success
            : theme.muted;

  return (
    <Box borderStyle="round" borderColor={color} paddingX={1}>
      <Text color={color}>{props.label}</Text>
    </Box>
  );
}
