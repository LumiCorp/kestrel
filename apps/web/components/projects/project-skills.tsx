"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type WorkspaceSkill = {
  installationId: string;
  status:
    | "pending"
    | "syncing"
    | "ready"
    | "stale"
    | "failed"
    | "removal_pending";
  source: { gitUrl: string; branch: string; path?: string };
  revision?: {
    name: string;
    description: string;
    commitSha: string;
    contentDigest: string;
    skillFile: string;
  };
  lastSyncError?: string;
};

type WorkspaceSkillsResponse = {
  skills: WorkspaceSkill[];
};

const STATUS_LABELS: Record<WorkspaceSkill["status"], string> = {
  pending: "Pending activation",
  syncing: "Syncing",
  ready: "Ready",
  stale: "Stale",
  failed: "Sync failed",
  removal_pending: "Removal pending",
};

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  return (await requestJsonWithStatus<T>(url, init)).body;
}

async function requestJsonWithStatus<T>(
  url: string,
  init?: RequestInit
): Promise<{ body: T; status: number }> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(body.error || "Project skills are unavailable.");
  }
  return { body, status: response.status };
}

export function ProjectSkills({
  canEdit,
  projectId,
}: {
  canEdit: boolean;
  projectId: string;
}) {
  const skillsUrl = `/api/projects/${projectId}/workspace/skills`;
  const { data, error, isLoading, mutate } = useSWR<WorkspaceSkillsResponse>(
    skillsUrl,
    (url: string) => requestJson<WorkspaceSkillsResponse>(url)
  );
  const [gitUrl, setGitUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [skillPath, setSkillPath] = useState("");
  const [editingSkillId, setEditingSkillId] = useState<string>();
  const [working, setWorking] = useState(false);

  function clearForm() {
    setGitUrl("");
    setBranch("main");
    setSkillPath("");
    setEditingSkillId(undefined);
  }

  async function saveSkill() {
    setWorking(true);
    try {
      const endpoint =
        editingSkillId === undefined
          ? skillsUrl
          : `${skillsUrl}/${encodeURIComponent(editingSkillId)}`;
      const payload = await requestJson<{ skill?: WorkspaceSkill }>(endpoint, {
        method: editingSkillId === undefined ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          gitUrl: gitUrl.trim(),
          branch: branch.trim(),
          ...(skillPath.trim() ? { path: skillPath.trim() } : {}),
        }),
      });
      await mutate();
      clearForm();
      toast.success(
        payload.skill?.status === "ready"
          ? "Agent skill is ready."
          : "Skill saved. It will activate when the Project workspace is available."
      );
    } catch (saveError) {
      toast.error(
        saveError instanceof Error
          ? saveError.message
          : "Skill installation failed."
      );
    } finally {
      setWorking(false);
    }
  }

  async function syncSkills() {
    setWorking(true);
    try {
      const result = await requestJsonWithStatus<WorkspaceSkillsResponse>(
        `${skillsUrl}/sync`,
        { method: "POST" }
      );
      await mutate(result.body, { revalidate: false });
      toast.success(
        result.status === 202
          ? "Sync queued. Skills will activate when the Project workspace is available."
          : result.body.skills.some(
          (skill) => skill.status === "pending" || skill.status === "syncing"
        )
          ? "Sync queued. Pending skills will activate when the Project workspace is available."
          : "Agent skills synchronized."
      );
    } catch (syncError) {
      toast.error(
        syncError instanceof Error
          ? syncError.message
          : "Skill synchronization failed."
      );
    } finally {
      setWorking(false);
    }
  }

  async function removeSkill(installationId: string) {
    setWorking(true);
    try {
      const result = await requestJson<WorkspaceSkillsResponse>(
        `${skillsUrl}/${encodeURIComponent(installationId)}`,
        { method: "DELETE" }
      );
      await mutate(result, { revalidate: false });
      if (editingSkillId === installationId) clearForm();
      toast.success("Agent skill removed.");
    } catch (removeError) {
      toast.error(
        removeError instanceof Error
          ? removeError.message
          : "Skill removal failed."
      );
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="w-full py-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold text-xl">Agent skills</h2>
          <p className="mt-1 max-w-2xl text-muted-foreground text-sm">
            Install reusable agent guidance from a public HTTPS Git repository.
            Skills do not grant permissions or run installation hooks.
          </p>
        </div>
        <Button
          disabled={!canEdit || working || isLoading}
          onClick={() => void syncSkills()}
          size="sm"
          variant="outline"
        >
          {working ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          Sync
        </Button>
      </div>

      {isLoading ? (
        <div className="mt-6 flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading Project skills…
        </div>
      ) : null}

      {error ? (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border-y py-4">
          <p className="text-destructive text-sm">
            Project skills could not be loaded. You can retry without starting
            a workspace.
          </p>
          <Button onClick={() => void mutate()} size="sm" variant="outline">
            Retry
          </Button>
        </div>
      ) : null}

      {canEdit ? (
        <div className="mt-6 rounded-xl border bg-card p-4">
          <h3 className="font-medium">Add from Git</h3>
          <p className="mt-1 text-muted-foreground text-sm">
            Save a public HTTPS repository now. Kestrel activates it when the
            Project workspace is available and idle.
          </p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="grid min-w-0 flex-1 gap-2">
              <Label htmlFor="skill-git-url">Git repository URL</Label>
              <Input
                aria-label="Skill Git URL"
                id="skill-git-url"
                onChange={(event) => setGitUrl(event.target.value)}
                placeholder="https://github.com/org/skills.git"
                value={gitUrl}
              />
            </div>
            <Button
              disabled={working || !gitUrl.trim() || !branch.trim()}
              onClick={() => void saveSkill()}
            >
              {editingSkillId === undefined ? "Install" : "Update"}
            </Button>
          </div>
          <details className="mt-3 text-muted-foreground text-sm">
            <summary>Advanced source options</summary>
            <div className="mt-3 grid max-w-2xl gap-3 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="skill-branch">Branch</Label>
                <Input
                  aria-label="Skill branch"
                  id="skill-branch"
                  onChange={(event) => setBranch(event.target.value)}
                  placeholder="main"
                  value={branch}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="skill-path">Repository path</Label>
                <Input
                  aria-label="Skill path"
                  id="skill-path"
                  onChange={(event) => setSkillPath(event.target.value)}
                  placeholder="Optional repository path"
                  value={skillPath}
                />
              </div>
            </div>
          </details>
        </div>
      ) : null}

      {editingSkillId !== undefined ? (
        <Button
          className="mt-2"
          onClick={clearForm}
          size="sm"
          variant="ghost"
        >
          Cancel edit
        </Button>
      ) : null}

      {isLoading || error ? null : (
        <div className="mt-6 divide-y border-y">
          {(data?.skills ?? []).map((skill) => (
            <div
              className="flex items-start justify-between gap-4 py-4"
              key={skill.installationId}
            >
              <div className="min-w-0">
                <p className="font-medium">
                  {skill.revision?.name ?? "Pending skill"}
                </p>
                <p className="mt-1 break-all text-muted-foreground text-sm">
                  {skill.source.gitUrl}
                </p>
                {skill.revision?.description ? (
                  <p className="mt-1 text-muted-foreground text-sm">
                    {skill.revision.description}
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
                  <Badge variant="outline">
                    {STATUS_LABELS[skill.status]}
                  </Badge>
                  {skill.revision?.commitSha ? (
                    <span>{skill.revision.commitSha.slice(0, 12)}</span>
                  ) : null}
                </div>
                {skill.lastSyncError ? (
                  <p className="mt-2 text-destructive text-xs">
                    {skill.lastSyncError}
                  </p>
                ) : null}
                <details className="mt-2 text-muted-foreground text-xs">
                  <summary>Inspect provenance</summary>
                  <p>Source: {skill.source.gitUrl}</p>
                  <p>
                    Branch: {skill.source.branch}
                    {skill.source.path ? ` · ${skill.source.path}` : ""}
                  </p>
                  {skill.revision ? (
                    <>
                      <p>Commit: {skill.revision.commitSha}</p>
                      <p>Digest: {skill.revision.contentDigest}</p>
                      <p>Instructions: {skill.revision.skillFile}</p>
                    </>
                  ) : null}
                </details>
              </div>
              {canEdit ? (
                <div className="flex shrink-0 gap-2">
                  <Button
                    disabled={working}
                    onClick={() => {
                      setEditingSkillId(skill.installationId);
                      setGitUrl(skill.source.gitUrl);
                      setBranch(skill.source.branch);
                      setSkillPath(skill.source.path ?? "");
                    }}
                    size="sm"
                    variant="outline"
                  >
                    Edit
                  </Button>
                  <Button
                    disabled={working}
                    onClick={() => void removeSkill(skill.installationId)}
                    size="sm"
                    variant="outline"
                  >
                    Remove
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
          {data?.skills.length === 0 ? (
            <p className="py-6 text-muted-foreground text-sm">
              No agent skills installed.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
