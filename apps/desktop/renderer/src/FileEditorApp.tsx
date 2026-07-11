import { ExternalLink, Save } from "lucide-react";
import React from "react";
import { useEffect, useState } from "react";

import type { DesktopFileContent } from "../../src/contracts";

export function FileEditorApp(props: {
  filePath: string;
  projectPath: string;
  projectLabel: string;
}) {
  const [file, setFile] = useState<DesktopFileContent>();
  const [content, setContent] = useState("");
  const [status, setStatus] = useState("Opening file");

  useEffect(() => {
    let disposed = false;
    void window.kestrelDesktop.readFile({
      rootPath: props.projectPath,
      targetPath: props.filePath,
    }).then((nextFile) => {
      if (disposed) {
        return;
      }
      setFile(nextFile);
      setContent(nextFile.content);
      setStatus(nextFile.editable === false ? "Read only" : "Ready");
    }).catch((error) => {
      if (disposed === false) {
        setStatus(error instanceof Error ? error.message : String(error));
      }
    });
    return () => {
      disposed = true;
    };
  }, [props.filePath, props.projectPath]);

  async function save(): Promise<void> {
    if (file === undefined || file.editable === false) {
      return;
    }
    setStatus("Saving");
    try {
      const saved = await window.kestrelDesktop.writeFile({
        rootPath: props.projectPath,
        targetPath: props.filePath,
        content,
        ...(file.contentHash !== undefined ? { expectedContentHash: file.contentHash } : {}),
        ...(file.lineEnding !== undefined && file.lineEnding !== "mixed"
          ? { lineEnding: file.lineEnding }
          : {}),
      });
      setFile(saved);
      setContent(saved.content);
      setStatus("Saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="editor-app">
      <header className="editor-titlebar">
        <div className="brand-lockup">
          <span className="brand-mark">K</span>
          <strong>{props.projectLabel}</strong>
        </div>
        <div className="editor-file-title" title={props.filePath}>
          {fileName(props.filePath)}
        </div>
        <div className="titlebar-actions">
          <button
            className="icon-button"
            type="button"
            title="Open externally"
            aria-label="Open externally"
            onClick={() => void window.kestrelDesktop.openPath({
              rootPath: props.projectPath,
              targetPath: props.filePath,
            })}
          >
            <ExternalLink size={16} />
          </button>
          <button
            className="primary-icon-button"
            type="button"
            title="Save file"
            aria-label="Save file"
            disabled={file === undefined || file.editable === false || content === file.content}
            onClick={() => void save()}
          >
            <Save size={16} />
          </button>
        </div>
      </header>
      <main className="editor-workspace">
        {file === undefined ? (
          <div className="editor-empty">{status}</div>
        ) : file.viewKind === "binary" ? (
          <div className="editor-empty">Binary file</div>
        ) : (
          <textarea
            aria-label={`Edit ${fileName(props.filePath)}`}
            readOnly={file.editable === false}
            spellCheck={false}
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
        )}
      </main>
      <footer className="editor-status">
        <span>{status}</span>
        <span>{file?.language ?? file?.viewKind ?? "file"}</span>
        <span>{file?.sizeBytes === undefined ? "" : formatBytes(file.sizeBytes)}</span>
      </footer>
    </div>
  );
}

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/u).at(-1) ?? filePath;
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
