import type React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme/tokens.js";

interface DetailDrawerProps {
  open: boolean;
  title: string;
  children: React.ReactNode;
}

export function DetailDrawer(props: DetailDrawerProps): React.JSX.Element | null {
  if (!props.open) {
    return null;
  }

  return (
    <Box
      marginTop={0}
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.panelAlt}
      backgroundColor={theme.panelSoft}
      paddingX={1}
    >
      <Text color={theme.text}>{props.title}</Text>
      <Box flexDirection="column">{props.children}</Box>
    </Box>
  );
}
