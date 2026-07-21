import { Copy, ExternalLink, Eye, FolderOpen, Pencil, RotateCcw, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";

import type { DesktopFileContent } from "../../src/contracts";

export function FileEditorApp(props: {
  filePath: string;
  projectPath: string;
  projectLabel: string;
  threadId?: string | undefined;
  lineNumber?: number | undefined;
  columnNumber?: number | undefined;
}) {
  const [file, setFile] = useState<DesktopFileContent>();
  const [content, setContent] = useState("");
  const [status, setStatus] = useState("Opening file");
  const [externalChange, setExternalChange] = useState(false);
  const [viewMode, setViewMode] = useState<"edit" | "preview">("edit");
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const dirty = file !== undefined && content !== file.content;

  useEffect(() => {
    let disposed = false;
    void window.kestrelDesktop.readFile({
      rootPath: props.projectPath,
      targetPath: props.filePath,
      ...(props.threadId !== undefined ? { threadId: props.threadId } : {}),
    }).then((nextFile) => {
      if (disposed) {
        return;
      }
      setFile(nextFile);
      setContent(nextFile.content);
      setExternalChange(false);
      setStatus(nextFile.editable === false ? "Read only" : "Ready");
    }).catch((error) => {
      if (disposed === false) {
        setStatus(error instanceof Error ? error.message : String(error));
      }
    });
    return () => {
      disposed = true;
    };
  }, [props.filePath, props.projectPath, props.threadId]);

  useEffect(() => {
    if (file === undefined || props.lineNumber === undefined || editorRef.current === null) {
      return;
    }
    const offset = sourceOffset(file.content, props.lineNumber, props.columnNumber ?? 1);
    editorRef.current.focus();
    editorRef.current.setSelectionRange(offset, offset);
    const lineHeight = Number.parseFloat(window.getComputedStyle(editorRef.current).lineHeight) || 20;
    editorRef.current.scrollTop = Math.max(0, (props.lineNumber - 3) * lineHeight);
  }, [file?.path, props.columnNumber, props.lineNumber]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    let disposed = false;
    void window.kestrelDesktop.watchProjectFiles(props.projectPath, props.threadId);
    const unsubscribe = window.kestrelDesktop.onProjectFilesChanged((event) => {
      if (event.rootPath !== props.projectPath || file === undefined) {
        return;
      }
      void window.kestrelDesktop.readFile({
        rootPath: props.projectPath,
        targetPath: props.filePath,
        ...(props.threadId !== undefined ? { threadId: props.threadId } : {}),
      }).then((diskFile) => {
        if (disposed || diskFile.contentHash === file.contentHash) {
          return;
        }
        if (dirty) {
          setExternalChange(true);
          setStatus("Changed on disk — reload or preserve your unsaved edits");
          return;
        }
        setFile(diskFile);
        setContent(diskFile.content);
        setExternalChange(false);
        setStatus("Reloaded external change");
      }).catch((error) => {
        if (disposed === false) {
          setStatus(error instanceof Error ? error.message : String(error));
        }
      });
    });
    return () => {
      disposed = true;
      unsubscribe();
      void window.kestrelDesktop.unwatchProjectFiles(props.projectPath);
    };
  }, [dirty, file, props.filePath, props.projectPath, props.threadId]);

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
        ...(props.threadId !== undefined ? { threadId: props.threadId } : {}),
        ...(file.contentHash !== undefined ? { expectedContentHash: file.contentHash } : {}),
        ...(file.lineEnding !== undefined && file.lineEnding !== "mixed"
          ? { lineEnding: file.lineEnding }
          : {}),
      });
      setFile(saved);
      setContent(saved.content);
      setExternalChange(false);
      setStatus("Saved");
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "desktop.stale_file_write") {
        setExternalChange(true);
      }
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function reloadFromDisk(): Promise<void> {
    if (dirty && !window.confirm("Discard unsaved edits and reload the current file from disk?")) {
      return;
    }
    setStatus("Reloading");
    try {
      const diskFile = await window.kestrelDesktop.readFile({
        rootPath: props.projectPath,
        targetPath: props.filePath,
        ...(props.threadId !== undefined ? { threadId: props.threadId } : {}),
      });
      setFile(diskFile);
      setContent(diskFile.content);
      setExternalChange(false);
      setStatus(diskFile.editable === false ? "Read only" : "Reloaded");
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
            title={viewMode === "edit" ? "Preview file" : "Edit file"}
            aria-label={viewMode === "edit" ? "Preview file" : "Edit file"}
            disabled={file === undefined || file.viewKind === "binary"}
            onClick={() => setViewMode((current) => current === "edit" ? "preview" : "edit")}
          >
            {viewMode === "edit" ? <Eye size={16} /> : <Pencil size={16} />}
          </button>
          <button
            className="icon-button"
            type="button"
            title="Copy path"
            aria-label="Copy path"
            onClick={() => void navigator.clipboard.writeText(props.filePath)}
          >
            <Copy size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            title="Reveal in Finder"
            aria-label="Reveal in Finder"
            onClick={() => void window.kestrelDesktop.revealPath({
              rootPath: props.projectPath,
              targetPath: props.filePath,
              ...(props.threadId !== undefined ? { threadId: props.threadId } : {}),
            })}
          >
            <FolderOpen size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            title="Open externally"
            aria-label="Open externally"
            onClick={() => void window.kestrelDesktop.openPath({
              rootPath: props.projectPath,
              targetPath: props.filePath,
              ...(props.threadId !== undefined ? { threadId: props.threadId } : {}),
            })}
          >
            <ExternalLink size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            title={externalChange ? "Reload changed file" : "Reload file"}
            aria-label="Reload file"
            onClick={() => void reloadFromDisk()}
          >
            <RotateCcw size={16} />
          </button>
          <button
            className="primary-icon-button"
            type="button"
            title="Save file"
            aria-label="Save file"
            disabled={file === undefined || file.editable === false || dirty === false || externalChange}
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
        ) : viewMode === "preview" ? (
          <div className="editor-preview">
            <Streamdown controls={false} mode="static">
              {previewMarkdown(file, content)}
            </Streamdown>
          </div>
        ) : (
          <textarea
            ref={editorRef}
            aria-label={`Edit ${fileName(props.filePath)}`}
            readOnly={file.editable === false}
            spellCheck={false}
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
        )}
      </main>
      <footer className="editor-status">
        <span>{dirty ? "Unsaved · " : ""}{externalChange ? "External change · " : ""}{status}</span>
        <span>{file?.language ?? file?.viewKind ?? "file"}</span>
        <span>{file?.sizeBytes === undefined ? "" : formatBytes(file.sizeBytes)}</span>
      </footer>
    </div>
  );
}

function sourceOffset(content: string, lineNumber: number, columnNumber: number): number {
  const lines = content.split("\n");
  const boundedLine = Math.min(Math.max(lineNumber, 1), Math.max(lines.length, 1));
  let offset = 0;
  for (let index = 0; index < boundedLine - 1; index += 1) {
    offset += (lines[index]?.length ?? 0) + 1;
  }
  return offset + Math.min(Math.max(columnNumber - 1, 0), lines[boundedLine - 1]?.length ?? 0);
}

function previewMarkdown(file: DesktopFileContent, content: string): string {
  if (file.viewKind === "markdown") {
    return content;
  }
  const longestFence = Math.max(3, ...[...content.matchAll(/`+/gu)].map((match) => match[0].length + 1));
  const fence = "`".repeat(longestFence);
  return `${fence}${file.language ?? "text"}\n${content}\n${fence}`;
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
