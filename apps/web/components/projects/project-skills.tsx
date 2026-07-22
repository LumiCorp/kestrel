"use client";

import { Loader2, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(body.error || "Workspace skills are unavailable.");
  }
  return body;
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
          : "Skill source saved; synchronization is pending or degraded."
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
      await requestJson(`${skillsUrl}/sync`, { method: "POST" });
      await mutate();
      toast.success("Agent skills synchronized.");
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
      await requestJson(`${skillsUrl}/${encodeURIComponent(installationId)}`, {
        method: "DELETE",
      });
      await mutate();
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
          disabled={!canEdit || working || !data}
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
          <Loader2 className="size-4 animate-spin" /> Checking Project
          Workspace…
        </div>
      ) : error ? (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border-y py-5">
          <div>
            <p className="font-medium text-sm">Project Workspace required</p>
            <p className="mt-1 text-muted-foreground text-sm">
              Configure and start this Project&apos;s Workspace before managing
              its agent skills.
            </p>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link href={`/projects/${projectId}/workspace`}>
              Configure Workspace
            </Link>
          </Button>
        </div>
      ) : (
        <>
          {canEdit ? (
            <div className="mt-6">
              <div className="flex gap-3">
              <Input
                aria-label="Skill Git URL"
                className="max-w-2xl"
                onChange={(event) => setGitUrl(event.target.value)}
                placeholder="https://github.com/org/skills.git"
                value={gitUrl}
              />
              <Button
                disabled={
                  working || !gitUrl.trim() || !branch.trim()
                }
                onClick={() => void saveSkill()}
              >
                {editingSkillId === undefined ? "Install" : "Update"}
              </Button>
              </div>
              <details className="mt-3 text-muted-foreground text-sm">
                <summary>Advanced source options</summary>
                <div className="mt-3 grid max-w-2xl gap-3 sm:grid-cols-2">
                  <Input
                    aria-label="Skill branch"
                    onChange={(event) => setBranch(event.target.value)}
                    placeholder="main"
                    value={branch}
                  />
                  <Input
                    aria-label="Skill path"
                    onChange={(event) => setSkillPath(event.target.value)}
                    placeholder="Optional repository path"
                    value={skillPath}
                  />
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

          <div className="mt-6 divide-y border-y">
            {data?.skills.map((skill) => (
              <div
                className="flex items-start justify-between gap-4 py-4"
                key={skill.installationId}
              >
                <div className="min-w-0">
                  <p className="font-medium">
                    {skill.revision?.name ?? "Pending skill"}
                  </p>
                  <p className="mt-1 text-muted-foreground text-sm">
                    {skill.revision?.description ?? skill.source.gitUrl}
                  </p>
                  <p className="mt-1 text-muted-foreground text-xs">
                    {skill.status}
                    {skill.revision?.commitSha
                      ? ` · ${skill.revision.commitSha.slice(0, 12)}`
                      : ""}
                  </p>
                  {skill.lastSyncError ? (
                    <p className="mt-1 text-destructive text-xs">
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
        </>
      )}
    </section>
  );
}
