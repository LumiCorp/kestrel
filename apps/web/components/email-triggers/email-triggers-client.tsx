"use client";

import {
  Copy,
  MailPlus,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import {
  ResourceEmpty,
  ResourceList,
  ResourceRow,
} from "@/components/resource-list";
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
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_EMAIL_TRIGGER_INSTRUCTION } from "@/lib/email-triggers/shared";

export type EmailTriggerProjectOption = {
  id: string;
  name: string;
  role: "owner" | "editor" | "member";
  canCreateTrigger: boolean;
};

type EmailTriggerModelOption = {
  id: string;
  name: string;
  provider: string;
  isDefault: boolean;
};

export type EmailTriggerSummary = {
  id: string;
  organizationId: string;
  project: { id: string; name: string };
  creator: { id: string; name: string } | null;
  executionOwner: { id: string; name: string } | null;
  name: string;
  instruction: string;
  modelId: string;
  claimedFromFilter: string | null;
  accessMode: "private";
  address: string;
  enabled: boolean;
  disabledReason: string | null;
  revision: number;
  rotatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  readiness: {
    receiving: boolean;
    project: boolean;
    executionOwner: boolean;
    model: boolean;
    reason:
      | "project_archived"
      | "execution_owner_access_lost"
      | "inbound_receiving_unavailable"
      | "environment_model_unavailable"
      | null;
  };
  permissions: {
    canEdit: boolean;
    canRotate: boolean;
    canEnable: boolean;
    canDisable: boolean;
    canDelete: boolean;
  };
};

type EmailTriggerDraft = {
  projectId: string;
  name: string;
  instruction: string;
  modelId: string;
  claimedFromFilter: string;
};

function emptyDraft(projectId = ""): EmailTriggerDraft {
  return {
    projectId,
    name: "",
    instruction: DEFAULT_EMAIL_TRIGGER_INSTRUCTION,
    modelId: "",
    claimedFromFilter: "",
  };
}

const READINESS_LABELS: Record<
  NonNullable<EmailTriggerSummary["readiness"]["reason"]>,
  string
> = {
  project_archived: "Project archived",
  execution_owner_access_lost: "Execution owner lost access",
  inbound_receiving_unavailable: "Inbound receiving unavailable",
  environment_model_unavailable: "Environment or model unavailable",
};

