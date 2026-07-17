import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { DesktopApp } from "./DesktopApp";
import { FileEditorApp } from "./FileEditorApp";
import { ensureBrowserPreviewBridge } from "./browserPreview";
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

createRoot(root).render(
  <StrictMode>
    {editorView && filePath !== null && projectPath !== null && projectLabel !== null ? (
      <FileEditorApp
        filePath={filePath}
        projectPath={projectPath}
        projectLabel={projectLabel}
      />
    ) : (
      <DesktopApp />
    )}
  </StrictMode>,
);
