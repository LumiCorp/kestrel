import type React from "react";
import { Box, Text } from "ink";

import type { LayoutProfile } from "../../contracts.js";
import { AdaptiveOverlayFrame } from "./AdaptiveOverlayFrame.js";
import { ThemedTextInput } from "../components/ThemedTextInput.js";
import { theme } from "../theme/tokens.js";

export interface PaletteAction {
  id: string;
  label: string;
  detail?: string | undefined;
  command?: string | undefined;
  draft?: string | undefined;
  group?: string | undefined;
  groupLabel?: string | undefined;
  searchText?: string | undefined;
}

interface CommandPaletteProps {
  open: boolean;
  layoutProfile: LayoutProfile;
  title?: string | undefined;
  placeholder?: string | undefined;
  query: string;
  actions: PaletteAction[];
  totalCount: number;
  selectedIndex: number;
  onChangeQuery: (value: string) => void;
  onClose: () => void;
}

export function CommandPalette(props: CommandPaletteProps): React.JSX.Element | null {
  if (props.open === false) {
    return null;
  }

  return (
    <AdaptiveOverlayFrame layoutProfile={props.layoutProfile} borderColor={theme.panelAlt}>
      <Box flexDirection="column">
        <Text color={theme.text} bold>
          {props.title ?? "Commands"}
        </Text>
        <ThemedTextInput
          value={props.query}
          onChange={props.onChangeQuery}
          placeholder={props.placeholder ?? "Type a command..."}
          focus
        />
        <Box flexDirection="column" marginTop={1}>
          {props.actions.map((action, index) => {
            const previous = props.actions[index - 1];
            const showGroup = action.groupLabel !== undefined && action.groupLabel !== previous?.groupLabel;
            return (
              <Box key={action.id} flexDirection="column">
                {showGroup ? (
                  <Box marginTop={index === 0 ? 0 : 1}>
                    <Text color={theme.muted}>{action.groupLabel}</Text>
                  </Box>
                ) : null}
                <Text color={theme.text}>
                  {index === props.selectedIndex ? "▸" : " "} {truncate(action.command ?? action.draft ?? action.label, 56)}
                </Text>
                {index === props.selectedIndex ? (
                  <Text color={theme.muted}>
                    {"  "}
                    {truncate(action.command !== undefined || action.draft !== undefined ? action.label : (action.detail ?? ""), 64)}
                  </Text>
                ) : null}
              </Box>
            );
          })}
          {props.actions.length === 0 ? <Text color={theme.muted}>No commands found.</Text> : null}
        </Box>
        <Box marginTop={1}>
          <Text color={theme.muted}>Enter select · Esc close · Up/Down move</Text>
          {props.query.trim().length > 0 ? (
            <Text color={theme.muted}> matches {props.actions.length}/{props.totalCount}</Text>
          ) : null}
        </Box>
      </Box>
    </AdaptiveOverlayFrame>
  );
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}
