import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";

import { LaunchRoot } from "./LaunchRoot";
import { FileEditorApp } from "./FileEditorApp";
import { RendererErrorBoundary } from "./RendererErrorBoundary";
import { ensureBrowserPreviewBridge } from "./browserPreview";
import { reportRendererBootstrapReadyAfterCommit } from "./rendererBootstrap";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Desktop renderer root is missing.");
}

ensureBrowserPreviewBridge();

const params = new URLSearchParams(window.location.search);
const editorView = params.get("view") === "editor";
const filePath = params.get("filePath");
const projectPath = params.get("projectPath");
const projectLabel = params.get("projectLabel");
const threadId = params.get("threadId");
const lineNumber = parseSourcePosition(params.get("lineNumber"));
const columnNumber = parseSourcePosition(params.get("columnNumber"));

createRoot(root).render(
  <StrictMode>
    <RendererErrorBoundary>
      {editorView && filePath !== null && projectPath !== null && projectLabel !== null ? (
        <FileEditorApp
          filePath={filePath}
          projectPath={projectPath}
          projectLabel={projectLabel}
          {...(threadId !== null ? { threadId } : {})}
          {...(lineNumber !== undefined ? { lineNumber } : {})}
          {...(columnNumber !== undefined ? { columnNumber } : {})}
        />
      ) : (
        <>
          <RendererBootstrapReporter />
          <LaunchRoot />
        </>
      )}
    </RendererErrorBoundary>
  </StrictMode>,
);

function RendererBootstrapReporter(): null {
  useEffect(reportRendererBootstrapReadyAfterCommit, []);
  return null;
}

function parseSourcePosition(value: string | null): number | undefined {
  if (value === null) {
    return;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
