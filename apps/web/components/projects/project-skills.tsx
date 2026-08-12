"use client";

import { Loader2, Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import {
  ResourceEmpty,
  ResourceList,
  ResourceRow,
} from "@/components/resource-list";
import { SettingsRowActionMenu } from "@/components/settings/settings-section";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
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
  init?: RequestInit,
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
    (url: string) => requestJson<WorkspaceSkillsResponse>(url),
  );
  const [gitUrl, setGitUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [skillPath, setSkillPath] = useState("");
  const [editingSkillId, setEditingSkillId] = useState<string>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [removeSkillId, setRemoveSkillId] = useState<string>();
  const [working, setWorking] = useState(false);

  function clearForm() {
    setGitUrl("");
    setBranch("main");
    setSkillPath("");
    setEditingSkillId(undefined);
    setEditorOpen(false);
  }

  function openCreate() {
    setGitUrl("");
    setBranch("main");
    setSkillPath("");
    setEditingSkillId(undefined);
    setEditorOpen(true);
  }

  function openEdit(skill: WorkspaceSkill) {
    setEditingSkillId(skill.installationId);
    setGitUrl(skill.source.gitUrl);
    setBranch(skill.source.branch);
    setSkillPath(skill.source.path ?? "");
    setEditorOpen(true);
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
          : "Skill saved. It will activate when the Project workspace is available.",
      );
    } catch (saveError) {
      toast.error(
        saveError instanceof Error
          ? saveError.message
          : "Skill installation failed.",
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
        { method: "POST" },
      );
      await mutate(result.body, { revalidate: false });
      toast.success(
        result.status === 202
          ? "Sync queued. Skills will activate when the Project workspace is available."
          : result.body.skills.some(
                (skill) =>
                  skill.status === "pending" || skill.status === "syncing",
              )
            ? "Sync queued. Pending skills will activate when the Project workspace is available."
            : "Agent skills synchronized.",
      );
    } catch (syncError) {
      toast.error(
        syncError instanceof Error
          ? syncError.message
          : "Skill synchronization failed.",
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
        { method: "DELETE" },
      );
      await mutate(result, { revalidate: false });
      if (editingSkillId === installationId) clearForm();
      setRemoveSkillId(undefined);
      toast.success("Agent skill removed.");
    } catch (removeError) {
      toast.error(
        removeError instanceof Error
          ? removeError.message
          : "Skill removal failed.",
      );
    } finally {
      setWorking(false);
    }
  }

  const skills = data?.skills ?? [];
  const syncRequired = skills.some(
    (skill) =>
      skill.status === "pending" ||
      skill.status === "stale" ||
      skill.status === "failed",
  );
  const skillToRemove = skills.find(
    (skill) => skill.installationId === removeSkillId,
  );

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
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2">
            {syncRequired ? (
              <Button
                disabled={working || isLoading}
                onClick={() => void syncSkills()}
                size="sm"
                variant="outline"
              >
                {working ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                Sync pending changes
              </Button>
            ) : null}
            <Button
              disabled={working || isLoading}
              onClick={openCreate}
              size="sm"
            >
              <Plus className="size-4" /> Add skill
            </Button>
          </div>
        ) : null}
      </div>

      {isLoading ? (
        <div className="mt-6 flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading Project skills…
        </div>
      ) : null}

      {error ? (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border-y py-4">
          <p className="text-destructive text-sm">
            Project skills could not be loaded. You can retry without starting a
            workspace.
          </p>
          <Button onClick={() => void mutate()} size="sm" variant="outline">
            Retry
          </Button>
        </div>
      ) : null}

      {isLoading || error ? null : (
        <div className="mt-6">
          {skills.length ? (
            <ResourceList>
              {skills.map((skill) => (
                <ResourceRow
                  actions={
                    canEdit ? (
                      <SettingsRowActionMenu
                        label={`Actions for ${skill.revision?.name ?? "pending skill"}`}
                      >
                        <DropdownMenuItem onSelect={() => openEdit(skill)}>
                          Edit source
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() =>
                            setRemoveSkillId(skill.installationId)
                          }
                          variant="destructive"
                        >
                          Remove skill
                        </DropdownMenuItem>
                      </SettingsRowActionMenu>
                    ) : undefined
                  }
                  description={
                    <div className="space-y-2">
                      {skill.revision?.description ? (
                        <p>{skill.revision.description}</p>
                      ) : (
                        <p>
                          Saved and waiting for the Project workspace to
                          activate it.
                        </p>
                      )}
                      {skill.lastSyncError ? (
                        <p className="text-destructive">
                          {skill.lastSyncError}
                        </p>
                      ) : null}
                      <details className="text-xs">
                        <summary className="cursor-pointer">
                          Inspect provenance
                        </summary>
                        <div className="mt-1 break-all font-mono text-xs/5">
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
                        </div>
                      </details>
                    </div>
                  }
                  key={skill.installationId}
                  metadata={
                    skill.revision?.commitSha
                      ? `Revision ${skill.revision.commitSha.slice(0, 12)}`
                      : undefined
                  }
                  status={
                    <Badge variant="outline">
                      {STATUS_LABELS[skill.status]}
                    </Badge>
                  }
                  title={skill.revision?.name ?? "Pending skill"}
                />
              ))}
            </ResourceList>
          ) : (
            <div className="border-y">
              <ResourceEmpty
                description="Add reusable guidance from a public HTTPS Git repository."
                title="No agent skills installed"
              />
            </div>
          )}
        </div>
      )}

      <Dialog
        onOpenChange={(open) => {
          if (open) setEditorOpen(true);
          else if (!working) clearForm();
        }}
        open={editorOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingSkillId === undefined ? "Add skill" : "Edit skill source"}
            </DialogTitle>
            <DialogDescription>
              Save a public HTTPS repository. Kestrel activates it when the
              Project workspace is available and idle.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="skill-git-url">Git repository URL</Label>
            <Input
              aria-label="Skill Git URL"
              id="skill-git-url"
              onChange={(event) => setGitUrl(event.target.value)}
              placeholder="https://github.com/org/skills.git"
              value={gitUrl}
            />
          </div>
          <details className="text-muted-foreground text-sm">
            <summary className="cursor-pointer">
              Advanced source options
            </summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
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
          <DialogFooter>
            <Button disabled={working} onClick={clearForm} variant="outline">
              Cancel
            </Button>
            <Button
              disabled={working || !gitUrl.trim() || !branch.trim()}
              onClick={() => void saveSkill()}
            >
              {working
                ? "Saving…"
                : editingSkillId === undefined
                  ? "Add skill"
                  : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        onOpenChange={(open) => {
          if (!(open || working)) setRemoveSkillId(undefined);
        }}
        open={Boolean(removeSkillId)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this skill?</AlertDialogTitle>
            <AlertDialogDescription>
              {skillToRemove?.revision?.name ?? "This skill"} will stop
              providing guidance to new Project runs. Its source repository is
              unchanged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={working}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={working || !removeSkillId}
              onClick={(event) => {
                event.preventDefault();
                if (removeSkillId) void removeSkill(removeSkillId);
              }}
            >
              {working ? "Removing…" : "Remove skill"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
