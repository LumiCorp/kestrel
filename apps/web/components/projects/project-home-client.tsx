"use client";

import {
  Archive,
  MessageSquare,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
  }>;
};

export function ProjectHomeClient({ initial }: { initial: ProjectHomeData }) {
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const canEdit = initial.role === "owner" || initial.role === "editor";
  const [name, setName] = useState(initial.project.name);
  const [description, setDescription] = useState(
    initial.project.description ?? ""
  );
  const [instructions, setInstructions] = useState(
    initial.contextRevision?.instructions ?? ""
  );
  const [revision, setRevision] = useState(
    initial.project.currentContextRevision
  );
  const [selectedDocumentIds, setSelectedDocumentIds] = useState(() =>
    initial.documents.map((document) => document.id)
  );
  const [members, setMembers] = useState(initial.members);
  const [candidateId, setCandidateId] = useState("");
  const [candidateRole, setCandidateRole] = useState<Role>("member");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
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
    [members]
  );
  const candidates = initial.organizationMembers.filter(
    (member) => !memberIds.has(member.organizationMemberId)
  );

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
        }
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
        `Project context revision ${result.contextRevision.revision} saved`
      );
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Project context could not be saved."
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
        { method: "POST", body: formData }
      );
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(result.error || "File upload failed.");
      }
      toast.success(
        "Project file uploaded and added to a new context revision"
      );
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "File upload failed."
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
      }
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
      }
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
          : member
      )
    );
    toast.success("Member role updated");
  }

  async function removeMember(organizationMemberId: string) {
    const response = await fetch(
      `/api/projects/${initial.project.id}/members/${organizationMemberId}`,
      { method: "DELETE" }
    );
    const result = (await response.json()) as { error?: string };
    if (!response.ok) {
      toast.error(result.error || "Member could not be removed.");
      return;
    }
    setMembers((current) =>
      current.filter(
        (member) => member.organizationMemberId !== organizationMemberId
      )
    );
    toast.success("Project member removed");
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
      mutate("/api/threads?limit=30"),
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
      mutate("/api/threads?limit=30"),
    ]);
    router.push("/projects");
    router.refresh();
  }

  return (
    <>
      <Tabs defaultValue="overview">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="context">Context</TabsTrigger>
            <TabsTrigger value="members">Members</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>
          <div className="flex gap-2">
            {!initial.project.archivedAt && (
              <Button asChild>
                <Link href={`/projects/${initial.project.id}/threads/new`}>
                  <Plus className="size-4" /> New Thread
                </Link>
              </Button>
            )}
            {initial.role === "owner" &&
              (initial.project.archivedAt ? (
                <>
                  <Button
                    onClick={() => void setArchived(false)}
                    variant="outline"
                  >
                    <RotateCcw className="size-4" /> Restore
                  </Button>
                  <Button
                    onClick={() => setDeleteDialogOpen(true)}
                    variant="destructive"
                  >
                    <Trash2 className="size-4" /> Delete permanently
                  </Button>
                </>
              ) : (
                <Button
                  onClick={() => void setArchived(true)}
                  variant="outline"
                >
                  <Archive className="size-4" /> Archive
                </Button>
              ))}
          </div>
        </div>

        <TabsContent className="space-y-4" value="overview">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {initial.threads.map((thread) => (
              <Link href={`/threads/${thread.id}`} key={thread.id}>
                <Card className="h-full hover:bg-muted/40">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <MessageSquare className="size-4" />
                      {thread.title || "New thread"}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-muted-foreground text-sm">
                    {thread.archivedAt ? "Archived" : "Updated"}{" "}
                    {new Date(
                      thread.archivedAt || thread.updatedAt
                    ).toLocaleString()}
                  </CardContent>
                </Card>
              </Link>
            ))}
            {!initial.threads.length && (
              <Card className="md:col-span-2">
                <CardContent className="py-12 text-center text-muted-foreground">
                  No Project Threads yet.
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        <TabsContent
          className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]"
          value="context"
        >
          <Card>
            <CardHeader>
              <CardTitle>Instructions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="project-name">Name</Label>
                <Input
                  disabled={!canEdit}
                  id="project-name"
                  onChange={(event) => setName(event.target.value)}
                  value={name}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="project-description">Description</Label>
                <Input
                  disabled={!canEdit}
                  id="project-description"
                  onChange={(event) => setDescription(event.target.value)}
                  value={description}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="project-instructions">
                  Project instructions
                </Label>
                <Textarea
                  disabled={!canEdit}
                  id="project-instructions"
                  onChange={(event) => setInstructions(event.target.value)}
                  rows={12}
                  value={instructions}
                />
              </div>
              {canEdit && (
                <Button
                  disabled={saving || !name.trim()}
                  onClick={() => void saveContext()}
                >
                  {saving ? "Saving…" : `Save revision ${revision + 1}`}
                </Button>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Knowledge and files</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {availableDocuments.map((document) => (
                <div
                  className="flex items-start gap-3 text-sm"
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
                          : current.filter((id) => id !== document.id)
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
                <p className="text-muted-foreground text-sm">
                  No files or organization Knowledge selected.
                </p>
              )}
              {canEdit && (
                <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed p-4 text-sm hover:bg-muted">
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
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="members">
          <Card>
            <CardHeader>
              <CardTitle>Project members</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {members.map((member) => (
                <div
                  className="flex flex-wrap items-center justify-between gap-3 border-b pb-3 last:border-0"
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
                          void updateMember(member.organizationMemberId, role)
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
                        onClick={() =>
                          void removeMember(member.organizationMemberId)
                        }
                        size="icon"
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
              {initial.role === "owner" && candidates.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-2">
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
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="activity">
          <Card>
            <CardHeader>
              <CardTitle>Project audit activity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {initial.auditEvents.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No Project activity has been recorded.
                </p>
              ) : (
                initial.auditEvents.map((event) => (
                  <div
                    className="grid gap-1 rounded-md border p-3 text-sm sm:grid-cols-[1fr_auto]"
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
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
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
