import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { DesktopApp } from "./DesktopApp";
import { FileEditorApp } from "./FileEditorApp";
import { ensureBrowserPreviewBridge } from "./browserPreview";
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
      <DesktopApp />
    )}
  </StrictMode>,
);

function parseSourcePosition(value: string | null): number | undefined {
  if (value === null) {
    return;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
