"use client";

import {
  Archive,
  Copy,
  ExternalLink,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Settings2,
  Trash2,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
import { PageHeader } from "@/components/page-header";
import { ProjectApps } from "@/components/projects/project-apps";
import { ProjectSkills } from "@/components/projects/project-skills";
import {
  ResourceEmpty,
  ResourceList,
  ResourceRow,
} from "@/components/resource-list";
import {
  SettingsRow,
  SettingsRows,
  SettingsSection,
} from "@/components/settings/settings-section";
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
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { TimeText } from "@/components/ui/time-text";
import {
  projectTabHref,
  resolveProjectTab,
  type ProjectTab,
} from "@/lib/projects/project-tabs";
import {
  getProjectSavePresentation,
  getProjectSurfaceAccess,
  partitionProjectThreads,
} from "@/lib/projects/project-presentation";

type Role = "owner" | "editor" | "member";
type DocumentItem = {
  id: string;
  filename: string;
  title: string | null;
  status: string;
  scope?: "organization" | "project";
};

export type ProjectHomeData = {
  project: {
    id: string;
    name: string;
    description: string | null;
    currentContextRevision: number;
    environmentId: string;
    archivedAt: string | null;
  };
  role: Role;
  contextRevision: { instructions: string } | null;
  documents: DocumentItem[];
  organizationDocuments: DocumentItem[];
  members: Array<{
    organizationMemberId: string;
    userId: string;
    name: string;
    email: string;
    role: Role;
  }>;
  organizationMembers: Array<{
    organizationMemberId: string;
    userId: string;
    name: string;
    email: string;
  }>;
  auditEvents: Array<{
    id: string;
    actorUserId: string | null;
    action: string;
    targetType: string | null;
    targetId: string | null;
    createdAt: string;
  }>;
  threads: Array<{
    id: string;
    title: string;
    updatedAt: string;
    archivedAt: string | null;
    canManage: boolean;
  }>;
  previews: Array<{
    id: string;
    name: string;
    expiresAt: string;
  }>;
};

export function ProjectHomeClient({ initial }: { initial: ProjectHomeData }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { mutate } = useSWRConfig();
  const surfaceAccess = getProjectSurfaceAccess({
    role: initial.role,
    archivedAt: initial.project.archivedAt,
  });
  const canEdit = surfaceAccess.canEdit;
  const [name, setName] = useState(initial.project.name);
  const [description, setDescription] = useState(
    initial.project.description ?? "",
  );
  const [instructions, setInstructions] = useState(
    initial.contextRevision?.instructions ?? "",
  );
  const [revision, setRevision] = useState(
    initial.project.currentContextRevision,
  );
  const [selectedDocumentIds, setSelectedDocumentIds] = useState(() =>
    initial.documents.map((document) => document.id),
  );
  const [members, setMembers] = useState(initial.members);
  const [candidateId, setCandidateId] = useState("");
  const [candidateRole, setCandidateRole] = useState<Role>("member");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [memberRemoval, setMemberRemoval] = useState<
    ProjectHomeData["members"][number] | null
  >(null);
  const [memberRemovalBusy, setMemberRemovalBusy] = useState(false);
  const [memberRemovalError, setMemberRemovalError] = useState<string>();
  const memberRemovalTriggerRef = useRef<HTMLButtonElement | null>(null);
  const membersFallbackFocusRef = useRef<HTMLDivElement | null>(null);
  const [threadActionId, setThreadActionId] = useState<string | null>(null);
  const activeTab = resolveProjectTab({
    tab: searchParams.get("tab"),
    hasGoogle: searchParams.has("google"),
  });
  const availableDocuments = useMemo(() => {
    const byId = new Map<string, DocumentItem>();
    for (const document of [
      ...initial.documents,
      ...initial.organizationDocuments,
    ]) {
      byId.set(document.id, document);
    }
    return [...byId.values()];
  }, [initial.documents, initial.organizationDocuments]);
  const memberIds = useMemo(
    () => new Set(members.map((member) => member.organizationMemberId)),
    [members],
  );
  const candidates = initial.organizationMembers.filter(
    (member) => !memberIds.has(member.organizationMemberId),
  );
  const { activeThreads, archivedThreads } = partitionProjectThreads(
    initial.threads,
  );
  const savePresentation = getProjectSavePresentation({
    canEdit,
    saving,
    name,
    revision,
  });

  async function setThreadArchived(threadId: string, archived: boolean) {
    setThreadActionId(threadId);
    try {
      const response = await fetch(`/api/threads/${threadId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(result.error ?? "Thread could not be updated.");
      }
      toast.success(archived ? "Thread archived." : "Thread restored.");
      await mutate(
        `/api/threads?project_id=${initial.project.id}&limit=100`,
      );
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Thread could not be updated.",
      );
    } finally {
      setThreadActionId(null);
    }
  }

  async function duplicateThread(threadId: string) {
    setThreadActionId(threadId);
    try {
      const response = await fetch(`/api/threads/${threadId}/duplicate`, {
        method: "POST",
      });
      const result = (await response.json()) as {
        thread?: { id: string };
        error?: string;
      };
      if (!(response.ok && result.thread)) {
        throw new Error(result.error ?? "Thread could not be duplicated.");
      }
      toast.success("Thread duplicated.");
      await mutate(
        `/api/threads?project_id=${initial.project.id}&limit=100`,
      );
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Thread could not be duplicated.",
      );
    } finally {
      setThreadActionId(null);
    }
  }

  async function saveContext() {
    setSaving(true);
    try {
      const response = await fetch(
        `/api/projects/${initial.project.id}/context`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedRevision: revision,
            name,
            description: description || null,
            instructions,
            documentIds: selectedDocumentIds,
          }),
        },
      );
      const result = (await response.json()) as {
        contextRevision?: { revision: number };
        error?: string;
      };
      if (!(response.ok && result.contextRevision)) {
        throw new Error(result.error || "Project context could not be saved.");
      }
      setRevision(result.contextRevision.revision);
      toast.success(
        `Project context revision ${result.contextRevision.revision} saved`,
      );
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Project context could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function uploadFile(file: File) {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.set("file", file);
      const response = await fetch(
        `/api/projects/${initial.project.id}/files`,
        { method: "POST", body: formData },
      );
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(result.error || "File upload failed.");
      }
      toast.success(
        "Project file uploaded and added to a new context revision",
      );
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "File upload failed.",
      );
    } finally {
      setUploading(false);
    }
  }

  async function addMember() {
    if (!candidateId) return;
    const response = await fetch(
      `/api/projects/${initial.project.id}/members`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationMemberId: candidateId,
          role: candidateRole,
        }),
      },
    );
    const result = (await response.json()) as { error?: string };
    if (!response.ok) {
      toast.error(result.error || "Member could not be added.");
      return;
    }
    toast.success("Project member added");
    router.refresh();
  }

  async function updateMember(organizationMemberId: string, role: Role) {
    const response = await fetch(
      `/api/projects/${initial.project.id}/members`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationMemberId, role }),
      },
    );
    const result = (await response.json()) as { error?: string };
    if (!response.ok) {
      toast.error(result.error || "Member role could not be changed.");
      return;
    }
    setMembers((current) =>
      current.map((member) =>
        member.organizationMemberId === organizationMemberId
          ? { ...member, role }
          : member,
      ),
    );
    toast.success("Member role updated");
  }

  async function removeMember() {
    if (!memberRemoval) return;
    const member = memberRemoval;
    setMemberRemovalBusy(true);
    setMemberRemovalError(undefined);
    try {
      const response = await fetch(
        `/api/projects/${initial.project.id}/members/${member.organizationMemberId}`,
        { method: "DELETE" },
      );
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        setMemberRemovalError(
          result.error || "Member could not be removed.",
        );
        return;
      }
      setMembers((current) =>
        current.filter(
          (currentMember) =>
            currentMember.organizationMemberId !== member.organizationMemberId,
        ),
      );
      toast.success("Project member removed");
      setMemberRemoval(null);
    } catch {
      setMemberRemovalError("Member could not be removed.");
    } finally {
      setMemberRemovalBusy(false);
    }
  }

  async function setArchived(archived: boolean) {
    const response = await fetch(`/api/projects/${initial.project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived }),
    });
    if (!response.ok) {
      const result = (await response.json()) as { error?: string };
      toast.error(result.error || "Project lifecycle update failed.");
      return;
    }
    toast.success(archived ? "Project archived" : "Project restored");
    await Promise.all([
      mutate("/api/projects"),
      mutate(`/api/threads?project_id=${initial.project.id}&limit=100`),
    ]);
    router.push(archived ? "/projects" : `/projects/${initial.project.id}`);
    router.refresh();
  }

  async function permanentlyDelete() {
    const response = await fetch(`/api/projects/${initial.project.id}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      const result = (await response.json()) as { error?: string };
      toast.error(result.error || "Project could not be deleted.");
      return;
    }
    toast.success("Project permanently deleted");
    await Promise.all([
      mutate("/api/projects"),
      mutate(`/api/threads?project_id=${initial.project.id}&limit=100`),
    ]);
    router.push("/projects");
    router.refresh();
  }

  async function openProtectedPreview(previewId: string) {
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    const response = await fetch(`/api/previews/${previewId}/access`, {
      method: "POST",
    });
    if (!response.ok) {
      popup?.close();
      toast.error("Preview access could not be authorized.");
      return;
    }
    const result = (await response.json()) as { publicUrl: string };
    if (popup) popup.location.href = result.publicUrl;
    else window.location.href = result.publicUrl;
  }

  function renderThreadRow(thread: ProjectHomeData["threads"][number]) {
    const displayTitle = thread.title || "New thread";
    const activityAt = thread.archivedAt || thread.updatedAt;

    return (
      <ResourceRow
        actions={
          thread.canManage ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label={`Thread actions for ${displayTitle}`}
                  className="text-muted-foreground"
                  disabled={threadActionId !== null}
                  size="icon-sm"
                  variant="ghost"
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={threadActionId !== null}
                  onSelect={() => void duplicateThread(thread.id)}
                >
                  <Copy className="size-4" /> Duplicate Thread
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={threadActionId !== null}
                  onSelect={() =>
                    void setThreadArchived(thread.id, !thread.archivedAt)
                  }
                >
                  {thread.archivedAt ? (
                    <RotateCcw className="size-4" />
                  ) : (
                    <Archive className="size-4" />
                  )}
                  {thread.archivedAt ? "Restore Thread" : "Archive Thread"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null
        }
        href={`/threads/${thread.id}`}
        key={thread.id}
        status={
          <span className="hidden text-muted-foreground text-xs sm:inline">
            {thread.archivedAt ? "Archived" : "Updated"}{" "}
            <TimeText mode="relative" value={activityAt} />
          </span>
        }
        title={displayTitle}
      />
    );
  }

  return (
    <>
      <div className="border-b pb-5">
        <PageHeader
          actions={
            <>
              {surfaceAccess.canCreateThread ? (
                <Button asChild>
                  <Link href={`/projects/${initial.project.id}/threads/new`}>
                    <Plus className="size-4" /> New Thread
                  </Link>
                </Button>
              ) : null}
              {surfaceAccess.hasProjectActions ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      aria-label="Project actions"
                      size="icon"
                      variant="outline"
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {surfaceAccess.canConfigureWorkspace ? (
                      <DropdownMenuItem asChild>
                        <Link href={`/projects/${initial.project.id}/workspace`}>
                          <Settings2 className="size-4" /> Configure Workspace
                        </Link>
                      </DropdownMenuItem>
                    ) : null}
                    {surfaceAccess.canConfigureWorkspace &&
                    surfaceAccess.canArchive ? (
                      <DropdownMenuSeparator />
                    ) : null}
                    {surfaceAccess.canRestore ? (
                      <>
                        <DropdownMenuItem
                          onSelect={() => void setArchived(false)}
                        >
                          <RotateCcw className="size-4" /> Restore Project
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onSelect={() => setDeleteDialogOpen(true)}
                          variant="destructive"
                        >
                          <Trash2 className="size-4" /> Delete Project
                        </DropdownMenuItem>
                      </>
                    ) : surfaceAccess.canArchive ? (
                      <DropdownMenuItem
                        onSelect={() => void setArchived(true)}
                      >
                        <Archive className="size-4" /> Archive Project
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </>
          }
          description={
            initial.project.description || "Shared Project workspace"
          }
          eyebrow="Project"
          status={
            <p className="text-muted-foreground text-xs">
              {initial.project.archivedAt ? (
                <>
                  Archived <span aria-hidden="true">·</span>{" "}
                </>
              ) : null}
              <span className="capitalize">{initial.role}</span>{" "}
              <span aria-hidden="true">·</span> Context revision{" "}
              {initial.project.currentContextRevision}
            </p>
          }
          title={initial.project.name}
        />
      </div>
      <Tabs
        onValueChange={(value) =>
          router.push(
            projectTabHref(
              initial.project.id,
              resolveProjectTab({ tab: value, hasGoogle: false }),
            ),
          )
        }
        value={activeTab}
      >
        <div className="no-visible-scrollbar overflow-x-auto border-b pb-4 md:hidden">
          <TabsList className="h-9 w-max bg-transparent p-0 md:hidden">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="context">Context</TabsTrigger>
            <TabsTrigger value="members">Members</TabsTrigger>
            <TabsTrigger value="apps">Apps</TabsTrigger>
            <TabsTrigger value="skills">Skills</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview">
          <section className="mt-6" aria-labelledby="active-project-threads">
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h2 className="font-medium" id="active-project-threads">
                Active Threads
              </h2>
              <span className="text-muted-foreground text-xs tabular-nums">
                {activeThreads.length}
              </span>
            </div>
            <ResourceList>
              {activeThreads.map(renderThreadRow)}
              {activeThreads.length === 0 ? (
                <div role="listitem">
                  <ResourceEmpty title="No active Threads in this Project" />
                </div>
              ) : null}
            </ResourceList>
            {archivedThreads.length > 0 ? (
              <details className="border-b text-sm">
                <summary className="cursor-pointer py-3 text-muted-foreground hover:text-foreground">
                  Archived Threads ({archivedThreads.length})
                </summary>
                <ResourceList className="border-b-0">
                  {archivedThreads.map(renderThreadRow)}
                </ResourceList>
              </details>
            ) : null}
          </section>
          {initial.previews.length > 0 ? (
            <section className="mt-8" aria-labelledby="published-previews">
              <div className="mb-3">
                <h2 className="font-medium" id="published-previews">
                  Published Desktop previews
                </h2>
                <p className="mt-1 text-muted-foreground text-sm">
                  Access follows current Project membership.
                </p>
              </div>
              <ResourceList>
                {initial.previews.map((preview) => (
                  <ResourceRow
                    actions={
                      <Button
                        onClick={() => void openProtectedPreview(preview.id)}
                        size="sm"
                        variant="outline"
                      >
                        <ExternalLink className="size-4" /> Open
                      </Button>
                    }
                    key={preview.id}
                    metadata={
                      <>
                        Expires{" "}
                        <TimeText mode="relative" value={preview.expiresAt} />
                      </>
                    }
                    title={preview.name}
                  />
                ))}
              </ResourceList>
            </section>
          ) : null}
        </TabsContent>

        <TabsContent value="context">
          <SettingsSection
            description="The durable identity shown throughout Kestrel One."
            title="Project details"
          >
            <SettingsRows>
              <SettingsRow label="Name">
                <Input
                  disabled={!canEdit}
                  id="project-name"
                  onChange={(event) => setName(event.target.value)}
                  value={name}
                />
              </SettingsRow>
              <SettingsRow label="Description">
                <Input
                  disabled={!canEdit}
                  id="project-description"
                  onChange={(event) => setDescription(event.target.value)}
                  value={description}
                />
              </SettingsRow>
            </SettingsRows>
          </SettingsSection>
          <SettingsSection
            description={`Live instructions for future turns. Saving creates context revision ${revision + 1}.`}
            title="Agent context"
          >
            <div className="space-y-3">
              <Label className="sr-only" htmlFor="project-instructions">
                Project instructions
              </Label>
              <Textarea
                disabled={!canEdit}
                id="project-instructions"
                onChange={(event) => setInstructions(event.target.value)}
                rows={12}
                value={instructions}
              />
              {canEdit && (
                <Button
                  disabled={savePresentation.disabled}
                  onClick={() => void saveContext()}
                >
                  {savePresentation.label}
                </Button>
              )}
            </div>
          </SettingsSection>
          <SettingsSection
            description="Select organization Knowledge or private files made available to this Project."
            title="Knowledge and files"
          >
            <div className="divide-y border-y">
              {availableDocuments.map((document) => (
                <div
                  className="flex items-start gap-3 py-3 text-sm"
                  key={document.id}
                >
                  <Checkbox
                    checked={selectedDocumentIds.includes(document.id)}
                    disabled={!canEdit}
                    id={`project-document-${document.id}`}
                    onCheckedChange={(checked) =>
                      setSelectedDocumentIds((current) =>
                        checked
                          ? [...new Set([...current, document.id])]
                          : current.filter((id) => id !== document.id),
                      )
                    }
                  />
                  <Label htmlFor={`project-document-${document.id}`}>
                    <span className="block font-medium">
                      {document.title || document.filename}
                    </span>
                    <span className="text-muted-foreground">
                      {document.scope === "project"
                        ? "Project file"
                        : "Organization Knowledge"}{" "}
                      · {document.status}
                    </span>
                  </Label>
                </div>
              ))}
              {!availableDocuments.length && (
                <p className="py-6 text-center text-muted-foreground text-sm">
                  No files or organization Knowledge selected.
                </p>
              )}
            </div>
            {canEdit && (
              <label className="mt-3 flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed p-3 text-sm hover:bg-muted">
                <Upload className="size-4" />
                {uploading ? "Uploading…" : "Upload private Project file"}
                <input
                  className="sr-only"
                  disabled={uploading}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadFile(file);
                  }}
                  type="file"
                />
              </label>
            )}
          </SettingsSection>
        </TabsContent>

        <TabsContent value="members">
          <SettingsSection
            description="Project roles control context, membership, and publishing access."
            title="Project members"
          >
            <div
              aria-label="Project members"
              className="focus:outline-none"
              ref={membersFallbackFocusRef}
              tabIndex={-1}
            >
              <div className="divide-y border-y">
                {members.map((member) => (
                  <div
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                    key={member.organizationMemberId}
                  >
                    <div>
                      <p className="font-medium">{member.name}</p>
                      <p className="text-muted-foreground text-sm">
                        {member.email}
                      </p>
                    </div>
                    {initial.role === "owner" ? (
                      <div className="flex items-center gap-2">
                        <Select
                          onValueChange={(role: Role) =>
                            void updateMember(
                              member.organizationMemberId,
                              role,
                            )
                          }
                          value={member.role}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="owner">Owner</SelectItem>
                            <SelectItem value="editor">Editor</SelectItem>
                            <SelectItem value="member">Member</SelectItem>
                          </SelectContent>
                        </Select>
                        <Button
                          aria-label={`Remove ${member.name}`}
                          onClick={(event) => {
                            memberRemovalTriggerRef.current =
                              event.currentTarget;
                            setMemberRemovalError(undefined);
                            setMemberRemoval(member);
                          }}
                          size="icon"
                          type="button"
                          variant="ghost"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    ) : (
                      <span className="text-muted-foreground text-sm capitalize">
                        {member.role}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              {initial.role === "owner" && candidates.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-4">
                  <Select onValueChange={setCandidateId} value={candidateId}>
                    <SelectTrigger className="min-w-64">
                      <SelectValue placeholder="Choose organization member" />
                    </SelectTrigger>
                    <SelectContent>
                      {candidates.map((member) => (
                        <SelectItem
                          key={member.organizationMemberId}
                          value={member.organizationMemberId}
                        >
                          {member.name} · {member.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    onValueChange={(role: Role) => setCandidateRole(role)}
                    value={candidateRole}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="owner">Owner</SelectItem>
                      <SelectItem value="editor">Editor</SelectItem>
                      <SelectItem value="member">Member</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    disabled={!candidateId}
                    onClick={() => void addMember()}
                  >
                    <Plus className="size-4" /> Add
                  </Button>
                </div>
              )}
            </div>
          </SettingsSection>
        </TabsContent>

        <TabsContent value="apps">
          <ProjectApps canEdit={canEdit} projectId={initial.project.id} />
        </TabsContent>

        <TabsContent value="skills">
          <ProjectSkills canEdit={canEdit} projectId={initial.project.id} />
        </TabsContent>

        <TabsContent value="activity">
          <SettingsSection
            description="A chronological record of meaningful Project configuration changes."
            title="Audit activity"
          >
            <div className="divide-y border-y">
              {initial.auditEvents.length === 0 ? (
                <p className="py-6 text-center text-muted-foreground text-sm">
                  No Project activity has been recorded.
                </p>
              ) : (
                initial.auditEvents.map((event) => (
                  <div
                    className="grid gap-1 py-3 text-sm sm:grid-cols-[1fr_auto]"
                    key={event.id}
                  >
                    <span>{event.action}</span>
                    <time className="text-muted-foreground sm:text-right">
                      {new Date(event.createdAt).toLocaleString()}
                    </time>
                    <span className="truncate font-mono text-muted-foreground text-xs sm:col-span-2">
                      {event.targetType ?? "project"}
                      {event.targetId ? ` · ${event.targetId}` : ""}
                    </span>
                  </div>
                ))
              )}
            </div>
          </SettingsSection>
        </TabsContent>
      </Tabs>
      <AlertDialog
        onOpenChange={(open) => {
          if (memberRemovalBusy) return;
          if (!open) {
            setMemberRemoval(null);
            setMemberRemovalError(undefined);
          }
        }}
        open={Boolean(memberRemoval)}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const trigger = memberRemovalTriggerRef.current;
            const focusTarget = trigger?.isConnected
              ? trigger
              : membersFallbackFocusRef.current;
            focusTarget?.focus();
            memberRemovalTriggerRef.current = null;
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {memberRemoval?.name} from this Project?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They will lose access to this Project, its Threads, and its
              Project-owned files. You can add them again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {memberRemovalError ? (
            <p className="text-destructive text-sm" role="alert">
              {memberRemovalError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={memberRemovalBusy}>
              Cancel
            </AlertDialogCancel>
            <Button
              disabled={memberRemovalBusy}
              onClick={() => void removeMember()}
              variant="destructive"
            >
              {memberRemovalBusy ? "Removing…" : "Remove member"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog onOpenChange={setDeleteDialogOpen} open={deleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Permanently delete this Project?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This deletes its Threads and Project-owned files. Organization
              Knowledge is only unlinked. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void permanentlyDelete()}>
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
