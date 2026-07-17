import type React from "react";
import { Box } from "ink";

import type { UiRuntimeState } from "./store/UiStore.js";
import type { InkAppController } from "./AppRoot.js";
import { theme } from "./theme/tokens.js";

export interface ActiveViewHostRenderers {
  chat(): React.JSX.Element;
  logs(listRows: number): React.JSX.Element;
  sessions(listRows: number): React.JSX.Element;
  tasks(listRows: number): React.JSX.Element;
  history(listRows: number): React.JSX.Element;
  workspace(listRows: number): React.JSX.Element;
  mcp(listRows: number): React.JSX.Element;
  code(listRows: number): React.JSX.Element;
  delegation(listRows: number): React.JSX.Element;
  recovery(listRows: number): React.JSX.Element;
}

export function ActiveViewHost(props: {
  state: UiRuntimeState;
  controller: InkAppController;
  rowCounts: { sessions: number; chat: number; logs: number };
  renderers: ActiveViewHostRenderers;
}): React.JSX.Element {
  const contentHeight = Math.max(6, props.state.viewport.rows - 2);
  const screen =
    props.state.activeView === "history" ? (
      props.renderers.history(props.rowCounts.sessions)
    ) : props.state.activeView === "sessions" ? (
      props.renderers.sessions(props.rowCounts.sessions)
    ) : props.state.activeView === "tasks" ? (
      props.renderers.tasks(props.rowCounts.sessions)
    ) : props.state.activeView === "mcp" ? (
      props.renderers.mcp(props.rowCounts.sessions)
    ) : props.state.activeView === "code" ? (
      props.renderers.code(props.rowCounts.sessions)
    ) : props.state.activeView === "delegation" ? (
      props.renderers.delegation(props.rowCounts.sessions)
    ) : props.state.activeView === "recovery" ? (
      props.renderers.recovery(props.rowCounts.sessions)
    ) : props.state.activeView === "workspace" ? (
      props.renderers.workspace(props.rowCounts.sessions)
    ) : props.state.activeView === "logs" ? (
      props.renderers.logs(props.rowCounts.logs)
    ) : (
      props.renderers.chat()
    );
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      height={contentHeight}
      paddingX={1}
      backgroundColor={theme.bg}
    >
      {screen}
    </Box>
  );
}