export function EmailTriggersClient({
  projects,
  triggers,
}: {
  projects: EmailTriggerProjectOption[];
  triggers: EmailTriggerSummary[];
}) {
  const router = useRouter();
  const editableProjects = projects.filter((project) => project.canCreateTrigger);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<EmailTriggerSummary | null>(null);
  const [draft, setDraft] = useState<EmailTriggerDraft>(() =>
    emptyDraft(editableProjects[0]?.id),
  );
  const [models, setModels] = useState<EmailTriggerModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rotating, setRotating] = useState<EmailTriggerSummary | null>(null);
  const [deleting, setDeleting] = useState<EmailTriggerSummary | null>(null);

  useEffect(() => {
    if (!(dialogOpen && draft.projectId)) return;
    const projectId = draft.projectId;
    const controller = new AbortController();
    setModelsLoading(true);
    setModelsError(null);
    void fetch(
      `/api/models/approved?modality=language&projectId=${encodeURIComponent(projectId)}`,
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (response) => {
        const result = (await response.json().catch(() => ({}))) as {
          error?: string;
          models?: EmailTriggerModelOption[];
        };
        if (!(response.ok && Array.isArray(result.models))) {
          throw new Error(result.error ?? "Models could not be loaded.");
        }
        setModels(result.models);
        setDraft((current) => {
          if (current.projectId !== projectId) return current;
          const selected = result.models?.some(
            (model) => model.id === current.modelId,
          )
            ? current.modelId
            : (result.models?.find((model) => model.isDefault)?.id ??
              result.models?.[0]?.id ??
              "");
          return { ...current, modelId: selected };
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setModels([]);
        setModelsError(
          error instanceof Error ? error.message : "Models could not be loaded.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setModelsLoading(false);
      });
    return () => controller.abort();
  }, [dialogOpen, draft.projectId]);

  const grouped = useMemo(() => {
    const groups = new Map<string, EmailTriggerSummary[]>();
    for (const trigger of triggers) {
      const current = groups.get(trigger.project.id) ?? [];
      current.push(trigger);
      groups.set(trigger.project.id, current);
    }
    return [...groups.entries()].map(([projectId, items]) => ({
      projectId,
      projectName: items[0]?.project.name ?? "Project",
      triggers: items,
    }));
  }, [triggers]);

  function openCreate() {
    setEditing(null);
    setDraft(emptyDraft(editableProjects[0]?.id));
    setDialogOpen(true);
  }

  function openEdit(trigger: EmailTriggerSummary) {
    setEditing(trigger);
    setDraft({
      projectId: trigger.project.id,
      name: trigger.name,
      instruction: trigger.instruction,
      modelId: trigger.modelId,
      claimedFromFilter: trigger.claimedFromFilter ?? "",
    });
    setDialogOpen(true);
  }

  async function request(url: string, init: RequestInit, fallback: string) {
    const response = await fetch(url, init);
    const result = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    if (!response.ok) throw new Error(result.error ?? fallback);
  }

  async function saveTrigger() {
    if (!(draft.projectId && draft.name.trim() && draft.instruction.trim() && draft.modelId)) return;
    setBusy(true);
    try {
      const url = editing
        ? `/api/projects/${editing.project.id}/email-triggers/${editing.id}`
        : `/api/projects/${draft.projectId}/email-triggers`;
      await request(
        url,
        {
          method: editing ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(editing ? { expectedRevision: editing.revision } : {}),
            name: draft.name,
            instruction: draft.instruction,
            modelId: draft.modelId,
            claimedFromFilter: draft.claimedFromFilter.trim() || null,
          }),
        },
        "Email Trigger could not be saved.",
      );
      toast.success(editing ? "Email Trigger updated." : "Email Trigger created.");
      setDialogOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Email Trigger could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function setEnabled(trigger: EmailTriggerSummary, enabled: boolean) {
    setBusy(true);
    try {
      await request(
        `/api/projects/${trigger.project.id}/email-triggers/${trigger.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedRevision: trigger.revision,
            enabled,
          }),
        },
        "Email Trigger could not be updated.",
      );
      toast.success(enabled ? "Email Trigger enabled." : "Email Trigger disabled.");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Email Trigger could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  async function rotateTrigger() {
    if (!rotating) return;
    setBusy(true);
    try {
      await request(
        `/api/projects/${rotating.project.id}/email-triggers/${rotating.id}/rotate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedRevision: rotating.revision }),
        },
        "The private address could not be rotated.",
      );
      toast.success("Private address rotated. The old address no longer admits email.");
      setRotating(null);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The private address could not be rotated.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteTrigger() {
    if (!deleting) return;
    setBusy(true);
    try {
      await request(
        `/api/projects/${deleting.project.id}/email-triggers/${deleting.id}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedRevision: deleting.revision }),
        },
        "Email Trigger could not be deleted.",
      );
      toast.success("Email Trigger deleted. Existing Threads remain available.");
      setDeleting(null);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Email Trigger could not be deleted.");
    } finally {
      setBusy(false);
    }
  }

  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      toast.success("Private address copied.");
    } catch {
      toast.error("Private address could not be copied.");
    }
  }

  return (
    <>
      <PageHeader
        actions={
          <Button disabled={editableProjects.length === 0} onClick={openCreate}>
            <Plus className="size-4" /> New trigger
          </Button>
        }
        description="Start an agent run when a private Project email address receives mail. Every run uses the Project's current context, Environment, Apps, and ordinary controls."
        eyebrow="Work"
        title="Triggers"
      />

      {grouped.length === 0 ? (
        <div className="border-y">
          <ResourceEmpty
            description={
              editableProjects.length
                ? "Create a private email address for one of your Projects."
                : "A Project editor or owner can create Email Triggers."
            }
            title="No triggers yet"
          />
        </div>
      ) : (
        <div className="space-y-8">
          {grouped.map((group) => (
            <section aria-labelledby={`trigger-project-${group.projectId}`} key={group.projectId}>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="font-medium" id={`trigger-project-${group.projectId}`}>
                  <Link className="hover:underline" href={`/projects/${group.projectId}`}>
                    {group.projectName}
                  </Link>
                </h2>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {group.triggers.length}
                </span>
              </div>
              <ResourceList>
                {group.triggers.map((trigger) => (
                  <ResourceRow
                    actions={
                      <div className="flex items-center gap-1">
                        <Button
                          aria-label={`Copy private address for ${trigger.name}`}
                          disabled={busy}
                          onClick={() => void copyAddress(trigger.address)}
                          size="icon"
                          variant="ghost"
                        >
                          <Copy className="size-4" />
                        </Button>
                        {Object.values(trigger.permissions).some(Boolean) ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button aria-label="Email Trigger actions" disabled={busy} size="icon" variant="ghost">
                                <MoreHorizontal className="size-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {trigger.permissions.canEdit ? (
                                <DropdownMenuItem onSelect={() => openEdit(trigger)}>
                                  <Pencil className="size-4" /> Edit
                                </DropdownMenuItem>
                              ) : null}
                              {trigger.permissions.canRotate ? (
                                <DropdownMenuItem onSelect={() => setRotating(trigger)}>
                                  <RefreshCw className="size-4" /> Rotate private address
                                </DropdownMenuItem>
                              ) : null}
                              {trigger.enabled && trigger.permissions.canDisable ? (
                                <DropdownMenuItem onSelect={() => void setEnabled(trigger, false)}>
                                  <Pause className="size-4" /> Disable
                                </DropdownMenuItem>
                              ) : null}
                              {!trigger.enabled && trigger.permissions.canEnable ? (
                                <DropdownMenuItem onSelect={() => void setEnabled(trigger, true)}>
                                  <Play className="size-4" /> Enable
                                </DropdownMenuItem>
                              ) : null}
                              {trigger.permissions.canDelete ? (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem onSelect={() => setDeleting(trigger)} variant="destructive">
                                    <Trash2 className="size-4" /> Delete
                                  </DropdownMenuItem>
                                </>
                              ) : null}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : null}
                      </div>
                    }
                    className="px-1 sm:px-2"
                    description={<span className="line-clamp-2">{trigger.instruction}</span>}
                    key={trigger.id}
                    metadata={
                      <span className="flex flex-wrap items-center gap-x-1">
                        <span className="font-mono">{trigger.address}</span>
                        <span aria-hidden="true">·</span>
                        <span>Model: {trigger.modelId}</span>
                        <span aria-hidden="true">·</span>
                        <span>Runs as {trigger.executionOwner?.name ?? "Former member"}</span>
                        {trigger.claimedFromFilter ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>Exact claimed-From filter: {trigger.claimedFromFilter}</span>
                          </>
                        ) : null}
                      </span>
                    }
                    status={
                      <Badge variant={trigger.enabled ? "default" : "outline"}>
                        {trigger.enabled
                          ? trigger.readiness.reason
                            ? `Enabled · ${READINESS_LABELS[trigger.readiness.reason]}`
                            : "Enabled"
                          : trigger.readiness.reason
                            ? READINESS_LABELS[trigger.readiness.reason]
                            : "Disabled"}
                      </Badge>
                    }
                    title={
                      <span className="flex items-center gap-2">
                        <MailPlus className="size-4 text-muted-foreground" />
                        {trigger.name}
                      </span>
                    }
                  />
                ))}
              </ResourceList>
            </section>
          ))}
        </div>
      )}

      <Dialog onOpenChange={setDialogOpen} open={dialogOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Email Trigger" : "New Email Trigger"}</DialogTitle>
            <DialogDescription>
              Kestrel generates a private address. The creator is the immutable Execution Owner shown as Runs as.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain pr-2">
            <div className="space-y-2">
              <Label htmlFor="trigger-project">Project</Label>
              <Select
                disabled={Boolean(editing)}
                onValueChange={(projectId) => setDraft((current) => ({ ...current, projectId }))}
                value={draft.projectId}
              >
                <SelectTrigger id="trigger-project"><SelectValue placeholder="Choose a Project" /></SelectTrigger>
                <SelectContent>
                  {editableProjects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="trigger-name">Name</Label>
              <Input
                id="trigger-name"
                maxLength={120}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                placeholder="Invoice intake"
                value={draft.name}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="trigger-instruction">What should the agent do with each email?</Label>
              <Textarea
                className="min-h-36 resize-y"
                id="trigger-instruction"
                onChange={(event) => setDraft((current) => ({ ...current, instruction: event.target.value }))}
                value={draft.instruction}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="trigger-model">Model</Label>
              <Select
                disabled={modelsLoading || models.length === 0}
                onValueChange={(modelId) => setDraft((current) => ({ ...current, modelId }))}
                value={draft.modelId}
              >
                <SelectTrigger id="trigger-model">
                  <SelectValue placeholder={modelsLoading ? "Loading models…" : "Choose a model"} />
                </SelectTrigger>
                <SelectContent>
                  {models.map((model) => (
                    <SelectItem key={`${model.provider}:${model.id}`} value={model.id}>
                      {model.name} · {model.provider}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {modelsError ? <p className="text-destructive text-xs" role="alert">{modelsError}</p> : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="trigger-claimed-from">Exact claimed-From filter (optional)</Label>
              <Input
                aria-describedby="trigger-claimed-from-help"
                id="trigger-claimed-from"
                maxLength={320}
                onChange={(event) => setDraft((current) => ({ ...current, claimedFromFilter: event.target.value }))}
                placeholder="invoices@example.com"
                type="email"
                value={draft.claimedFromFilter}
              />
              <p className="text-muted-foreground text-xs" id="trigger-claimed-from-help">
                This filters an email's claimed From mailbox exactly. It does not verify the sender's identity.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setDialogOpen(false)} variant="outline">Cancel</Button>
            <Button
              disabled={busy || modelsLoading || Boolean(modelsError) || !draft.projectId || !draft.name.trim() || !draft.instruction.trim() || !draft.modelId}
              onClick={() => void saveTrigger()}
            >
              {busy ? "Saving…" : editing ? "Save changes" : "Create trigger"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog onOpenChange={(open) => { if (!(open || busy)) setRotating(null); }} open={Boolean(rotating)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate the private address?</AlertDialogTitle>
            <AlertDialogDescription>
              The current address stops admitting new email immediately. Existing receipt and Thread history is preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void rotateTrigger()}>
              {busy ? "Rotating…" : "Rotate address"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog onOpenChange={(open) => { if (!(open || busy)) setDeleting(null); }} open={Boolean(deleting)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this Email Trigger?</AlertDialogTitle>
            <AlertDialogDescription>
              Its private address stops admitting new email. Existing receipts and Threads remain available.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy}
              onClick={() => void deleteTrigger()}
            >
              {busy ? "Deleting…" : "Delete trigger"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
