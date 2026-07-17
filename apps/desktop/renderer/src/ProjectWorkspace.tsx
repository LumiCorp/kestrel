import {
  ArrowUp,
  ExternalLink,
  File,
  Folder,
  MessageSquare,
  Play,
  RefreshCw,
  Search,
  Square,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import type {
  DesktopDirectoryListing,
  DesktopFileSearchResponse,
  DesktopManagedProjectRun,
  DesktopPackageManager,
  DesktopProjectLauncherDescriptor,
  DesktopProjectRegistration,
} from "../../src/contracts";

export function ProjectWorkspace(props: {
  project: DesktopProjectRegistration | undefined;
  onChat: (project: DesktopProjectRegistration) => void;
  onError: (message: string | undefined) => void;
}) {
  const [listing, setListing] = useState<DesktopDirectoryListing>();
  const [launcher, setLauncher] = useState<DesktopProjectLauncherDescriptor>();
  const [runs, setRuns] = useState<DesktopManagedProjectRun[]>([]);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState<DesktopFileSearchResponse>();
  const [loadingPath, setLoadingPath] = useState(false);
  const [pendingScript, setPendingScript] = useState<string>();
  const [packageManagerOverride, setPackageManagerOverride] = useState<DesktopPackageManager>();

  const projectRuns = useMemo(
    () => runs.filter((run) => run.projectPath === props.project?.path),
    [props.project?.path, runs]
  );

  useEffect(() => {
    setListing(undefined);
    setLauncher(undefined);
    setSearch(undefined);
    setPackageManagerOverride(undefined);
    if (props.project === undefined) {
      return;
    }

    let disposed = false;
    setLoadingPath(true);
    void Promise.all([
      window.kestrelDesktop.listDirectory(props.project.path),
      window.kestrelDesktop.readProjectLauncher(props.project.path),
      window.kestrelDesktop.listProjectRuns(),
      window.kestrelDesktop.watchProjectFiles(props.project.path),
    ]).then(([nextListing, nextLauncher, nextRuns]) => {
      if (disposed) {
        return;
      }
      setListing(nextListing);
      setLauncher(nextLauncher);
      setRuns(nextRuns);
      props.onError(undefined);
    }).catch((cause) => {
      if (disposed === false) {
        props.onError(errorMessage(cause));
      }
    }).finally(() => {
      if (disposed === false) {
        setLoadingPath(false);
      }
    });

    const unsubscribeRuns = window.kestrelDesktop.onProjectRuns(setRuns);
    return () => {
      disposed = true;
      unsubscribeRuns();
      void window.kestrelDesktop.unwatchProjectFiles(props.project!.path);
    };
  }, [props.project?.path]);

  useEffect(() => {
    if (props.project === undefined) {
      return;
    }
    return window.kestrelDesktop.onProjectFilesChanged((event) => {
      if (event.rootPath !== props.project?.path) {
        return;
      }
      void loadDirectory(listing?.directoryPath).catch((cause) => {
        props.onError(errorMessage(cause));
      });
    });
  }, [listing?.directoryPath, props.project?.path]);

  async function loadDirectory(directoryPath?: string): Promise<void> {
    if (props.project === undefined) {
      return;
    }
    setLoadingPath(true);
    try {
      setListing(
        await window.kestrelDesktop.listDirectory(
          props.project.path,
          directoryPath
        )
      );
      props.onError(undefined);
    } finally {
      setLoadingPath(false);
    }
  }

  async function runSearch(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (props.project === undefined || searchDraft.trim().length === 0) {
      setSearch(undefined);
      return;
    }
    try {
      setSearch(
        await window.kestrelDesktop.searchProjectFiles(
          props.project.path,
          searchDraft
        )
      );
      props.onError(undefined);
    } catch (cause) {
      props.onError(errorMessage(cause));
    }
  }

  async function openFile(filePath: string): Promise<void> {
    if (props.project === undefined) {
      return;
    }
    try {
      await window.kestrelDesktop.openFileEditor({
        filePath,
        projectPath: props.project.path,
        projectLabel: props.project.label,
      });
    } catch (cause) {
      props.onError(errorMessage(cause));
    }
  }

  async function startScript(scriptName: string): Promise<void> {
    if (props.project === undefined) {
      return;
    }
    setPendingScript(scriptName);
    try {
      await window.kestrelDesktop.startProjectRun({
        projectPath: props.project.path,
        scriptName,
        ...(packageManagerOverride !== undefined
          ? { packageManagerOverride }
          : {}),
      });
      props.onError(undefined);
    } catch (cause) {
      props.onError(errorMessage(cause));
    } finally {
      setPendingScript(undefined);
    }
  }

  if (props.project === undefined) {
    return (
      <main className="surface-pane empty-surface" id="app-main">
        <Folder size={24} aria-hidden="true" />
        <h1>No project selected</h1>
      </main>
    );
  }

  const canNavigateUp = listing !== undefined
    && samePath(listing.directoryPath, listing.rootPath) === false;
  const parentPath = listing === undefined
    ? undefined
    : parentDirectory(listing.rootPath, listing.directoryPath);

  return (
    <main className="surface-pane project-surface" id="app-main">
      <header className="surface-header">
        <div>
          <span className="surface-kicker">Project</span>
          <h1>{props.project.label}</h1>
          <p>{props.project.path}</p>
        </div>
        <div className="surface-header-actions">
          <button
            className="icon-button"
            type="button"
            title={`Chat in ${props.project.label}`}
            aria-label={`Chat in ${props.project.label}`}
            onClick={() => props.onChat(props.project!)}
          >
            <MessageSquare size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            title="Refresh project"
            aria-label="Refresh project"
            onClick={() => {
              void loadDirectory(listing?.directoryPath).catch((cause) => {
                props.onError(errorMessage(cause));
              });
            }}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </header>

      <div className="project-grid">
        <section className="workspace-panel file-panel" aria-label="Project files">
          <div className="panel-toolbar">
            <button
              className="icon-button"
              type="button"
              title="Parent directory"
              aria-label="Parent directory"
              disabled={canNavigateUp === false}
              onClick={() => {
                void loadDirectory(parentPath).catch((cause) => {
                  props.onError(errorMessage(cause));
                });
              }}
            >
              <ArrowUp size={16} />
            </button>
            <span title={listing?.directoryPath}>
              {listing === undefined
                ? "Files"
                : displayRelativePath(listing.rootPath, listing.directoryPath)}
            </span>
            {loadingPath ? <span className="toolbar-status">Loading</span> : null}
          </div>

          <form className="project-search" onSubmit={(event) => void runSearch(event)}>
            <Search size={15} aria-hidden="true" />
            <input
              aria-label="Search project files"
              placeholder="Search files"
              value={searchDraft}
              onChange={(event) => {
                setSearchDraft(event.target.value);
                if (event.target.value.length === 0) {
                  setSearch(undefined);
                }
              }}
            />
            <button type="submit">Search</button>
          </form>

          <div className="file-list">
            {(search?.results ?? listing?.entries ?? []).map((entry) => {
              const isDirectory = "kind" in entry && entry.kind === "directory";
              return (
                <button
                  className="file-row"
                  type="button"
                  key={entry.path}
                  onClick={() => {
                    if (isDirectory) {
                      void loadDirectory(entry.path).catch((cause) => {
                        props.onError(errorMessage(cause));
                      });
                    } else {
                      void openFile(entry.path);
                    }
                  }}
                >
                  {isDirectory ? <Folder size={15} /> : <File size={15} />}
                  <span>{entry.name}</span>
                  {"sizeBytes" in entry && typeof entry.sizeBytes === "number"
                    ? <small>{formatBytes(entry.sizeBytes)}</small>
                    : null}
                </button>
              );
            })}
            {search !== undefined && search.results.length === 0 ? (
              <p className="panel-empty">No matching files</p>
            ) : null}
            {search === undefined && listing?.entries.length === 0 ? (
              <p className="panel-empty">Directory is empty</p>
            ) : null}
          </div>
        </section>

        <div className="project-side-stack">
          <section className="workspace-panel" aria-label="Project scripts">
            <div className="panel-toolbar">
              <span>Scripts</span>
              <span className="toolbar-status">
                {launcher?.packageManager ?? ""}
              </span>
            </div>
            <div className="command-list">
              {launcher?.packageManagerSelectionRequired === true ? (
                <div className="package-manager-choice">
                  <span>Package manager</span>
                  <div>
                    {(["pnpm", "npm"] as const).map((packageManager) => (
                      <button
                        type="button"
                        key={packageManager}
                        onClick={() => {
                          setPackageManagerOverride(packageManager);
                          void window.kestrelDesktop
                            .readProjectLauncher(props.project!.path, packageManager)
                            .then(setLauncher)
                            .catch((cause) => props.onError(errorMessage(cause)));
                        }}
                      >
                        {packageManager}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {launcher?.unsupportedPackageManager !== undefined ? (
                <p className="inline-warning">
                  Unsupported package manager: {launcher.unsupportedPackageManager}
                </p>
              ) : null}
              {launcher?.scripts.map((script) => (
                <div className="command-row" key={script.name}>
                  <div>
                    <strong>{script.name}</strong>
                    <span>{script.command}</span>
                  </div>
                  <button
                    className="icon-button"
                    type="button"
                    title={`Run ${script.name}`}
                    aria-label={`Run ${script.name}`}
                    disabled={pendingScript !== undefined}
                    onClick={() => void startScript(script.name)}
                  >
                    <Play size={15} />
                  </button>
                </div>
              ))}
              {launcher === undefined || launcher.scripts.length === 0 ? (
                <p className="panel-empty">No runnable scripts</p>
              ) : null}
            </div>
          </section>

          <section className="workspace-panel run-panel" aria-label="Managed project runs">
            <div className="panel-toolbar">
              <span>Runs</span>
              <span className="toolbar-status">{projectRuns.length}</span>
            </div>
            <div className="run-list">
              {projectRuns.map((run) => (
                <article className="run-row" key={run.runId}>
                  <div className="run-row-heading">
                    <strong>{run.scriptName}</strong>
                    <span className={`run-status run-${run.status}`}>{run.status}</span>
                  </div>
                  <code>{run.command}</code>
                  <div className="run-actions">
                    {run.primaryPreviewUrl !== undefined ? (
                      <button
                        className="icon-button"
                        type="button"
                        title="Open preview"
                        aria-label="Open preview"
                        onClick={() => void window.kestrelDesktop.openProjectRunPreview({
                          runId: run.runId,
                          url: run.primaryPreviewUrl,
                        }).catch((cause) => props.onError(errorMessage(cause)))}
                      >
                        <ExternalLink size={15} />
                      </button>
                    ) : null}
                    {run.status === "running" || run.status === "stopping" ? (
                      <button
                        className="icon-button"
                        type="button"
                        title="Stop run"
                        aria-label="Stop run"
                        disabled={run.status === "stopping"}
                        onClick={() => void window.kestrelDesktop.stopProjectRun(run.runId)
                          .catch((cause) => props.onError(errorMessage(cause)))}
                      >
                        <Square size={14} />
                      </button>
                    ) : (
                      <button
                        className="icon-button"
                        type="button"
                        title="Restart run"
                        aria-label="Restart run"
                        onClick={() => void window.kestrelDesktop.restartProjectRun(run.runId)
                          .catch((cause) => props.onError(errorMessage(cause)))}
                      >
                        <RefreshCw size={14} />
                      </button>
                    )}
                  </div>
                  {run.stderrTail.length > 0 ? (
                    <pre>{run.stderrTail.slice(-3).join("\n")}</pre>
                  ) : run.stdoutTail.length > 0 ? (
                    <pre>{run.stdoutTail.slice(-3).join("\n")}</pre>
                  ) : null}
                </article>
              ))}
              {projectRuns.length === 0 ? (
                <p className="panel-empty">No project runs</p>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function samePath(left: string, right: string) {
  return left.replaceAll("\\", "/") === right.replaceAll("\\", "/");
}

function parentDirectory(rootPath: string, directoryPath: string) {
  if (samePath(rootPath, directoryPath)) {
    return rootPath;
  }
  const separatorIndex = Math.max(
    directoryPath.lastIndexOf("/"),
    directoryPath.lastIndexOf("\\")
  );
  if (separatorIndex < rootPath.length) {
    return rootPath;
  }
  return directoryPath.slice(0, separatorIndex);
}

function displayRelativePath(rootPath: string, targetPath: string) {
  const normalizedRoot = rootPath.replaceAll("\\", "/").replace(/\/$/, "");
  const normalizedTarget = targetPath.replaceAll("\\", "/");
  if (normalizedTarget === normalizedRoot) {
    return ".";
  }
  return normalizedTarget.startsWith(`${normalizedRoot}/`)
    ? normalizedTarget.slice(normalizedRoot.length + 1)
    : normalizedTarget;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : String(value);
}
