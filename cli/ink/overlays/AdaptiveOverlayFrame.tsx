import React from "react";
import { Box } from "ink";

import type { LayoutProfile } from "../../contracts.js";
import { theme } from "../theme/tokens.js";

interface AdaptiveOverlayFrameProps {
  layoutProfile: LayoutProfile;
  borderColor: string;
  fullScreen?: boolean;
  children: React.ReactNode;
}

export function AdaptiveOverlayFrame(props: AdaptiveOverlayFrameProps): React.JSX.Element {
  if (props.fullScreen) {
    return (
      <Box position="absolute" width="100%" height="100%">
        <Box
          width="100%"
          height="100%"
          borderStyle="single"
          borderColor={props.borderColor}
          paddingX={1}
          paddingY={0}
          flexDirection="column"
          backgroundColor={theme.panel}
        >
          {props.children}
        </Box>
      </Box>
    );
  }

  if (props.layoutProfile === "narrow") {
    return (
      <Box position="absolute" width="100%" height="100%" justifyContent="flex-end">
        <Box
          width="100%"
          borderStyle="single"
          borderColor={props.borderColor}
          paddingX={1}
          paddingY={0}
          flexDirection="column"
          backgroundColor={theme.panel}
        >
          {props.children}
        </Box>
      </Box>
    );
  }

  const width = props.layoutProfile === "wide" ? 118 : 100;
  return (
    <Box position="absolute" width="100%" height="100%" justifyContent="center" alignItems="center">
      <Box
        width={width}
        borderStyle="round"
        borderColor={props.borderColor}
        paddingX={2}
        paddingY={0}
        flexDirection="column"
        backgroundColor={theme.panel}
      >
        {props.children}
      </Box>
    </Box>
  );
}
