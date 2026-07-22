"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AppPage } from "@/components/app-page";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  AppConnectionResource,
  Environment,
  EnvironmentAppCapabilityGrant,
  EnvironmentWorkspace,
} from "@/drizzle/schema";

type WorkspaceSetup = {
  environments: Environment[];
  binding: { environmentId: string };
  workspace: EnvironmentWorkspace | null;
  repositories: AppConnectionResource[];
  grants: EnvironmentAppCapabilityGrant[];
};

type WorkspaceSkill = {
  installationId: string;
  status: "pending" | "syncing" | "ready" | "stale" | "failed" | "removal_pending";
  source: { gitUrl: string; branch: string; path?: string };
  revision?: { name: string; description: string; commitSha: string; contentDigest: string; skillFile: string };
  lastSyncError?: string;
};

export function ProjectWorkspaceClient({
  canEdit,
  projectId,
  projectName,
}: {
  canEdit: boolean;
  projectId: string;
  projectName: string;
}) {
  const [setup, setSetup] = useState<WorkspaceSetup | null>(null);
  const [environmentId, setEnvironmentId] = useState("");
  const [sourceType, setSourceType] = useState<"blank" | "github">("blank");
  const [resourceId, setResourceId] = useState("");
  const [skills, setSkills] = useState<WorkspaceSkill[]>([]);
  const [skillGitUrl, setSkillGitUrl] = useState("");
  const [skillBranch, setSkillBranch] = useState("main");
  const [skillPath, setSkillPath] = useState("");
  const [editingSkillId, setEditingSkillId] = useState<string>();
  const [skillBusy, setSkillBusy] = useState(false);

  useEffect(() => {
    void fetch(`/api/projects/${projectId}/workspace`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Project Workspace is unavailable.");
        const payload = (await response.json()) as WorkspaceSetup;
        setSetup(payload);
        setEnvironmentId(
          payload.binding.environmentId ??
            payload.workspace?.environmentId ??
            payload.environments[0]?.id ??
            ""
        );
        if (payload.workspace?.sourceType === "github") {
          setSourceType("github");
          setResourceId(payload.workspace.sourceResourceId ?? "");
        }
      })
      .catch((error: unknown) =>
        toast.error(
          error instanceof Error ? error.message : "Workspace unavailable."
        )
      );
  }, [projectId]);

  useEffect(() => {
    if (setup?.workspace?.status !== "ready") {
      setSkills([]);
      return;
    }
    void loadSkills().catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : "Workspace skills unavailable.")
    );
  }, [projectId, setup?.workspace?.id, setup?.workspace?.status]);

  const repositories = useMemo(() => {
    if (!setup) return [];
    const repositoryReadEnabled = setup.grants.some(
      (grant) =>
        grant.environmentId === environmentId &&
        grant.appKey === "github" &&
        grant.capabilityKey === "repository.read" &&
        grant.enabled &&
        grant.approvalMode !== "deny"
    );
    return repositoryReadEnabled ? setup.repositories : [];
  }, [environmentId, setup]);

  async function save() {
    if (!setup) return;
    if (setup.binding.environmentId !== environmentId) {
      const moveResponse = await fetch(
        `/api/projects/${projectId}/environment`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ environmentId }),
        }
      );
      const movePayload = (await moveResponse.json()) as {
        binding?: { environmentId: string };
        error?: string;
      };
      if (!(moveResponse.ok && movePayload.binding)) {
        toast.error(movePayload.error ?? "Project Environment move failed.");
        return;
      }
      setSetup((current) =>
        current ? { ...current, binding: movePayload.binding! } : current
      );
    }
    const response = await fetch(`/api/projects/${projectId}/workspace`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        environmentId,
        source:
          sourceType === "github"
            ? {
                type: "github",
                resourceId,
              }
            : { type: "blank" },
      }),
    });
    const payload = (await response.json()) as {
      workspace?: EnvironmentWorkspace;
      error?: string;
    };
    if (!(response.ok && payload.workspace)) {
      toast.error(payload.error ?? "Workspace setup failed.");
      return;
    }
    setSetup((current) =>
      current
        ? {
            ...current,
            binding: { environmentId },
            workspace: payload.workspace!,
          }
        : current
    );
    toast.success(
      setup.binding.environmentId === environmentId
        ? "Project Workspace provisioning requested."
        : "Project Environment moved and its new Workspace was requested."
    );
  }

  async function loadSkills() {
    const response = await fetch(`/api/projects/${projectId}/workspace/skills`, { cache: "no-store" });
    const payload = (await response.json()) as { skills?: WorkspaceSkill[]; error?: string };
    if (!response.ok) throw new Error(payload.error ?? "Workspace skills unavailable.");
    setSkills(payload.skills ?? []);
  }

  async function installSkill() {
    setSkillBusy(true);
    try {
      const endpoint = editingSkillId === undefined
        ? `/api/projects/${projectId}/workspace/skills`
        : `/api/projects/${projectId}/workspace/skills/${encodeURIComponent(editingSkillId)}`;
      const response = await fetch(endpoint, {
        method: editingSkillId === undefined ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          gitUrl: skillGitUrl.trim(),
          branch: skillBranch.trim(),
          ...(skillPath.trim() ? { path: skillPath.trim() } : {}),
        }),
      });
      const payload = (await response.json()) as { skill?: WorkspaceSkill; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Skill installation failed.");
      await loadSkills();
      setSkillGitUrl("");
      setSkillBranch("main");
      setSkillPath("");
      setEditingSkillId(undefined);
      toast.success(payload.skill?.status === "ready" ? "Workspace skill is ready." : "Workspace skill source saved; synchronization is pending or degraded.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Skill installation failed.");
    } finally {
      setSkillBusy(false);
    }
  }

  async function syncSkills() {
    setSkillBusy(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/workspace/skills/sync`, { method: "POST" });
      const payload = (await response.json()) as { skills?: WorkspaceSkill[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Skill synchronization failed.");
      setSkills(payload.skills ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Skill synchronization failed.");
    } finally {
      setSkillBusy(false);
    }
  }

  async function removeSkill(installationId: string) {
    setSkillBusy(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/workspace/skills/${encodeURIComponent(installationId)}`, { method: "DELETE" });
      const payload = (await response.json()) as { skills?: WorkspaceSkill[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Skill removal failed.");
      setSkills(payload.skills ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Skill removal failed.");
    } finally {
      setSkillBusy(false);
    }
  }

  return (
    <AppPage className="max-w-3xl">
      <div className="mb-6">
        <Button asChild size="sm" variant="ghost">
          <Link href={`/projects/${projectId}`}>← {projectName}</Link>
        </Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Project Workspace</CardTitle>
          <p className="text-muted-foreground text-sm">
            Choose the organization Environment and the persistent filesystem
            source used by every Thread in this Project.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label>Environment</Label>
            <Select
              disabled={!canEdit}
              onValueChange={setEnvironmentId}
              value={environmentId}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select Environment" />
              </SelectTrigger>
              <SelectContent>
                {setup?.environments.map((environment) => (
                  <SelectItem key={environment.id} value={environment.id}>
                    {environment.name} · {environment.region}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Source</Label>
            <Select
              disabled={
                !canEdit ||
                Boolean(
                  setup?.workspace &&
                    setup.workspace.environmentId === environmentId &&
                    setup.workspace.status !== "requested"
                )
              }
              onValueChange={(value) =>
                setSourceType(value as "blank" | "github")
              }
              value={sourceType}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="blank">Blank Workspace</SelectItem>
                <SelectItem value="github">GitHub repository</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {sourceType === "github" ? (
            <div className="space-y-2">
              <Label>Repository granted to this Environment</Label>
              <Select
                disabled={!canEdit}
                onValueChange={setResourceId}
                value={resourceId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select repository" />
                </SelectTrigger>
                <SelectContent>
                  {repositories.map((repository) => (
                    <SelectItem key={repository.id} value={repository.id}>
                      {repository.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="flex items-center justify-between border-t pt-4">
            <div className="text-muted-foreground text-sm">
              {setup?.workspace
                ? setup.binding.environmentId === environmentId
                  ? `Status: ${setup.workspace.status}`
                  : "Moving creates an isolated Workspace in the selected Environment. Active runs block the move."
                : "The Workspace will be created lazily and retained across Threads."}
            </div>
            <Button
              disabled={
                !(canEdit && environmentId) ||
                (sourceType === "github" && !resourceId)
              }
              onClick={() => void save()}
            >
              {setup?.binding.environmentId === environmentId
                ? "Configure Workspace"
                : "Move and Configure"}
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card className="mt-6">
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle>Agent skills</CardTitle>
              <p className="text-muted-foreground mt-1 text-sm">
                Install guidance packages from public HTTPS Git repositories. Skills never grant permissions or run install hooks.
              </p>
            </div>
            <Button disabled={!canEdit || skillBusy || setup?.workspace?.status !== "ready"} variant="outline" onClick={() => void syncSkills()}>
              Sync
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {setup?.workspace?.status !== "ready" ? (
            <p className="text-muted-foreground text-sm">Start the Project Workspace to install or inspect its skills.</p>
          ) : (
            <>
              <div className="grid gap-3 md:grid-cols-[2fr_1fr_1fr_auto]">
                <input className="border-input bg-background h-9 rounded-md border px-3 text-sm" aria-label="Skill Git URL" placeholder="https://github.com/org/skills.git" value={skillGitUrl} onChange={(event) => setSkillGitUrl(event.target.value)} />
                <input className="border-input bg-background h-9 rounded-md border px-3 text-sm" aria-label="Skill branch" placeholder="main" value={skillBranch} onChange={(event) => setSkillBranch(event.target.value)} />
                <input className="border-input bg-background h-9 rounded-md border px-3 text-sm" aria-label="Skill path" placeholder="Optional path" value={skillPath} onChange={(event) => setSkillPath(event.target.value)} />
                <Button disabled={!canEdit || skillBusy || !skillGitUrl.trim() || !skillBranch.trim()} onClick={() => void installSkill()}>
                  {editingSkillId === undefined ? "Install" : "Update"}
                </Button>
              </div>
              {editingSkillId !== undefined ? (
                <Button size="sm" variant="ghost" onClick={() => {
                  setEditingSkillId(undefined);
                  setSkillGitUrl("");
                  setSkillBranch("main");
                  setSkillPath("");
                }}>Cancel edit</Button>
              ) : null}
              <div className="space-y-2">
                {skills.map((skill) => (
                  <div className="flex items-start justify-between gap-4 rounded-md border p-3" key={skill.installationId}>
                    <div className="min-w-0">
                      <div className="font-medium">{skill.revision?.name ?? "Pending skill"}</div>
                      <div className="text-muted-foreground text-sm">{skill.revision?.description ?? skill.source.gitUrl}</div>
                      <div className="text-muted-foreground mt-1 text-xs">
                        {skill.status}{skill.revision?.commitSha ? ` · ${skill.revision.commitSha.slice(0, 12)} · ${skill.revision.contentDigest}` : ""}
                      </div>
                      {skill.lastSyncError ? <div className="text-destructive mt-1 text-xs">{skill.lastSyncError}</div> : null}
                      <details className="text-muted-foreground mt-2 text-xs">
                        <summary>Inspect</summary>
                        <div>Source: {skill.source.gitUrl}</div>
                        <div>Branch: {skill.source.branch}{skill.source.path ? ` · ${skill.source.path}` : ""}</div>
                        {skill.revision ? <div>Commit: {skill.revision.commitSha}</div> : null}
                        {skill.revision ? <div>Digest: {skill.revision.contentDigest}</div> : null}
                        {skill.revision ? <div>Instructions: {skill.revision.skillFile}</div> : null}
                      </details>
                    </div>
                    <div className="flex gap-2">
                      <Button disabled={!canEdit || skillBusy} size="sm" variant="outline" onClick={() => {
                        setEditingSkillId(skill.installationId);
                        setSkillGitUrl(skill.source.gitUrl);
                        setSkillBranch(skill.source.branch);
                        setSkillPath(skill.source.path ?? "");
                      }}>Edit</Button>
                      <Button disabled={!canEdit || skillBusy} size="sm" variant="outline" onClick={() => void removeSkill(skill.installationId)}>Remove</Button>
                    </div>
                  </div>
                ))}
                {skills.length === 0 ? <p className="text-muted-foreground text-sm">No workspace skills installed.</p> : null}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </AppPage>
  );
}
