"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

type GitHubRepository = {
  repositoryId: string;
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string | null;
  isEmpty: boolean | null;
  canPull: boolean;
  canPush: boolean;
  granted: boolean;
  source: boolean;
  unavailable?: boolean;
};

type GitHubRepositoryGrant = {
  repositoryId: string;
  fullName: string;
};

type Props = {
  projectId: string;
  canEdit: boolean;
  enabled: boolean;
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

async function responseError(response: Response, fallback: string) {
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string | { code?: string; message?: string };
  };
  if (typeof payload.error === "string") return payload.error;
  return payload.error?.message ?? payload.error?.code ?? fallback;
}

export function GitHubProjectRepositoryGrants({
  projectId,
  canEdit,
  enabled,
}: Props) {
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"refresh" | "save" | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/apps/github/repositories`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        throw new Error(
          await responseError(response, "GitHub repositories are unavailable."),
        );
      }
      const payload = (await response.json()) as {
        repositories?: GitHubRepository[];
        grants?: GitHubRepositoryGrant[];
      };
      const synchronized = payload.repositories ?? [];
      const grants = payload.grants ?? [];
      const synchronizedIds = new Set(
        synchronized.map((repository) => repository.repositoryId),
      );
      const next = [
        ...synchronized,
        ...grants
          .filter((grant) => !synchronizedIds.has(grant.repositoryId))
          .map((grant) => ({
            ...grant,
            isPrivate: false,
            defaultBranch: null,
            isEmpty: null,
            canPull: false,
            canPush: false,
            granted: true,
            source: false,
            unavailable: true,
          })),
      ];
      setRepositories(next);
      setSelected(
        new Set(grants.map((grant) => grant.repositoryId)),
      );
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!(enabled && canEdit)) return;
    void load().catch((error: unknown) =>
      toast.error(errorMessage(error, "GitHub repositories are unavailable.")),
    );
  }, [canEdit, enabled, load]);

  async function refresh() {
    setBusy("refresh");
    try {
      const response = await fetch("/api/apps/github/sync", { method: "POST" });
      if (!response.ok) {
        throw new Error(
          await responseError(response, "GitHub repositories could not refresh."),
        );
      }
      await load();
      toast.success("GitHub repositories refreshed");
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy("save");
    try {
      const response = await fetch(
        `/api/projects/${projectId}/apps/github/repositories`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repositoryIds: [...selected] }),
        },
      );
      if (!response.ok) {
        throw new Error(
          await responseError(response, "Repository grants could not be saved."),
        );
      }
      await load();
      toast.success("GitHub repository grants saved");
    } finally {
      setBusy(null);
    }
  }

  if (!(enabled && canEdit)) return null;

  return (
    <section className="border-t py-7">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold text-base">Repository grants</h3>
          <p className="mt-1 text-muted-foreground text-sm">
            Choose the repositories this Project may read or publish to. A
            Workspace source repository remains available automatically.
          </p>
        </div>
        <Button
          disabled={!canEdit || busy !== null}
          onClick={() =>
            void refresh().catch((error: unknown) =>
              toast.error(
                errorMessage(error, "GitHub repositories could not refresh."),
              ),
            )
          }
          size="sm"
          variant="outline"
        >
          {busy === "refresh" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          Refresh
        </Button>
      </div>
      <div className="mt-5 divide-y overflow-hidden rounded-xl border">
        {loading ? (
          <div className="flex items-center gap-2 px-4 py-5 text-muted-foreground text-sm">
            <Loader2 className="size-4 animate-spin" />
            Loading repositories…
          </div>
        ) : repositories.length ? (
          repositories.map((repository) => (
            <label
              className="flex cursor-pointer items-start gap-3 px-4 py-3"
              htmlFor={`github-repository-${repository.repositoryId}`}
              key={repository.repositoryId}
            >
              <Checkbox
                checked={
                  repository.source || selected.has(repository.repositoryId)
                }
                disabled={!canEdit || busy !== null || repository.source}
                id={`github-repository-${repository.repositoryId}`}
                onCheckedChange={(checked) => {
                  setSelected((current) => {
                    const next = new Set(current);
                    if (checked) next.add(repository.repositoryId);
                    else next.delete(repository.repositoryId);
                    return next;
                  });
                }}
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium text-sm">
                    {repository.fullName}
                  </span>
                  {repository.isPrivate ? (
                    <Badge variant="outline">Private</Badge>
                  ) : null}
                  {repository.source ? (
                    <Badge variant="secondary">Workspace source</Badge>
                  ) : null}
                  {repository.unavailable ? (
                    <Badge variant="secondary">Unavailable</Badge>
                  ) : null}
                </span>
                <span className="mt-1 block text-muted-foreground text-xs">
                  {repository.unavailable
                    ? "Not available to your GitHub connection"
                    : repository.canPush
                    ? "Read and push"
                    : repository.canPull
                      ? "Read only"
                      : "No repository access"}
                  {repository.unavailable
                    ? ""
                    : repository.isEmpty === true
                      ? " · empty repository"
                      : repository.isEmpty === false
                        ? ` · default ${repository.defaultBranch ?? "branch"}`
                        : " · state refresh required"}
                </span>
              </span>
            </label>
          ))
        ) : (
          <div className="px-4 py-5 text-muted-foreground text-sm">
            No repositories are synchronized for your GitHub account.
          </div>
        )}
      </div>
      <div className="mt-4 flex justify-end">
        <Button
          disabled={!canEdit || loading || busy !== null}
          onClick={() =>
            void save().catch((error: unknown) =>
              toast.error(
                errorMessage(error, "Repository grants could not be saved."),
              ),
            )
          }
          size="sm"
        >
          {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : null}
          Save repository grants
        </Button>
      </div>
    </section>
  );
}
