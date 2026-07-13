"use client";

import { ArrowLeft, File, Folder, Play, Save } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StandaloneWorkspaceSetup } from "./standalone-workspace-setup";

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
  status: string;
};

type WorkspacePromotion = {
  promotionId: string;
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

type EnvironmentActivation = {
  stage: string;
  detail: string;
  status: "pending" | "ready" | "failed";
};

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
    null
  );
  const [terminalCursor, setTerminalCursor] = useState(0);
  const [status, setStatus] = useState("Connecting to the Environment…");
  const [applications, setApplications] = useState<WorkspaceApplication[]>([]);
  const [appName, setAppName] = useState("Preview");
  const [appCommand, setAppCommand] = useState("pnpm dev");
  const [appPort, setAppPort] = useState("3000");
  const [promotions, setPromotions] = useState<WorkspacePromotion[]>([]);
  const [promotionPreview, setPromotionPreview] =
    useState<WorkspacePromotionPreview | null>(null);
  const [acceptingPromotion, setAcceptingPromotion] = useState(false);
  const [pushingPromotion, setPushingPromotion] = useState(false);

  const loadPromotions = useCallback(async () => {
    const response = await fetch(`${base}/promotions`, { cache: "no-store" });
    if (!response.ok) return;
    const payload = (await response.json()) as {
      promotions?: WorkspacePromotion[];
    };
    setPromotions(payload.promotions ?? []);
  }, [base]);

  const loadTree = useCallback(
    async (path: string, showLoading = true) => {
      if (showLoading) setStatus("Loading Workspace…");
      const response = await fetch(
        `${base}/tree?path=${encodeURIComponent(path)}`
      );
      if (!response.ok) throw new Error("Workspace tree is unavailable.");
      const data = (await response.json()) as { entries: TreeEntry[] };
      setDirectory(path);
      setEntries(data.entries);
      if (showLoading) setStatus("Environment ready");
    },
    [base]
  );

  useEffect(() => {
    let cancelled = false;
    let settled = false;
    void (async () => {
      try {
        const startResponse = await fetch(
          `/api/threads/${threadId}/environment`,
          {
            method: "POST",
          }
        );
        const startPayload = (await startResponse.json()) as {
          activation?: EnvironmentActivation;
          error?: string;
        };
        if (!(startResponse.ok && startPayload.activation)) {
          throw new Error(
            startPayload.error ?? "Workspace activation could not start."
          );
        }
        if (!cancelled) setStatus(startPayload.activation.detail);

        const pollActivation = async () => {
          while (!(cancelled || settled)) {
            const response = await fetch(
              `/api/threads/${threadId}/environment`,
              { cache: "no-store" }
            );
            if (response.ok) {
              const payload = (await response.json()) as {
                activation?: EnvironmentActivation;
              };
              if (payload.activation && !cancelled) {
                setStatus(payload.activation.detail);
              }
            }
            await new Promise((resolve) => window.setTimeout(resolve, 500));
          }
        };
        const polling = pollActivation();
        try {
          await loadTree("", false);
        } finally {
          settled = true;
          await polling;
        }
        if (!cancelled) setStatus("Environment ready");
      } catch (error) {
        if (!cancelled) {
          setStatus(
            error instanceof Error ? error.message : "Workspace unavailable."
          );
        }
      }
    })();
    void fetch(`${base}/apps`)
      .then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as {
          applications?: WorkspaceApplication[];
        };
        setApplications(payload.applications ?? []);
      })
      .catch(() => {});
    void loadPromotions();
    return () => {
      cancelled = true;
    };
  }, [base, loadPromotions, loadTree, threadId]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void (async () => {
        const treeResponse = await fetch(
          `${base}/tree?path=${encodeURIComponent(directory)}`
        );
        if (treeResponse.ok) {
          const tree = (await treeResponse.json()) as { entries: TreeEntry[] };
          setEntries(tree.entries);
        }
        await loadPromotions();
        if (!selectedPath) return;
        const fileResponse = await fetch(
          `${base}/files?path=${encodeURIComponent(selectedPath)}`
        );
        if (!fileResponse.ok) return;
        const remoteRevision = fileResponse.headers.get("etag");
        if (!(remoteRevision && remoteRevision !== fileRevision)) return;
        if (fileDirty) {
          setRemoteChanged(true);
          setStatus(
            "This file changed in the Environment. Reload before saving."
          );
          return;
        }
        setContent(await fileResponse.text());
        setFileRevision(remoteRevision);
        setRemoteChanged(false);
      })().catch(() => {});
    }, 2000);
    return () => window.clearInterval(interval);
  }, [base, directory, fileDirty, fileRevision, loadPromotions, selectedPath]);

  useEffect(() => {
    if (!terminalSessionId) return;
    const interval = window.setInterval(() => {
      void fetch(
        `${base}/terminal/sessions/${terminalSessionId}/output?cursor=${terminalCursor}`
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
              `Terminal ${payload.status}${payload.exitCode === null ? "" : ` (${payload.exitCode})`}`
            );
          }
        })
        .catch(() => {});
    }, 500);
    return () => window.clearInterval(interval);
  }, [base, terminalCursor, terminalSessionId]);

  async function openFile(path: string) {
    setStatus(`Opening ${path}…`);
    const response = await fetch(
      `${base}/files?path=${encodeURIComponent(path)}`
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
      }
    );
    if (response.status === 409) {
      setRemoteChanged(true);
      throw new Error(
        "This file changed in the Environment. Reload it before saving."
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
      }
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
        payload.error?.code ?? "Candidate preview is unavailable."
      );
    }
    setPromotionPreview(payload.preview);
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
        }
      );
      const payload = (await response.json()) as {
        promotion?: WorkspacePromotion;
        error?: { code?: string };
      };
      if (!(response.ok && payload.promotion)) {
        throw new Error(
          payload.error?.code ?? "Candidate could not be accepted."
        );
      }
      setPromotionPreview(null);
      await Promise.all([loadPromotions(), loadTree(directory)]);
      setStatus("Candidate accepted into the Workspace");
    } finally {
      setAcceptingPromotion(false);
    }
  }

  async function pushPromotion() {
    const preview = promotionPreview;
    if (!(preview?.candidateFingerprint && preview.status === "ready")) return;
    setPushingPromotion(true);
    setStatus("Pushing candidate to its Kestrel agent branch…");
    try {
      const response = await fetch(`${base}/git/push-agent-branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          promotionId: preview.promotion.promotionId,
          candidateFingerprint: preview.candidateFingerprint,
        }),
      });
      const payload = (await response.json()) as {
        branch?: string;
        repository?: string;
        error?: { code?: string };
      };
      if (!(response.ok && payload.branch)) {
        throw new Error(payload.error?.code ?? "Candidate branch push failed.");
      }
      setStatus(
        `Pushed ${payload.repository ?? "repository"}#${payload.branch}`
      );
    } finally {
      setPushingPromotion(false);
    }
  }

  return (
    <main className="flex h-dvh min-w-0 flex-col bg-background">
      <header className="flex h-12 items-center gap-3 border-b px-3">
        <Button asChild size="sm" variant="ghost">
          <Link href={`/threads/${threadId}`}>
            <ArrowLeft className="size-4" />
            Thread
          </Link>
        </Button>
        <div className="font-medium">Workspace</div>
        <div className="ml-auto text-muted-foreground text-xs">{status}</div>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)_340px] grid-rows-[minmax(0,1fr)_220px]">
        <aside className="row-span-2 overflow-auto border-r p-2 text-sm">
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
        <section className="flex min-h-0 flex-col">
          <div className="flex h-10 items-center border-b px-3 text-sm">
            <span className="truncate">{selectedPath ?? "Select a file"}</span>
            <Button
              className="ml-auto"
              disabled={!(selectedPath && fileRevision) || remoteChanged}
              onClick={() =>
                void saveFile().catch((error: unknown) =>
                  setStatus(
                    error instanceof Error ? error.message : "Save failed."
                  )
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
        <aside className="min-h-0 overflow-auto border-l p-3 text-sm">
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
                          : "Candidate preview failed."
                      )
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
                <Button
                  className="w-full"
                  disabled={
                    promotionPreview.status !== "ready" ||
                    !promotionPreview.candidateFingerprint ||
                    pushingPromotion
                  }
                  onClick={() =>
                    void pushPromotion().catch((error: unknown) =>
                      setStatus(
                        error instanceof Error
                          ? error.message
                          : "Candidate branch push failed."
                      )
                    )
                  }
                  size="sm"
                  variant="outline"
                >
                  {pushingPromotion ? "Pushing…" : "Push agent branch"}
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
                          : "Candidate acceptance failed."
                      )
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
        <section className="col-span-2 flex min-h-0 flex-col border-t bg-zinc-950 text-zinc-100">
          <div className="flex flex-wrap items-center gap-2 border-zinc-800 border-b p-2">
            <Input
              className="h-8 w-28 border-zinc-700 bg-zinc-900"
              onChange={(event) => setAppName(event.target.value)}
              value={appName}
            />
            <Input
              className="h-8 min-w-48 flex-1 border-zinc-700 bg-zinc-900 font-mono"
              onChange={(event) => setAppCommand(event.target.value)}
              value={appCommand}
            />
            <Input
              className="h-8 w-20 border-zinc-700 bg-zinc-900 font-mono"
              onChange={(event) => setAppPort(event.target.value)}
              value={appPort}
            />
            <Button
              onClick={() =>
                void registerApplication().catch((error: unknown) =>
                  setStatus(
                    error instanceof Error
                      ? error.message
                      : "Application failed."
                  )
                )
              }
              size="sm"
              variant="secondary"
            >
              Start app
            </Button>
            {applications.map((application) => (
              <Button asChild key={application.id} size="sm" variant="outline">
                <a
                  href={`${base}/apps/${application.id}/proxy/`}
                  rel="noreferrer"
                  target="_blank"
                >
                  {application.name} · {application.status}
                </a>
              </Button>
            ))}
          </div>
          <div className="flex gap-2 border-zinc-800 border-b p-2">
            <Input
              className="border-zinc-700 bg-zinc-900 font-mono text-zinc-100"
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter")
                  void sendTerminalInput().catch((error: unknown) =>
                    setStatus(
                      error instanceof Error ? error.message : "Command failed."
                    )
                  );
              }}
              value={command}
            />
            <Button
              onClick={() =>
                void sendTerminalInput().catch((error: unknown) =>
                  setStatus(
                    error instanceof Error ? error.message : "Command failed."
                  )
                )
              }
              size="sm"
            >
              <Play className="size-4" />
              Send
            </Button>
            <Button
              onClick={() =>
                void (
                  terminalSessionId ? closeTerminal() : openTerminal()
                ).catch((error: unknown) =>
                  setStatus(
                    error instanceof Error
                      ? error.message
                      : "Terminal action failed."
                  )
                )
              }
              size="sm"
              variant="secondary"
            >
              {terminalSessionId ? "Close" : "Open terminal"}
            </Button>
          </div>
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs">
            {terminal}
          </pre>
        </section>
      </div>
    </main>
  );
}
