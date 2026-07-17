import type React from "react";
import { Box, Text } from "ink";

import type { LayoutProfile } from "../../contracts.js";
import { AdaptiveOverlayFrame } from "./AdaptiveOverlayFrame.js";
import { HELP_LINES } from "../keymap.js";
import { theme } from "../theme/tokens.js";

interface HelpOverlayProps {
  open: boolean;
  layoutProfile: LayoutProfile;
}

export function HelpOverlay(props: HelpOverlayProps): React.JSX.Element | null {
  if (props.open === false) {
    return null;
  }

  return (
    <AdaptiveOverlayFrame layoutProfile={props.layoutProfile} borderColor={theme.panelAlt}>
      <Box flexDirection="column">
        <Text color={theme.text} bold>
          Keyboard Help
        </Text>
        {HELP_LINES.map((line) => (
          <Text key={line} color={theme.text}>
            {line}
          </Text>
        ))}
        <Text color={theme.muted}>Esc close</Text>
      </Box>
    </AdaptiveOverlayFrame>
  );
}
