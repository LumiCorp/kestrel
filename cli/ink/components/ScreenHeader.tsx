import type React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme/tokens.js";

interface ScreenHeaderProps {
  title: string;
  right?: React.ReactNode;
}

export function ScreenHeader(props: ScreenHeaderProps): React.JSX.Element {
  return (
    <Box justifyContent="space-between" marginBottom={0}>
      <Text color={theme.text} bold>
        {props.title}
      </Text>
      <Box>{props.right}</Box>
    </Box>
  );
}
