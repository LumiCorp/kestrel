import {
  ArrowUp,
  ExternalLink,
  File,
  Folder,
  MessageSquare,
  Paperclip,
  Play,
  RefreshCw,
  Search,
  Square,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import type {
  DesktopDirectoryListing,
  DesktopFileContentSearchResult,
  DesktopFileContentSearchResponse,
  DesktopFileEntry,
  DesktopFileSearchResult,
  DesktopFileSearchResponse,
  DesktopManagedProjectRun,
  DesktopManagedWorktreeCleanupResult,
  DesktopManagedWorktreeInspectionResult,
  DesktopPackageManager,
  DesktopProjectLauncherDescriptor,
  DesktopProjectRegistration,
  DesktopThreadWorkspaceContext,
  DesktopWorkspaceLifecycleState,
  DesktopWorkspaceCheckpointDiffResult,
  DesktopWorkspaceCheckpointInspectResult,
  DesktopWorkspacePromotionPreviewResult,
  DesktopWorkspaceValidationSnapshot,
  WorkspaceSkillInstallation,
} from "../../src/contracts";

export function ProjectWorkspace(props: {
  project: DesktopProjectRegistration | undefined;
  threadId?: string | undefined;
  workspace?: DesktopThreadWorkspaceContext | undefined;
  openFiles: string[];
  onChat: (project: DesktopProjectRegistration) => void;
  onAttachFile: (
    filePath: string,
    rootPath: string,
    threadId: string | undefined,
    intent: "attach" | "ask",
  ) => void;
  onOpenFile: (filePath: string) => void;
  onError: (message: string | undefined) => void;
}) {
  const [listing, setListing] = useState<DesktopDirectoryListing>();
  const [launcher, setLauncher] = useState<DesktopProjectLauncherDescriptor>();
  const [runs, setRuns] = useState<DesktopManagedProjectRun[]>([]);
  const [searchDraft, setSearchDraft] = useState("");
  const [searchMode, setSearchMode] = useState<"files" | "content">("files");
  const [search, setSearch] = useState<DesktopFileSearchResponse>();
  const [contentSearch, setContentSearch] = useState<DesktopFileContentSearchResponse>();
  const [loadingPath, setLoadingPath] = useState(false);
  const [pendingScript, setPendingScript] = useState<string>();
  const [packageManagerOverride, setPackageManagerOverride] = useState<DesktopPackageManager>();
  const [lifecycle, setLifecycle] = useState<DesktopWorkspaceLifecycleState>();
  const [checkpointLabel, setCheckpointLabel] = useState("");
  const [promotionPreview, setPromotionPreview] = useState<DesktopWorkspacePromotionPreviewResult>();
  const [promotionValidation, setPromotionValidation] = useState<DesktopWorkspaceValidationSnapshot>();
  const [checkpointDetail, setCheckpointDetail] = useState<DesktopWorkspaceCheckpointInspectResult>();
  const [checkpointDiff, setCheckpointDiff] = useState<DesktopWorkspaceCheckpointDiffResult>();
  const [comparisonSourceId, setComparisonSourceId] = useState<string>();
  const [comparisonGitRef, setComparisonGitRef] = useState("HEAD");
  const [managedInspection, setManagedInspection] = useState<DesktopManagedWorktreeInspectionResult>();
  const [managedCleanup, setManagedCleanup] = useState<DesktopManagedWorktreeCleanupResult>();
  const [pendingLifecycleAction, setPendingLifecycleAction] = useState<string>();
  const [skills, setSkills] = useState<WorkspaceSkillInstallation[]>([]);
  const [skillGitUrl, setSkillGitUrl] = useState("");
  const [skillBranch, setSkillBranch] = useState("main");
  const [skillPath, setSkillPath] = useState("");
  const [editingSkillId, setEditingSkillId] = useState<string>();
  const [pendingSkillAction, setPendingSkillAction] = useState<string>();
  const workspaceRoot = props.workspace?.workspaceRoot ?? props.project?.path;
  const workspaceThreadId = props.workspace === undefined ? undefined : props.threadId;

  const projectRuns = useMemo(
    () => runs.filter((run) => run.projectPath === workspaceRoot),
    [runs, workspaceRoot]
  );

  useEffect(() => {
    setListing(undefined);
    setLauncher(undefined);
    setSearch(undefined);
    setContentSearch(undefined);
    setPackageManagerOverride(undefined);
    setLifecycle(undefined);
    setPromotionPreview(undefined);
    setCheckpointDetail(undefined);
    setCheckpointDiff(undefined);
    setComparisonSourceId(undefined);
    setManagedInspection(undefined);
    setManagedCleanup(undefined);
    setSkills([]);
    setEditingSkillId(undefined);
    if (props.project === undefined || workspaceRoot === undefined) {
      return;
    }

    let disposed = false;
    setLoadingPath(true);
    const lifecyclePromise: Promise<DesktopWorkspaceLifecycleState | undefined> = workspaceThreadId !== undefined
      ? window.kestrelDesktop.getWorkspaceLifecycle(workspaceThreadId)
      : Promise.resolve(undefined);
    const managedInspectionPromise: Promise<DesktopManagedWorktreeInspectionResult | undefined> =
      workspaceThreadId !== undefined && props.workspace?.kind === "managed"
        ? window.kestrelDesktop.inspectManagedWorktree({
            sessionId: workspaceThreadId,
            threadId: workspaceThreadId,
          })
        : Promise.resolve(undefined);
    void Promise.all([
      window.kestrelDesktop.listDirectory(workspaceRoot, undefined, workspaceThreadId),
      window.kestrelDesktop.readProjectLauncher(workspaceRoot, undefined, workspaceThreadId),
      window.kestrelDesktop.listProjectRuns(),
      window.kestrelDesktop.watchProjectFiles(workspaceRoot, workspaceThreadId),
      lifecyclePromise,
      managedInspectionPromise,
      window.kestrelDesktop.syncWorkspaceSkills(props.project.path),
    ]).then(([nextListing, nextLauncher, nextRuns, _watchResult, nextLifecycle, nextManagedInspection, nextSkills]) => {
      if (disposed) {
        return;
      }
      setListing(nextListing);
      setSkills(nextSkills);
      setLauncher(nextLauncher);
      setRuns(nextRuns);
      setLifecycle(nextLifecycle);
      setManagedInspection(nextManagedInspection);
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
      void window.kestrelDesktop.unwatchProjectFiles(workspaceRoot);
    };
  }, [props.project?.path, workspaceRoot, workspaceThreadId]);

  useEffect(() => {
    if (props.project === undefined || workspaceRoot === undefined) {
      return;
    }
    return window.kestrelDesktop.onProjectFilesChanged((event) => {
      if (event.rootPath !== workspaceRoot) {
        return;
      }
      void loadDirectory(listing?.directoryPath).catch((cause) => {
        props.onError(errorMessage(cause));
      });
    });
  }, [listing?.directoryPath, props.project?.path, workspaceRoot]);

  async function loadDirectory(directoryPath?: string): Promise<void> {
    if (props.project === undefined || workspaceRoot === undefined) {
      return;
    }
    setLoadingPath(true);
    try {
      setListing(
        await window.kestrelDesktop.listDirectory(
          workspaceRoot,
          directoryPath,
          workspaceThreadId,
        )
      );
      props.onError(undefined);
    } finally {
      setLoadingPath(false);
    }
  }

  async function runSearch(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (props.project === undefined || workspaceRoot === undefined || searchDraft.trim().length === 0) {
      setSearch(undefined);
      setContentSearch(undefined);
      return;
    }
    try {
      if (searchMode === "content") {
        setContentSearch(await window.kestrelDesktop.searchProjectContent(
          workspaceRoot,
          searchDraft,
          workspaceThreadId,
        ));
        setSearch(undefined);
      } else {
        setSearch(await window.kestrelDesktop.searchProjectFiles(
          workspaceRoot,
          searchDraft,
          workspaceThreadId,
        ));
        setContentSearch(undefined);
      }
      props.onError(undefined);
    } catch (cause) {
      props.onError(errorMessage(cause));
    }
  }

  async function openFile(filePath: string, lineNumber?: number, columnNumber?: number): Promise<void> {
    if (props.project === undefined || workspaceRoot === undefined) {
      return;
    }
    try {
      props.onOpenFile(filePath);
      await window.kestrelDesktop.openFileEditor({
        filePath,
        projectPath: workspaceRoot,
        projectLabel: props.project.label,
        ...(workspaceThreadId !== undefined ? { threadId: workspaceThreadId } : {}),
        ...(lineNumber !== undefined ? { lineNumber } : {}),
        ...(columnNumber !== undefined ? { columnNumber } : {}),
      });
    } catch (cause) {
      props.onError(errorMessage(cause));
    }
  }

  async function startScript(scriptName: string): Promise<void> {
    if (props.project === undefined || workspaceRoot === undefined) {
      return;
    }
    setPendingScript(scriptName);
    try {
      await window.kestrelDesktop.startProjectRun({
        projectPath: workspaceRoot,
        scriptName,
        ...(packageManagerOverride !== undefined
          ? { packageManagerOverride }
          : {}),
        ...(workspaceThreadId !== undefined ? { threadId: workspaceThreadId } : {}),
      });
      props.onError(undefined);
    } catch (cause) {
      props.onError(errorMessage(cause));
    } finally {
      setPendingScript(undefined);
    }
  }

  async function refreshLifecycle(): Promise<void> {
    if (workspaceThreadId === undefined) {
      return;
    }
    setLifecycle(await window.kestrelDesktop.getWorkspaceLifecycle(workspaceThreadId));
  }

  async function refreshManagedInspection(): Promise<void> {
    if (workspaceThreadId === undefined || props.workspace?.kind !== "managed") {
      return;
    }
    setManagedInspection(await window.kestrelDesktop.inspectManagedWorktree({
      sessionId: workspaceThreadId,
      threadId: workspaceThreadId,
    }));
  }

  async function cleanupManagedWorktree(): Promise<void> {
    if (
      workspaceThreadId === undefined ||
      managedInspection === undefined ||
      !window.confirm("Create a recovery snapshot, remove this managed worktree, and return the thread to its source checkout?")
    ) {
      return;
    }
    setPendingLifecycleAction("managed-cleanup");
    try {
      const result = await window.kestrelDesktop.cleanupManagedWorktree({
        sessionId: workspaceThreadId,
        threadId: workspaceThreadId,
        reason: "Desktop operator requested managed worktree cleanup",
      });
      setManagedCleanup(result);
      setManagedInspection(undefined);
      props.onError(undefined);
    } catch (cause) {
      props.onError(errorMessage(cause));
      await refreshManagedInspection().catch(() => {});
    } finally {
      setPendingLifecycleAction(undefined);
    }
  }

  async function captureCheckpoint(event: FormEvent): Promise<void> {
    event.preventDefault();
    const label = checkpointLabel.trim();
    if (workspaceThreadId === undefined || label.length === 0) {
      return;
    }
    setPendingLifecycleAction("capture");
    try {
      await window.kestrelDesktop.captureWorkspaceCheckpoint({
        sessionId: workspaceThreadId,
        label,
        threadId: workspaceThreadId,
      });
      setCheckpointLabel("");
      await refreshLifecycle();
      props.onError(undefined);
    } catch (cause) {
      props.onError(errorMessage(cause));
    } finally {
      setPendingLifecycleAction(undefined);
    }
  }

  async function previewPromotion(promotionId: string): Promise<void> {
    if (workspaceThreadId === undefined) {
      return;
    }
    setPendingLifecycleAction(`preview:${promotionId}`);
    try {
      const [preview, validation] = await Promise.all([window.kestrelDesktop.previewWorkspacePromotion({ sessionId: workspaceThreadId, promotionId }), window.kestrelDesktop.inspectWorkspaceValidation({ sessionId: workspaceThreadId, threadId: workspaceThreadId })]);
      setPromotionPreview(preview); setPromotionValidation(validation);
      props.onError(undefined);
    } catch (cause) {
      props.onError(errorMessage(cause));
    } finally {
      setPendingLifecycleAction(undefined);
    }
  }

  async function restoreCheckpoint(checkpointId: string, label: string): Promise<void> {
    if (workspaceThreadId === undefined || !window.confirm(`Restore workspace checkpoint “${label}”? Current work will first be captured as a recovery checkpoint.`)) {
      return;
    }
    setPendingLifecycleAction(`restore:${checkpointId}`);
    try {
      await window.kestrelDesktop.restoreWorkspaceCheckpoint({
        sessionId: workspaceThreadId,
        checkpointId,
        reason: `Desktop operator restored ${label}`,
        threadId: workspaceThreadId,
      });
      await refreshLifecycle();
      props.onError(undefined);
    } catch (cause) {
      props.onError(errorMessage(cause));
    } finally {
      setPendingLifecycleAction(undefined);
    }
  }

  async function restoreCleanedManagedWorktree(checkpointId: string, label: string): Promise<void> {
    if (workspaceThreadId === undefined || !window.confirm(`Recreate this managed worktree from “${label}”?`)) {
      return;
    }
    setPendingLifecycleAction(`managed-restore:${checkpointId}`);
    try {
      await window.kestrelDesktop.restoreManagedWorktree({
        sessionId: workspaceThreadId,
        threadId: workspaceThreadId,
        checkpointId,
        reason: `Desktop operator restored cleaned managed worktree from ${label}`,
      });
      await refreshLifecycle();
      props.onError(undefined);
    } catch (cause) {
      props.onError(errorMessage(cause));
    } finally {
      setPendingLifecycleAction(undefined);
    }
  }

  async function inspectCheckpoint(checkpointId: string): Promise<void> {
    if (workspaceThreadId === undefined) {
      return;
    }
    setPendingLifecycleAction(`inspect:${checkpointId}`);
    try {
      setCheckpointDetail(await window.kestrelDesktop.inspectWorkspaceCheckpoint({
        sessionId: workspaceThreadId,
        checkpointId,
      }));
      props.onError(undefined);
    } catch (cause) {
      props.onError(errorMessage(cause));
    } finally {
      setPendingLifecycleAction(undefined);
    }
  }

  async function compareCheckpoint(sourceCheckpointId: string, targetCheckpointId?: string, targetGitRef?: string): Promise<void> {
    if (workspaceThreadId === undefined) {
      return;
    }
    setPendingLifecycleAction(`compare:${sourceCheckpointId}`);
    try {
      setCheckpointDiff(await window.kestrelDesktop.compareWorkspaceCheckpoint({
        sessionId: workspaceThreadId,
        sourceCheckpointId,
        ...(targetCheckpointId ? { targetCheckpointId } : {}),
        ...(targetGitRef ? { targetGitRef } : {}),
      }));
      props.onError(undefined);
    } catch (cause) {
      props.onError(errorMessage(cause));
    } finally {
      setPendingLifecycleAction(undefined);
    }
  }

  async function cleanupCheckpoints(): Promise<void> {
    if (workspaceThreadId === undefined || !window.confirm("Apply the configured checkpoint retention policy? Protected and recent recovery checkpoints will be retained.")) return;
    setPendingLifecycleAction("checkpoint-cleanup");
    try { await window.kestrelDesktop.cleanupWorkspaceCheckpoints({ sessionId: workspaceThreadId, reason: "Desktop operator requested retention cleanup" }); await refreshLifecycle(); props.onError(undefined); setCheckpointDiff(undefined); setCheckpointDetail(undefined); }
    catch (cause) { props.onError(errorMessage(cause)); }
    finally { setPendingLifecycleAction(undefined); }
  }

  async function applyPromotion(): Promise<void> {
    const preview = promotionPreview?.preview;
    const fingerprint = preview?.candidateFingerprint;
    if (workspaceThreadId === undefined || preview === undefined || fingerprint === undefined) {
      return;
    }
    if (!window.confirm(`Promote ${preview.changedFiles.length} changed file(s) into the source checkout?`)) {
      return;
    }
    setPendingLifecycleAction("apply");
    try {
      await window.kestrelDesktop.applyWorkspacePromotion({
        sessionId: workspaceThreadId,
        promotionId: preview.promotion.promotionId,
        candidateFingerprint: fingerprint,
      });
      setPromotionPreview(undefined);
      await refreshLifecycle();
      props.onError(undefined);
    } catch (cause) {
      props.onError(errorMessage(cause));
      await refreshLifecycle().catch(() => {});
    } finally {
      setPendingLifecycleAction(undefined);
    }
  }

  async function undoLatestPromotion(): Promise<void> {
    if (workspaceThreadId === undefined || !window.confirm("Restore the source checkout to its checkpoint from before the latest promotion?")) {
      return;
    }
    setPendingLifecycleAction("undo");
    try {
      await window.kestrelDesktop.undoLatestWorkspacePromotion({
        sessionId: workspaceThreadId,
        reason: "Desktop operator requested promotion undo",
      });
      await refreshLifecycle();
      props.onError(undefined);
    } catch (cause) {
      props.onError(errorMessage(cause));
    } finally {
      setPendingLifecycleAction(undefined);
    }
  }

  async function installSkill(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (props.project === undefined || skillGitUrl.trim().length === 0 || skillBranch.trim().length === 0) return;
    setPendingSkillAction(editingSkillId === undefined ? "install" : `update:${editingSkillId}`);
    try {
      const source = {
        gitUrl: skillGitUrl.trim(),
        branch: skillBranch.trim(),
        ...(skillPath.trim().length > 0 ? { path: skillPath.trim() } : {}),
      };
      if (editingSkillId === undefined) {
        await window.kestrelDesktop.installWorkspaceSkill(props.project.path, source);
      } else {
        await window.kestrelDesktop.updateWorkspaceSkill(props.project.path, editingSkillId, source);
      }
      setSkills(await window.kestrelDesktop.listWorkspaceSkills(props.project.path));
      setSkillGitUrl("");
      setSkillPath("");
      setSkillBranch("main");
      setEditingSkillId(undefined);
      props.onError(undefined);
    } catch (cause) {
      props.onError(errorMessage(cause));
    } finally {
      setPendingSkillAction(undefined);
    }
  }

  async function syncSkills(): Promise<void> {
    if (props.project === undefined) return;
    setPendingSkillAction("sync");
    try {
      setSkills(await window.kestrelDesktop.syncWorkspaceSkills(props.project.path));
      props.onError(undefined);
    } catch (cause) {
      props.onError(errorMessage(cause));
    } finally {
      setPendingSkillAction(undefined);
    }
  }

  async function removeSkill(installationId: string): Promise<void> {
    if (props.project === undefined) return;
    setPendingSkillAction(installationId);
    try {
      setSkills(await window.kestrelDesktop.removeWorkspaceSkill(props.project.path, installationId));
      props.onError(undefined);
    } catch (cause) {
      props.onError(errorMessage(cause));
    } finally {
      setPendingSkillAction(undefined);
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
  const renderedWorkspaceRoot = workspaceRoot ?? props.project.path;

  const canNavigateUp = listing !== undefined
    && samePath(listing.directoryPath, listing.rootPath) === false;
  const parentPath = listing === undefined
    ? undefined
    : parentDirectory(listing.rootPath, listing.directoryPath);

  return (
    <main className="surface-pane project-surface" id="app-main">
      <header className="surface-header">
        <div>
          <span className="surface-kicker">
            {props.workspace?.kind === "managed" ? "Managed worktree" : "Project"}
          </span>
          <h1>{props.project.label}</h1>
          <p>{renderedWorkspaceRoot}</p>
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
                  setContentSearch(undefined);
                }
              }}
            />
            <select
              aria-label="Search mode"
              value={searchMode}
              onChange={(event) => {
                setSearchMode(event.target.value === "content" ? "content" : "files");
                setSearch(undefined);
                setContentSearch(undefined);
              }}
            >
              <option value="files">Paths</option>
              <option value="content">Content</option>
            </select>
            <button type="submit">Search</button>
          </form>

          <div className="file-list">
            {search === undefined && contentSearch === undefined && props.openFiles.some((filePath) => pathWithinRoot(renderedWorkspaceRoot, filePath)) ? (
              <div className="open-file-list" aria-label="Recently opened files">
                <small>Open files</small>
                {props.openFiles
                  .filter((filePath) => pathWithinRoot(renderedWorkspaceRoot, filePath))
                  .slice(-5)
                  .reverse()
                  .map((filePath) => (
                    <button type="button" key={filePath} onClick={() => void openFile(filePath)}>
                      {displayRelativePath(renderedWorkspaceRoot, filePath)}
                    </button>
                  ))}
              </div>
            ) : null}
            {(contentSearch?.results ?? search?.results ?? listing?.entries ?? []).map((entry) => {
              const isDirectory = "kind" in entry && entry.kind === "directory";
              const contentMatch = isContentSearchResult(entry) ? entry : undefined;
              return (
                <div className="file-row-shell" key={entry.path}>
                  <button
                    className="file-row"
                    type="button"
                    onClick={() => {
                      if (isDirectory) {
                        void loadDirectory(entry.path).catch((cause) => {
                          props.onError(errorMessage(cause));
                        });
                      } else {
                        void openFile(entry.path, contentMatch?.lineNumber, contentMatch?.columnNumber);
                      }
                    }}
                  >
                    {isDirectory ? <Folder size={15} /> : <File size={15} />}
                    <span>
                      {entry.name}{contentMatch !== undefined ? `:${contentMatch.lineNumber}:${contentMatch.columnNumber}` : ""}
                      {contentMatch !== undefined ? <small>{contentMatch.preview}</small> : null}
                    </span>
                    {"sizeBytes" in entry && typeof entry.sizeBytes === "number"
                      ? <small>{formatBytes(entry.sizeBytes)}</small>
                      : null}
                  </button>
                  {isDirectory === false ? (
                    <div className="file-row-actions">
                      <button
                        type="button"
                        title={`Attach ${entry.name}`}
                        aria-label={`Attach ${entry.name}`}
                        onClick={() => props.onAttachFile(entry.path, renderedWorkspaceRoot, workspaceThreadId, "attach")}
                      >
                        <Paperclip size={13} />
                      </button>
                      <button
                        type="button"
                        title={`Ask Kestrel about ${entry.name}`}
                        aria-label={`Ask Kestrel about ${entry.name}`}
                        onClick={() => props.onAttachFile(entry.path, renderedWorkspaceRoot, workspaceThreadId, "ask")}
                      >
                        <MessageSquare size={13} />
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
            {search !== undefined && search.results.length === 0 ? (
              <p className="panel-empty">No matching files</p>
            ) : null}
            {contentSearch !== undefined && contentSearch.results.length === 0 ? (
              <p className="panel-empty">No matching content</p>
            ) : null}
            {contentSearch?.truncated === true ? (
              <p className="inline-warning">Content search reached its bounded result or scan limit.</p>
            ) : null}
            {search === undefined && contentSearch === undefined && listing?.entries.length === 0 ? (
              <p className="panel-empty">Directory is empty</p>
            ) : null}
          </div>
        </section>

        <div className="project-side-stack">
          <section className="workspace-panel" aria-label="Workspace skills">
            <div className="panel-toolbar">
              <span>Agent skills</span>
              <button
                className="icon-button"
                type="button"
                title="Sync workspace skills"
                aria-label="Sync workspace skills"
                disabled={pendingSkillAction !== undefined}
                onClick={() => void syncSkills()}
              >
                <RefreshCw size={14} />
              </button>
            </div>
            <form className="project-search" onSubmit={(event) => void installSkill(event)}>
              <input
                aria-label="Skill Git URL"
                placeholder="https://github.com/org/skills.git"
                value={skillGitUrl}
                onChange={(event) => setSkillGitUrl(event.target.value)}
              />
              <input
                aria-label="Skill branch"
                placeholder="main"
                value={skillBranch}
                onChange={(event) => setSkillBranch(event.target.value)}
              />
              <input
                aria-label="Skill subdirectory"
                placeholder="Optional path"
                value={skillPath}
                onChange={(event) => setSkillPath(event.target.value)}
              />
              <button type="submit" disabled={pendingSkillAction !== undefined || skillGitUrl.trim().length === 0}>
                {editingSkillId === undefined ? "Install" : "Update"}
              </button>
              {editingSkillId !== undefined ? (
                <button type="button" onClick={() => {
                  setEditingSkillId(undefined);
                  setSkillGitUrl("");
                  setSkillBranch("main");
                  setSkillPath("");
                }}>Cancel</button>
              ) : null}
            </form>
            <p className="panel-caption">Public HTTPS Git only. Skills provide guidance and never grant tool permissions or run install hooks.</p>
            <div className="command-list">
              {skills.map((skill) => (
                <div className="command-row" key={skill.installationId}>
                  <div>
                    <strong>{skill.revision?.name ?? "Pending skill"}</strong>
                    <span>{skill.revision?.description ?? skill.source.gitUrl}</span>
                    <small>
                      {skill.status}
                      {skill.revision?.commitSha ? ` · ${skill.revision.commitSha.slice(0, 12)}` : ""}
                    </small>
                    {skill.lastSyncError ? <small className="inline-warning">{skill.lastSyncError}</small> : null}
                    <details>
                      <summary>Inspect</summary>
                      <small>Source: {skill.source.gitUrl} · {skill.source.branch}{skill.source.path ? ` · ${skill.source.path}` : ""}</small>
                      {skill.revision ? <small>Commit: {skill.revision.commitSha}</small> : null}
                      {skill.revision ? <small>Digest: {skill.revision.contentDigest}</small> : null}
                      {skill.revision ? <small>Instructions: {skill.revision.skillFile}</small> : null}
                    </details>
                  </div>
                  <div>
                    <button type="button" disabled={pendingSkillAction !== undefined} onClick={() => {
                      setEditingSkillId(skill.installationId);
                      setSkillGitUrl(skill.source.gitUrl);
                      setSkillBranch(skill.source.branch);
                      setSkillPath(skill.source.path ?? "");
                    }}>Edit</button>
                    <button
                      type="button"
                      disabled={pendingSkillAction !== undefined}
                      onClick={() => void removeSkill(skill.installationId)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
              {skills.length === 0 ? <p className="panel-empty">No workspace skills installed</p> : null}
            </div>
          </section>

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
                            .readProjectLauncher(renderedWorkspaceRoot, packageManager, workspaceThreadId)
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

          {workspaceThreadId !== undefined ? (
            <section className="workspace-panel" aria-label="Workspace checkpoints and promotion">
              <div className="panel-toolbar">
                <span>Recovery &amp; promotion</span>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="Refresh workspace lifecycle"
                  title="Refresh workspace lifecycle"
                  onClick={() => void refreshLifecycle().catch((cause) => props.onError(errorMessage(cause)))}
                >
                  <RefreshCw size={14} />
                </button>
              </div>
              <form className="project-search" onSubmit={(event) => void captureCheckpoint(event)}>
                <input
                  aria-label="Checkpoint label"
                  placeholder="Checkpoint label"
                  value={checkpointLabel}
                  onChange={(event) => setCheckpointLabel(event.target.value)}
                />
                <button type="submit" disabled={pendingLifecycleAction !== undefined || checkpointLabel.trim().length === 0}>
                  Capture
                </button>
              </form>
              <div className="run-list">
                {managedInspection !== undefined ? (
                  <article className="run-row">
                    <div className="run-row-heading">
                      <strong>Managed worktree</strong>
                      <span className="run-status">{managedInspection.inspection.status}</span>
                    </div>
                    <code>{managedInspection.inspection.binding.worktreeRoot}</code>
                    <small>
                      scope {managedInspection.inspection.binding.scope.kind}:{managedInspection.inspection.binding.scope.value}
                    </small>
                    <small>
                      base {managedInspection.inspection.binding.baseRefName ?? "HEAD"} ({shortSha(managedInspection.inspection.binding.baseHead)}) · head {shortSha(managedInspection.inspection.headSha)} · {managedInspection.inspection.aheadCommitCount} commits ahead
                    </small>
                    <small>
                      {managedInspection.inspection.dirtyState.dirty ? "Dirty" : "Clean"} · {formatBytes(managedInspection.inspection.storageBytes)} · {managedInspection.inspection.activeProcesses.length} active processes
                    </small>
                    <small>
                      Setup {managedInspection.inspection.setup.status} · attempt {managedInspection.inspection.setup.attempts}
                      {managedInspection.inspection.setup.activeStepId ? ` · ${managedInspection.inspection.setup.activeStepId}` : ""}
                    </small>
                    <small>
                      Retention {managedInspection.inspection.retention.disposition.replaceAll("_", " ")} · {
                        managedInspection.inspection.retention.reasons
                          .map((reason) => reason.replaceAll("_", " "))
                          .join(", ")
                      }
                    </small>
                    {managedInspection.inspection.setup.failureMessage ? (
                      <p className="inline-warning">{managedInspection.inspection.setup.failureMessage}</p>
                    ) : null}
                    {managedInspection.inspection.storageScanTruncated ? (
                      <small>Storage estimate is partial because the bounded scan reached its entry limit.</small>
                    ) : null}
                    {managedInspection.inspection.staleBase ? (
                      <p className="inline-warning">Source checkout changed since this worktree was bound.</p>
                    ) : null}
                    {managedInspection.inspection.currentLease ? (
                      <p className="inline-warning">
                        Lease {managedInspection.inspection.currentLease.kind} held by {managedInspection.inspection.currentLease.runId}
                      </p>
                    ) : null}
                    <div className="run-actions">
                      <button type="button" onClick={() => void refreshManagedInspection().catch((cause) => props.onError(errorMessage(cause)))}>
                        Refresh state
                      </button>
                      <button
                        type="button"
                        disabled={
                          pendingLifecycleAction !== undefined ||
                          managedInspection.inspection.status !== "valid" ||
                          managedInspection.inspection.currentLease !== undefined ||
                          managedInspection.inspection.activeProcesses.length > 0
                        }
                        onClick={() => void cleanupManagedWorktree()}
                      >
                        Snapshot &amp; clean up
                      </button>
                    </div>
                  </article>
                ) : null}
                {managedCleanup !== undefined ? (
                  <article className="run-row">
                    <strong>Managed worktree cleaned up</strong>
                    <small>Recovery checkpoint {managedCleanup.cleanup.snapshotCheckpointId}</small>
                    <small>Removed {formatBytes(managedCleanup.cleanup.removedBytes)}</small>
                  </article>
                ) : null}
                {(lifecycle?.checkpoints ?? []).slice(0, 5).map((checkpoint) => (
                  <article className="run-row" key={checkpoint.checkpointId}>
                    <div className="run-row-heading">
                      <strong>{checkpoint.label}</strong>
                      <span className="run-status">{checkpoint.kind}</span>
                    </div>
                    <code>{checkpoint.branch ?? checkpoint.headSha ?? checkpoint.gitRef}</code>
                    <small>{checkpoint.fileCount} files · {formatBytes(checkpoint.totalBytes)}</small>
                    <div className="run-actions">
                      <button type="button" onClick={() => void inspectCheckpoint(checkpoint.checkpointId)}>
                        Inspect
                      </button>
                      {comparisonSourceId === undefined ? (
                        <button type="button" onClick={() => setComparisonSourceId(checkpoint.checkpointId)}>
                          Compare from
                        </button>
                      ) : comparisonSourceId === checkpoint.checkpointId ? (
                        <button type="button" onClick={() => void compareCheckpoint(checkpoint.checkpointId)}>
                          Compare to working tree
                        </button>
                      ) : (
                        <button type="button" onClick={() => void compareCheckpoint(comparisonSourceId, checkpoint.checkpointId)}>
                          Compare to base
                        </button>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={pendingLifecycleAction !== undefined}
                      onClick={() => void restoreCheckpoint(checkpoint.checkpointId, checkpoint.label)}
                    >
                      Restore
                    </button>
                    {checkpoint.workspaceRole === "managed_worktree" && checkpoint.kind === "recovery_anchor" && props.workspace?.kind !== "managed" ? (
                      <button
                        type="button"
                        disabled={pendingLifecycleAction !== undefined}
                        onClick={() => void restoreCleanedManagedWorktree(checkpoint.checkpointId, checkpoint.label)}
                      >
                        Recreate managed worktree
                      </button>
                    ) : null}
                  </article>
                ))}
                {comparisonSourceId !== undefined ? (
                  <div className="run-actions"><input aria-label="Git revision comparison target" value={comparisonGitRef} onChange={(event) => setComparisonGitRef(event.target.value)} /><button disabled={!comparisonGitRef.trim()} type="button" onClick={() => void compareCheckpoint(comparisonSourceId, undefined, comparisonGitRef.trim())}>Compare to Git revision</button><button type="button" onClick={() => setComparisonSourceId(undefined)}>Clear comparison base</button></div>
                ) : null}
                <button type="button" disabled={pendingLifecycleAction !== undefined || (lifecycle?.checkpoints.length ?? 0) === 0} onClick={() => void cleanupCheckpoints()}>Apply checkpoint retention</button>
                {checkpointDetail !== undefined ? (
                  <article className="run-row">
                    <strong>{checkpointDetail.checkpoint.checkpoint.label}</strong>
                    {checkpointDetail.checkpoint.files.slice(0, 20).map((file) => (
                      <code key={file.path}>{file.path} · {formatBytes(file.size)}</code>
                    ))}
                  </article>
                ) : null}
                {checkpointDiff !== undefined ? (
                  <article className="run-row">
                    <strong>{checkpointDiff.diff.source.label} → {checkpointDiff.diff.target.label}</strong>
                    {checkpointDiff.diff.files.map((file) => (
                      <div key={`${file.status}:${file.path}`}>
                        <code>{file.status} {file.path}</code>
                        {file.hunks?.map((hunk, index) => <pre key={`${file.path}:${index}`}>{hunk}</pre>)}
                      </div>
                    ))}
                  </article>
                ) : null}
                {(lifecycle?.promotions ?? []).map((promotion) => (
                  <article className="run-row" key={promotion.promotionId}>
                    <div className="run-row-heading">
                      <strong>Promotion</strong>
                      <span className="run-status">{promotion.status}</span>
                    </div>
                    <span>{promotion.changedFiles.length} changed files</span>
                    {promotion.blockedReason ? <small>{promotion.blockedReason}</small> : null}
                    {promotion.status === "pending_review" || promotion.status === "blocked" ? (
                      <button
                        type="button"
                        disabled={pendingLifecycleAction !== undefined}
                        onClick={() => void previewPromotion(promotion.promotionId)}
                      >
                        Preview candidate
                      </button>
                    ) : null}
                  </article>
                ))}
                {promotionPreview !== undefined ? (
                  <article className="run-row">
                    <div className="run-row-heading">
                      <strong>Candidate preview</strong>
                      <span className="run-status">{promotionPreview.preview.status}</span>
                    </div>
                    {promotionPreview.preview.diff.files.map((file) => (
                      <code key={`${file.status}:${file.path}`}>{file.status} {file.path}</code>
                    ))}
                    {promotionPreview.preview.blockedReason ? (
                      <p className="inline-warning">{promotionPreview.preview.blockedReason}</p>
                    ) : null}
                    {promotionValidation?.readiness.state !== "ready" ? <p className="inline-warning">Fresh passing validation is required before promotion. Current state: {promotionValidation?.readiness.state.replace("_", " ") ?? "not loaded"}.</p> : null}
                    <button
                      type="button"
                      disabled={promotionPreview.preview.status !== "ready" || promotionValidation?.readiness.state !== "ready" || pendingLifecycleAction !== undefined}
                      onClick={() => void applyPromotion()}
                    >
                      Promote to source
                    </button>
                  </article>
                ) : null}
                {(lifecycle?.promotions ?? []).some((promotion) => promotion.status === "promoted" && promotion.undoneAt === undefined) ? (
                  <button
                    type="button"
                    disabled={pendingLifecycleAction !== undefined}
                    onClick={() => void undoLatestPromotion()}
                  >
                    Undo latest promotion
                  </button>
                ) : null}
                {(lifecycle?.checkpoints.length ?? 0) === 0 && (lifecycle?.promotions.length ?? 0) === 0 ? (
                  <p className="panel-empty">No checkpoints or promotions</p>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </main>
  );
}

function isContentSearchResult(
  entry: DesktopFileEntry | DesktopFileSearchResult | DesktopFileContentSearchResult,
): entry is DesktopFileContentSearchResult {
  return "lineNumber" in entry
    && typeof entry.lineNumber === "number"
    && "columnNumber" in entry
    && typeof entry.columnNumber === "number"
    && "preview" in entry
    && typeof entry.preview === "string";
}

function samePath(left: string, right: string) {
  return left.replaceAll("\\", "/") === right.replaceAll("\\", "/");
}

function pathWithinRoot(rootPath: string, targetPath: string): boolean {
  const root = rootPath.replaceAll("\\", "/").replace(/\/$/u, "");
  const target = targetPath.replaceAll("\\", "/");
  return target === root || target.startsWith(`${root}/`);
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

function shortSha(value: string | undefined) {
  return value === undefined ? "unknown" : value.slice(0, 8);
}

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : String(value);
}
