"use client";

import {
  ArrowLeft,
  CircleCheck,
  File,
  Folder,
  LoaderCircle,
  Play,
  Save,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { StandaloneWorkspaceSetup } from "./standalone-workspace-setup";
import {
  type EnvironmentActivation,
  waitForWorkspaceActivation,
} from "./workspace-activation";

type TreeEntry = {
  name: string;
  path: string;
  type: "directory" | "file" | "other";
  size: number;
  updatedAt: string;
};

type WorkspaceApplication = {
  id: string;
  name: string;
  port: number;
  desiredState: "running" | "stopped";
  status: string;
  processId: number | null;
};

type WorkspacePromotion = {
  promotionId: string;
  runId?: string;
  status: string;
  changedFiles: string[];
  candidateFingerprint?: string;
  blockedReason?: string;
  createdAt: string;
};

type WorkspacePromotionPreview = {
  promotion: WorkspacePromotion;
  status: "ready" | "empty" | "blocked";
  changedFiles: string[];
  conflictPaths: string[];
  invalidPaths: string[];
  candidateFingerprint?: string;
  blockedReason?: string;
  diff: {
    files: Array<{
      path: string;
      status: string;
      hunks?: string[];
    }>;
  };
};

type GitHubPublicationRepository = {
  repositoryId: string;
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string | null;
  isEmpty: boolean | null;
  canPush: boolean;
  source: boolean;
  granted: boolean;
};

const GITHUB_PUBLICATION_RECOVERY: Record<string, string> = {
  GITHUB_REPOSITORY_NOT_SYNCED:
    "Refresh GitHub repositories, then select the repository again.",
  GITHUB_REPOSITORY_NOT_GRANTED:
    "Grant this repository in the Project GitHub App settings.",
  GITHUB_REPOSITORY_READ_DENIED:
    "Reconnect GitHub with repository read access or choose another repository.",
  GITHUB_REPOSITORY_PUSH_DENIED:
    "Reconnect GitHub with push access or choose another repository.",
  GITHUB_REPOSITORY_INITIALIZATION_REQUIRED:
    "Review the candidate and publish the empty repository to main.",
  GITHUB_REPOSITORY_NOT_EMPTY:
    "Refresh repositories and publish a Kestrel agent branch instead.",
  GITHUB_PUSH_CANDIDATE_CHANGED:
    "Review the latest candidate before publishing it.",
  GITHUB_CONTENT_NOT_FOUND:
    "Choose an existing path; a missing file does not determine whether a repository can be published.",
};

function githubPublicationFailure(
  error: string | { code?: string; message?: string } | undefined,
) {
  if (typeof error === "string") return error;
  const code = error?.code;
  const recovery = code ? GITHUB_PUBLICATION_RECOVERY[code] : undefined;
  return error?.message ?? (code && recovery ? `${code}: ${recovery}` : code) ??
    "GitHub publication failed.";
}

export function WorkspaceClient({
  standalone,
  threadId,
}: {
  standalone: boolean;
  threadId: string;
}) {
  const [configured, setConfigured] = useState(!standalone);
  const handleConfigured = useCallback(() => setConfigured(true), []);
  if (!configured) {
    return (
      <StandaloneWorkspaceSetup
        onConfigured={handleConfigured}
        threadId={threadId}
      />
    );
  }
  return <ConnectedWorkspaceClient threadId={threadId} />;
}

function ConnectedWorkspaceClient({ threadId }: { threadId: string }) {
  const base = `/api/threads/${threadId}/workspace`;
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [fileRevision, setFileRevision] = useState<string | null>(null);
  const [fileDirty, setFileDirty] = useState(false);
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [command, setCommand] = useState("pwd && git status --short");
  const [terminal, setTerminal] = useState("");
  const [terminalSessionId, setTerminalSessionId] = useState<string | null>(
    null,
  );
  const [terminalCursor, setTerminalCursor] = useState(0);
  const [status, setStatus] = useState("Connecting to the Environment…");
  const [activation, setActivation] = useState<EnvironmentActivation>({
    stage: "environment.activation.requested",
    detail: "Connecting to the Environment…",
    status: "pending",
  });
  const [applications, setApplications] = useState<WorkspaceApplication[]>([]);
  const [appName, setAppName] = useState("Preview");
  const [appCommand, setAppCommand] = useState("pnpm dev");
  const [appPort, setAppPort] = useState("3000");
  const [promotions, setPromotions] = useState<WorkspacePromotion[]>([]);
  const [promotionPreview, setPromotionPreview] =
    useState<WorkspacePromotionPreview | null>(null);
  const [acceptingPromotion, setAcceptingPromotion] = useState(false);
  const [pushingPromotion, setPushingPromotion] = useState(false);
  const [publicationRepositories, setPublicationRepositories] = useState<
    GitHubPublicationRepository[]
  >([]);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState("");
  const [initializationOpen, setInitializationOpen] = useState(false);
  const [reviewQueryHandled, setReviewQueryHandled] = useState(false);
  const [filesOpen, setFilesOpen] = useState(true);
  const [candidatesOpen, setCandidatesOpen] = useState(true);
  const [terminalPanelOpen, setTerminalPanelOpen] = useState(true);
  const [appFormOpen, setAppFormOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<
    "files" | "editor" | "candidates"
  >("editor");

  const loadApplications = useCallback(async () => {
    const response = await fetch(`${base}/apps`, { cache: "no-store" });
    if (!response.ok) return;
    const payload = (await response.json()) as {
      applications?: WorkspaceApplication[];
    };
    setApplications(payload.applications ?? []);
  }, [base]);

  const loadPromotions = useCallback(async () => {
    const response = await fetch(`${base}/promotions`, { cache: "no-store" });
    if (!response.ok) return;
    const payload = (await response.json()) as {
      promotions?: WorkspacePromotion[];
    };
    setPromotions(payload.promotions ?? []);
  }, [base]);

  const loadPublicationRepositories = useCallback(async () => {
    const response = await fetch(`/api/threads/${threadId}/github/publications`, {
      cache: "no-store",
    });
    if (!response.ok) return;
    const payload = (await response.json()) as {
      repositories?: GitHubPublicationRepository[];
    };
    const repositories = payload.repositories ?? [];
    setPublicationRepositories(repositories);
    setSelectedRepositoryId((current) => {
      if (repositories.some((repository) => repository.repositoryId === current)) {
        return current;
      }
      return repositories.length === 1 ? repositories[0]!.repositoryId : "";
    });
  }, [threadId]);

  const loadTree = useCallback(
    async (path: string, showLoading = true) => {
      if (showLoading) setStatus("Loading Workspace…");
      const response = await fetch(
        `${base}/tree?path=${encodeURIComponent(path)}`,
      );
      if (!response.ok) throw new Error("Workspace tree is unavailable.");
      const data = (await response.json()) as { entries: TreeEntry[] };
      setDirectory(path);
      setEntries(data.entries);
      if (showLoading) setStatus("Environment ready");
    },
    [base],
  );

  useEffect(() => {
    let cancelled = false;
    const activationController = new AbortController();
    void (async () => {
      try {
        const startResponse = await fetch(
          `/api/threads/${threadId}/environment`,
          {
            method: "POST",
          },
        );
        const startPayload = (await startResponse.json()) as {
          activation?: EnvironmentActivation;
          error?: string;
        };
        if (!(startResponse.ok && startPayload.activation)) {
          throw new Error(
            startPayload.error ?? "Workspace activation could not start.",
          );
        }
        const ready = await waitForWorkspaceActivation({
          initial: startPayload.activation,
          read: async () => {
            const response = await fetch(
              `/api/threads/${threadId}/environment`,
              { cache: "no-store", signal: activationController.signal },
            );
            const payload = (await response.json()) as {
              activation?: EnvironmentActivation;
              error?: string;
            };
            if (!(response.ok && payload.activation)) {
              throw new Error(
                payload.error ?? "Environment activation is unavailable.",
              );
            }
            return payload.activation;
          },
          onProgress: (current) => {
            if (cancelled) return;
            setActivation(current);
            setStatus(current.detail);
          },
          signal: activationController.signal,
          sleep: (milliseconds) =>
            new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
        });
        if (!(ready && !cancelled)) return;
        await loadTree("", false);
        await Promise.all([
          loadApplications(),
          loadPromotions(),
          loadPublicationRepositories(),
        ]);
        if (!cancelled) setStatus("Environment ready");
      } catch (error) {
        if (!cancelled) {
          const detail =
            error instanceof Error ? error.message : "Workspace unavailable.";
          setActivation({
            stage: "environment.activation.failed",
            detail,
            status: "failed",
          });
          setStatus(detail);
        }
      }
    })();
    return () => {
      cancelled = true;
      activationController.abort();
    };
  }, [
    base,
    loadApplications,
    loadPromotions,
    loadPublicationRepositories,
    loadTree,
    threadId,
  ]);

  useEffect(() => {
    if (activation.status !== "ready") return;
    const interval = window.setInterval(() => {
      void (async () => {
        const treeResponse = await fetch(
          `${base}/tree?path=${encodeURIComponent(directory)}`,
        );
        if (treeResponse.ok) {
          const tree = (await treeResponse.json()) as { entries: TreeEntry[] };
          setEntries(tree.entries);
        }
        await loadPromotions();
        await loadApplications();
        if (!selectedPath) return;
        const fileResponse = await fetch(
          `${base}/files?path=${encodeURIComponent(selectedPath)}`,
        );
        if (!fileResponse.ok) return;
        const remoteRevision = fileResponse.headers.get("etag");
        if (!(remoteRevision && remoteRevision !== fileRevision)) return;
        if (fileDirty) {
          setRemoteChanged(true);
          setStatus(
            "This file changed in the Environment. Reload before saving.",
          );
          return;
        }
        setContent(await fileResponse.text());
        setFileRevision(remoteRevision);
        setRemoteChanged(false);
      })().catch(() => {});
    }, 2000);
    return () => window.clearInterval(interval);
  }, [
    activation.status,
    base,
    directory,
    fileDirty,
    fileRevision,
    loadApplications,
    loadPromotions,
    selectedPath,
  ]);

  useEffect(() => {
    if (!(activation.status === "ready" && terminalSessionId)) return;
    const interval = window.setInterval(() => {
      void fetch(
        `${base}/terminal/sessions/${terminalSessionId}/output?cursor=${terminalCursor}`,
      )
        .then(async (response) => {
          if (!response.ok) return;
          const payload = (await response.json()) as {
            output: string;
            cursor: number;
            status: "running" | "exited" | "failed";
            exitCode: number | null;
          };
          if (payload.output) {
            setTerminal((current) => current + payload.output);
          }
          setTerminalCursor(payload.cursor);
          if (payload.status !== "running") {
            setStatus(
              `Terminal ${payload.status}${payload.exitCode === null ? "" : ` (${payload.exitCode})`}`,
            );
          }
        })
        .catch(() => {});
    }, 500);
    return () => window.clearInterval(interval);
  }, [activation.status, base, terminalCursor, terminalSessionId]);

  async function openFile(path: string) {
    setStatus(`Opening ${path}…`);
    const response = await fetch(
      `${base}/files?path=${encodeURIComponent(path)}`,
    );
    if (!response.ok) throw new Error("File could not be opened.");
    const revision = response.headers.get("etag");
    if (!revision) throw new Error("File revision is unavailable.");
    setSelectedPath(path);
    setContent(await response.text());
    setFileRevision(revision);
    setFileDirty(false);
    setRemoteChanged(false);
    setStatus("Environment ready");
  }

  async function saveFile() {
    if (!(selectedPath && fileRevision)) return;
    setStatus(`Saving ${selectedPath}…`);
    const response = await fetch(
      `${base}/files?path=${encodeURIComponent(selectedPath)}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "if-match": fileRevision,
        },
        body: content,
      },
    );
    if (response.status === 409) {
      setRemoteChanged(true);
      throw new Error(
        "This file changed in the Environment. Reload it before saving.",
      );
    }
    if (!response.ok) throw new Error("File could not be saved.");
    const revision = response.headers.get("etag");
    if (!revision) throw new Error("Saved file revision is unavailable.");
    setFileRevision(revision);
    setFileDirty(false);
    setRemoteChanged(false);
    setStatus("Saved");
    await loadTree(directory);
  }

  async function openTerminal() {
    if (terminalSessionId) return terminalSessionId;
    setStatus("Opening terminal…");
    const response = await fetch(`${base}/terminal/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: directory }),
    });
    const result = (await response.json()) as {
      id?: string;
      error?: { code?: string };
    };
    if (!(response.ok && result.id)) {
      throw new Error(result.error?.code ?? "Terminal could not open.");
    }
    setTerminal("");
    setTerminalCursor(0);
    setTerminalSessionId(result.id);
    setStatus("Terminal connected");
    return result.id;
  }

  async function sendTerminalInput() {
    const sessionId = await openTerminal();
    const response = await fetch(
      `${base}/terminal/sessions/${sessionId}/input`,
      {
        method: "POST",
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: `${command}\n`,
      },
    );
    if (!response.ok) throw new Error("Terminal input was rejected.");
    setCommand("");
    await loadTree(directory);
  }

  async function closeTerminal() {
    if (!terminalSessionId) return;
    await fetch(`${base}/terminal/sessions/${terminalSessionId}`, {
      method: "DELETE",
    });
    setTerminalSessionId(null);
    setStatus("Terminal closed");
  }

  async function registerApplication() {
    setStatus("Starting application…");
    const response = await fetch(`${base}/apps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: appName,
        command: appCommand,
        workingDirectory: directory,
        port: Number.parseInt(appPort, 10),
      }),
    });
    const payload = (await response.json()) as {
      application?: WorkspaceApplication;
      error?: { code?: string };
    };
    if (!(response.ok && payload.application)) {
      throw new Error(payload.error?.code ?? "Application could not start.");
    }
    setApplications((current) => [
      ...current.filter((item) => item.id !== payload.application!.id),
      payload.application!,
    ]);
    setStatus("Application started");
  }

  async function setApplicationState(
    application: WorkspaceApplication,
    action: "start" | "stop",
  ) {
    setStatus(
      action === "start" ? "Starting application…" : "Stopping application…",
    );
    const response = await fetch(`${base}/apps/${application.id}/${action}`, {
      method: "POST",
    });
    const payload = (await response.json()) as {
      application?: WorkspaceApplication;
      error?: { code?: string };
    };
    if (!(response.ok && payload.application)) {
      throw new Error(
        payload.error?.code ?? `Application could not ${action}.`,
      );
    }
    setApplications((current) =>
      current.map((item) =>
        item.id === payload.application!.id ? payload.application! : item,
      ),
    );
    setStatus(
      action === "start" ? "Application started" : "Application stopping",
    );
  }

  async function openPromotion(promotionId: string) {
    setStatus("Loading candidate preview…");
    const response = await fetch(`${base}/promotions/${promotionId}`, {
      cache: "no-store",
    });
    const payload = (await response.json()) as {
      preview?: WorkspacePromotionPreview;
      error?: { code?: string };
    };
    if (!(response.ok && payload.preview)) {
      throw new Error(
        payload.error?.code ?? "Candidate preview is unavailable.",
      );
    }
    setPromotionPreview(payload.preview);
    await loadPublicationRepositories();
    setStatus("Candidate preview ready");
  }

  async function acceptPromotion() {
    const preview = promotionPreview;
    if (!(preview?.candidateFingerprint && preview.status === "ready")) return;
    setAcceptingPromotion(true);
    setStatus("Accepting candidate into the Workspace…");
    try {
      const response = await fetch(
        `${base}/promotions/${preview.promotion.promotionId}/apply`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            candidateFingerprint: preview.candidateFingerprint,
          }),
        },
      );
      const payload = (await response.json()) as {
        promotion?: WorkspacePromotion;
        error?: { code?: string };
      };
      if (!(response.ok && payload.promotion)) {
        throw new Error(
          payload.error?.code ?? "Candidate could not be accepted.",
        );
      }
      setPromotionPreview(null);
      await Promise.all([loadPromotions(), loadTree(directory)]);
      setStatus("Candidate accepted into the Workspace");
    } finally {
      setAcceptingPromotion(false);
    }
  }

  async function publishPromotion(mode: "agent_branch" | "initialize") {
    const preview = promotionPreview;
    const repository = publicationRepositories.find(
      (candidate) => candidate.repositoryId === selectedRepositoryId,
    );
    if (
      !(
        preview?.candidateFingerprint &&
        preview.status === "ready" &&
        repository
      )
    ) {
      return;
    }
    setPushingPromotion(true);
    setStatus(
      mode === "initialize"
        ? `Initializing ${repository.fullName} on main…`
        : `Pushing candidate to ${repository.fullName}…`,
    );
    try {
      const response = await fetch(
        `/api/threads/${threadId}/github/publications`,
        {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          promotionId: preview.promotion.promotionId,
          candidateFingerprint: preview.candidateFingerprint,
          repositoryId: repository.repositoryId,
          mode,
        }),
        },
      );
      const payload = (await response.json()) as {
        branch?: string;
        repository?: string;
        mode?: "agent_branch" | "initialize";
        error?: string | { code?: string; message?: string };
      };
      if (!(response.ok && payload.branch)) {
        throw new Error(githubPublicationFailure(payload.error));
      }
      setStatus(
        payload.mode === "initialize"
          ? `Initialized ${payload.repository ?? repository.fullName} on ${payload.branch}`
          : `Pushed ${payload.repository ?? repository.fullName}#${payload.branch}`,
      );
      await loadPublicationRepositories();
    } finally {
      setPushingPromotion(false);
      setInitializationOpen(false);
    }
  }

  useEffect(() => {
    if (reviewQueryHandled || activation.status !== "ready") return;
    const query = new URLSearchParams(window.location.search);
    const runId = query.get("runId");
    const repositoryName = query.get("repository");
    if (!runId) {
      setReviewQueryHandled(true);
      return;
    }
    const promotion = promotions.find((candidate) => candidate.runId === runId);
    if (!promotion) return;
    const repository = publicationRepositories.find(
      (candidate) => candidate.fullName === repositoryName,
    );
    if (repository) setSelectedRepositoryId(repository.repositoryId);
    setReviewQueryHandled(true);
    setMobilePane("candidates");
    setCandidatesOpen(true);
    void (async () => {
      const response = await fetch(`${base}/promotions/${promotion.promotionId}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        preview?: WorkspacePromotionPreview;
      };
      if (response.ok && payload.preview) {
        setPromotionPreview(payload.preview);
        setStatus("Candidate preview ready");
      }
    })();
  }, [
    activation.status,
    base,
    promotions,
    publicationRepositories,
    reviewQueryHandled,
  ]);

  const selectedPublicationRepository = publicationRepositories.find(
    (repository) => repository.repositoryId === selectedRepositoryId,
  );

  const environmentReady = activation.status === "ready";

  return (
    <main
      aria-busy={activation.status === "pending"}
      className="flex h-dvh min-w-0 flex-col bg-background"
    >
      <header className="flex h-12 items-center gap-3 border-b px-3">
        <Button asChild size="sm" variant="ghost">
          <Link href={`/threads/${threadId}`}>
            <ArrowLeft className="size-4" />
            Thread
          </Link>
        </Button>
        <h1 className="font-medium">Workspace</h1>
        <div className="ml-2 hidden items-center gap-1 sm:flex">
          <Button
            aria-pressed={filesOpen}
            onClick={() => {
              setFilesOpen((current) => !current);
              setMobilePane("files");
            }}
            size="sm"
            variant="ghost"
          >
            Files
          </Button>
          <Button
            aria-pressed={candidatesOpen}
            onClick={() => {
              setCandidatesOpen((current) => !current);
              setMobilePane("candidates");
            }}
            size="sm"
            variant="ghost"
          >
            Candidates
          </Button>
          <Button
            aria-pressed={terminalPanelOpen}
            onClick={() => setTerminalPanelOpen((current) => !current)}
            size="sm"
            variant="ghost"
          >
            Terminal
          </Button>
        </div>
        <div
          aria-atomic="true"
          aria-live={activation.status === "failed" ? "assertive" : "polite"}
          className="ml-auto flex items-center gap-1.5 text-muted-foreground text-xs"
          role={activation.status === "failed" ? "alert" : "status"}
        >
          {activation.status === "pending" ? (
            <LoaderCircle
              aria-hidden="true"
              className="size-3.5 animate-spin"
            />
          ) : activation.status === "failed" ? (
            <TriangleAlert
              aria-hidden="true"
              className="size-3.5 text-destructive"
            />
          ) : (
            <CircleCheck aria-hidden="true" className="size-3.5" />
          )}
          <span>
            {activation.status === "ready" ? status : activation.detail}
          </span>
        </div>
      </header>
      <div className="flex border-b sm:hidden">
        {(["files", "editor", "candidates"] as const).map((pane) => (
          <button
            aria-pressed={mobilePane === pane}
            className={cn(
              "flex-1 border-transparent border-b-2 px-3 py-2 text-sm capitalize",
              mobilePane === pane && "border-foreground font-medium",
            )}
            key={pane}
            onClick={() => setMobilePane(pane)}
            type="button"
          >
            {pane}
          </button>
        ))}
        <button
          aria-pressed={terminalPanelOpen}
          className={cn(
            "border-transparent border-b-2 px-3 py-2 text-sm",
            terminalPanelOpen && "border-foreground font-medium",
          )}
          onClick={() => setTerminalPanelOpen((current) => !current)}
          type="button"
        >
          Terminal
        </button>
      </div>
      <div
        className={cn(
          "grid min-h-0 flex-1 grid-cols-1",
          filesOpen &&
            candidatesOpen &&
            "lg:grid-cols-[240px_minmax(0,1fr)_320px]",
          filesOpen && !candidatesOpen && "lg:grid-cols-[240px_minmax(0,1fr)]",
          !filesOpen && candidatesOpen && "lg:grid-cols-[minmax(0,1fr)_320px]",
        )}
      >
        <aside
          aria-label="Workspace files"
          className={cn(
            "min-h-0 overflow-auto border-r p-2 text-sm",
            mobilePane !== "files" && "hidden lg:block",
            !filesOpen && "lg:hidden",
          )}
        >
          {directory && (
            <button
              className="mb-1 block w-full rounded px-2 py-1 text-left hover:bg-muted"
              onClick={() =>
                void loadTree(directory.split("/").slice(0, -1).join("/"))
              }
              type="button"
            >
              ..
            </button>
          )}
          {entries.map((entry) => (
            <button
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-muted"
              key={entry.path}
              onClick={() =>
                void (entry.type === "directory"
                  ? loadTree(entry.path)
                  : openFile(entry.path))
              }
              type="button"
            >
              {entry.type === "directory" ? (
                <Folder className="size-4" />
              ) : (
                <File className="size-4" />
              )}
              <span className="truncate">{entry.name}</span>
            </button>
          ))}
        </aside>
        <section
          className={cn(
            "min-h-0 flex-col",
            mobilePane === "editor" ? "flex" : "hidden lg:flex",
          )}
        >
          <div className="flex h-10 items-center border-b px-3 text-sm">
            <span className="truncate">{selectedPath ?? "Select a file"}</span>
            <Button
              className="ml-auto"
              disabled={!(selectedPath && fileRevision) || remoteChanged}
              onClick={() =>
                void saveFile().catch((error: unknown) =>
                  setStatus(
                    error instanceof Error ? error.message : "Save failed.",
                  ),
                )
              }
              size="sm"
              variant="ghost"
            >
              <Save className="size-4" />
              Save
            </Button>
          </div>
          <textarea
            aria-label={
              selectedPath ? `Editing ${selectedPath}` : "Workspace file editor"
            }
            className="min-h-0 flex-1 resize-none bg-background p-4 font-mono text-sm outline-none"
            disabled={!selectedPath}
            onChange={(event) => {
              setContent(event.target.value);
              setFileDirty(true);
            }}
            spellCheck={false}
            value={content}
          />
        </section>
        <aside
          aria-label="Workspace candidates"
          className={cn(
            "min-h-0 overflow-auto border-l p-3 text-sm",
            mobilePane !== "candidates" && "hidden lg:block",
            !candidatesOpen && "lg:hidden",
          )}
        >
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-medium">Candidates</h2>
            <span className="text-muted-foreground text-xs">
              {promotions.length}
            </span>
          </div>
          <div className="space-y-2">
            {promotions.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                Agent worktree candidates will appear here before promotion.
              </p>
            ) : null}
            {promotions.map((promotion) => (
              <button
                className="block w-full rounded border p-2 text-left hover:bg-muted"
                key={promotion.promotionId}
                onClick={() =>
                  void openPromotion(promotion.promotionId).catch(
                    (error: unknown) =>
                      setStatus(
                        error instanceof Error
                          ? error.message
                          : "Candidate preview failed.",
                      ),
                  )
                }
                type="button"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{promotion.status}</span>
                  <span className="text-muted-foreground text-xs">
                    {promotion.changedFiles.length} files
                  </span>
                </div>
                <div className="mt-1 truncate font-mono text-xs">
                  {promotion.changedFiles[0] ?? "No changes"}
                </div>
              </button>
            ))}
          </div>
          {promotionPreview ? (
            <div className="mt-4 space-y-3 border-t pt-3">
              <div>
                <div className="font-medium">
                  Preview · {promotionPreview.status}
                </div>
                {promotionPreview.blockedReason ? (
                  <div className="text-destructive text-xs">
                    {promotionPreview.blockedReason}
                  </div>
                ) : null}
              </div>
              <div className="max-h-72 space-y-3 overflow-auto">
                {promotionPreview.diff.files.map((file) => (
                  <div className="rounded border" key={file.path}>
                    <div className="border-b px-2 py-1 font-mono text-xs">
                      {file.status} · {file.path}
                    </div>
                    {file.hunks?.length ? (
                      <pre className="overflow-auto whitespace-pre p-2 font-mono text-[11px]">
                        {file.hunks.join("\n")}
                      </pre>
                    ) : null}
                  </div>
                ))}
              </div>
              <div className="grid gap-2">
                <Select
                  disabled={pushingPromotion || publicationRepositories.length === 0}
                  onValueChange={setSelectedRepositoryId}
                  value={selectedRepositoryId}
                >
                  <SelectTrigger aria-label="GitHub publication target" size="sm">
                    <SelectValue placeholder="Select a repository" />
                  </SelectTrigger>
                  <SelectContent>
                    {publicationRepositories.map((repository) => (
                      <SelectItem
                        key={repository.repositoryId}
                        value={repository.repositoryId}
                      >
                        {repository.fullName}
                        {repository.isPrivate ? " · Private" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedPublicationRepository ? (
                  <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
                    {selectedPublicationRepository.isPrivate ? (
                      <Badge variant="outline">Private</Badge>
                    ) : null}
                    <span>
                      {selectedPublicationRepository.isEmpty === true
                        ? "Empty repository · publishes one clean root commit to main."
                        : selectedPublicationRepository.isEmpty === false
                          ? `Publishes a Kestrel agent branch from ${selectedPublicationRepository.defaultBranch ?? "the default branch"}.`
                          : "Refresh GitHub repositories to verify whether this target is empty."}
                    </span>
                  </div>
                ) : null}
                <Button
                  className="w-full"
                  disabled={
                    promotionPreview.status !== "ready" ||
                    !promotionPreview.candidateFingerprint ||
                    !selectedPublicationRepository ||
                    selectedPublicationRepository.isEmpty === null ||
                    pushingPromotion
                  }
                  onClick={() => {
                    if (selectedPublicationRepository?.isEmpty === true) {
                      setInitializationOpen(true);
                      return;
                    }
                    if (selectedPublicationRepository?.isEmpty !== false) return;
                    void publishPromotion("agent_branch").catch(
                      (error: unknown) =>
                        setStatus(
                          error instanceof Error
                            ? error.message
                            : "Candidate branch push failed.",
                        ),
                    );
                  }}
                  size="sm"
                  variant="outline"
                >
                  {pushingPromotion
                    ? "Publishing…"
                    : selectedPublicationRepository?.isEmpty === true
                      ? "Publish to main"
                      : selectedPublicationRepository?.isEmpty === false
                        ? "Push agent branch"
                        : "Refresh repository state"}
                </Button>
                <Button
                  className="w-full"
                  disabled={
                    promotionPreview.status !== "ready" ||
                    !promotionPreview.candidateFingerprint ||
                    acceptingPromotion
                  }
                  onClick={() =>
                    void acceptPromotion().catch((error: unknown) =>
                      setStatus(
                        error instanceof Error
                          ? error.message
                          : "Candidate acceptance failed.",
                      ),
                    )
                  }
                  size="sm"
                >
                  {acceptingPromotion ? "Accepting…" : "Accept candidate"}
                </Button>
              </div>
            </div>
          ) : null}
        </aside>
      </div>
      <AlertDialog onOpenChange={setInitializationOpen} open={initializationOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Initialize this GitHub repository?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  Kestrel will publish the reviewed candidate as one clean root
                  commit on <span className="font-mono">main</span>. It will not
                  publish the Workspace&apos;s internal Git history or change the
                  repository visibility.
                </p>
                <div className="rounded-md border bg-muted/40 p-3 text-foreground">
                  <div className="font-medium">
                    {selectedPublicationRepository?.fullName ?? "Repository"}
                    {selectedPublicationRepository?.isPrivate ? " · Private" : ""}
                  </div>
                  <div className="mt-2 break-all font-mono text-xs">
                    Candidate: {promotionPreview?.candidateFingerprint}
                  </div>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pushingPromotion}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pushingPromotion}
              onClick={(event) => {
                event.preventDefault();
                void publishPromotion("initialize").catch((error: unknown) =>
                  setStatus(
                    error instanceof Error
                      ? error.message
                      : "Repository initialization failed.",
                  ),
                );
              }}
            >
              {pushingPromotion ? "Publishing…" : "Confirm and publish to main"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <section className="border-t bg-background">
        <div className="flex min-h-11 flex-wrap items-center gap-2 px-3 py-1.5">
          <span className="mr-1 font-medium text-xs">Applications</span>
          {applications.length === 0 ? (
            <span className="text-muted-foreground text-xs">None running</span>
          ) : null}
          {applications.map((application) => (
            <div className="flex items-center gap-1" key={application.id}>
              {application.status === "running" ? (
                <Button asChild size="sm" variant="outline">
                  <a
                    href={`${base}/apps/${application.id}/proxy/`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {application.name} ·{" "}
                    {application.desiredState === "stopped"
                      ? "stopping"
                      : application.status}
                  </a>
                </Button>
              ) : (
                <Button disabled size="sm" variant="outline">
                  {application.name} · {application.status}
                </Button>
              )}
              <Button
                disabled={
                  !environmentReady ||
                  application.status === "starting" ||
                  (application.desiredState === "stopped" &&
                    application.processId !== null)
                }
                onClick={() =>
                  void setApplicationState(
                    application,
                    application.status === "running" ? "stop" : "start",
                  ).catch((error: unknown) =>
                    setStatus(
                      error instanceof Error
                        ? error.message
                        : "Application action failed.",
                    ),
                  )
                }
                size="sm"
                variant="ghost"
              >
                {application.desiredState === "stopped" &&
                application.status === "running"
                  ? "Stopping"
                  : application.status === "running"
                    ? "Stop"
                    : "Start"}
              </Button>
            </div>
          ))}
          <Button
            className="ml-auto"
            onClick={() => setAppFormOpen((current) => !current)}
            size="sm"
            variant="ghost"
          >
            {appFormOpen ? "Close" : "Add application"}
          </Button>
        </div>
        {appFormOpen ? (
          <div className="flex flex-wrap items-center gap-2 border-t bg-muted/20 p-2">
            <Input
              aria-label="Application name"
              className="h-8 w-28"
              disabled={!environmentReady}
              onChange={(event) => setAppName(event.target.value)}
              value={appName}
            />
            <Input
              aria-label="Application start command"
              className="h-8 min-w-48 flex-1 font-mono"
              disabled={!environmentReady}
              onChange={(event) => setAppCommand(event.target.value)}
              value={appCommand}
            />
            <Input
              aria-label="Application port"
              className="h-8 w-20 font-mono"
              disabled={!environmentReady}
              onChange={(event) => setAppPort(event.target.value)}
              value={appPort}
            />
            <Button
              disabled={!environmentReady}
              onClick={() =>
                void registerApplication().catch((error: unknown) =>
                  setStatus(
                    error instanceof Error
                      ? error.message
                      : "Application failed.",
                  ),
                )
              }
              size="sm"
            >
              Start app
            </Button>
          </div>
        ) : null}
      </section>
      {terminalPanelOpen ? (
        <section className="flex h-[220px] min-h-0 flex-col border-t bg-zinc-950 text-zinc-100">
          <div className="flex gap-2 border-zinc-800 border-b p-2">
            <Input
              aria-label="Terminal input"
              className="border-zinc-700 bg-zinc-900 font-mono text-zinc-100"
              disabled={!environmentReady}
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter")
                  void sendTerminalInput().catch((error: unknown) =>
                    setStatus(
                      error instanceof Error
                        ? error.message
                        : "Command failed.",
                    ),
                  );
              }}
              value={command}
            />
            <Button
              disabled={!environmentReady}
              onClick={() =>
                void sendTerminalInput().catch((error: unknown) =>
                  setStatus(
                    error instanceof Error ? error.message : "Command failed.",
                  ),
                )
              }
              size="sm"
            >
              <Play className="size-4" />
              Send
            </Button>
            <Button
              disabled={!environmentReady}
              onClick={() =>
                void (
                  terminalSessionId ? closeTerminal() : openTerminal()
                ).catch((error: unknown) =>
                  setStatus(
                    error instanceof Error
                      ? error.message
                      : "Terminal action failed.",
                  ),
                )
              }
              size="sm"
              variant="secondary"
            >
              {terminalSessionId ? "Close" : "Open terminal"}
            </Button>
          </div>
          <pre
            aria-label="Terminal output"
            className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs"
            role="log"
          >
            {terminal}
          </pre>
        </section>
      ) : null}
    </main>
  );
}
