"use client";

import {
  CalendarClock,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
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
import { TimeText } from "@/components/ui/time-text";
import { nextProjectPromptScheduleOccurrence } from "@/lib/schedules/cron";

export type ScheduleProjectOption = {
  id: string;
  name: string;
  role: "owner" | "editor" | "member";
  canCreateSchedule: boolean;
};

export type ScheduleSummary = {
  id: string;
  organizationId: string;
  project: { id: string; name: string };
  creator: { id: string; name: string } | null;
  cronExpression: string;
  timeZone: string;
  prompt: string;
  enabled: boolean;
  pauseReason: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  permissions: {
    canEdit: boolean;
    canEnable: boolean;
    canPause: boolean;
    canDelete: boolean;
  };
  latestRun: {
    id: string;
    scheduledFor: string;
    catchUpFrom: string | null;
    status: "queued" | "materialized" | "failed" | "cancelled";
    threadId: string | null;
    threadTitle: string | null;
    turnStatus:
      | "queued"
      | "running"
      | "waiting_for_input"
      | "completed"
      | "failed"
      | "cancelled"
      | null;
    failure: { code: string | null; message: string | null } | null;
  } | null;
};

type ScheduleDraft = {
  projectId: string;
  cronExpression: string;
  timeZone: string;
  prompt: string;
};

function browserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function emptyDraft(projectId = ""): ScheduleDraft {
  return {
    projectId,
    cronExpression: "0 9 * * 1-5",
    timeZone: browserTimeZone(),
    prompt: "",
  };
}

function runLabel(schedule: ScheduleSummary) {
  const run = schedule.latestRun;
  if (!run) return "Never run";
  if (run.turnStatus === "waiting_for_input") return "Waiting for input";
  if (run.turnStatus) return run.turnStatus.replaceAll("_", " ");
  return run.status;
}

export function SchedulesClient({
  projects,
  schedules,
}: {
  projects: ScheduleProjectOption[];
  schedules: ScheduleSummary[];
}) {
  const router = useRouter();
  const editableProjects = projects.filter((project) => project.canCreateSchedule);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduleSummary | null>(null);
  const [draft, setDraft] = useState<ScheduleDraft>(() =>
    emptyDraft(editableProjects[0]?.id),
  );
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<ScheduleSummary | null>(null);
  const [timeZones, setTimeZones] = useState<string[]>([]);

  useEffect(() => {
    const supportedValuesOf = (
      Intl as typeof Intl & {
        supportedValuesOf?: (key: "timeZone") => string[];
      }
    ).supportedValuesOf;
    setTimeZones(
      supportedValuesOf
        ? supportedValuesOf("timeZone")
        : [browserTimeZone(), "UTC"],
    );
  }, []);

  const nextRun = useMemo(() => {
    try {
      return nextProjectPromptScheduleOccurrence({
        cronExpression: draft.cronExpression,
        timeZone: draft.timeZone,
      });
    } catch {
      return null;
    }
  }, [draft.cronExpression, draft.timeZone]);

  const grouped = useMemo(() => {
    const groups = new Map<string, ScheduleSummary[]>();
    for (const schedule of schedules) {
      const current = groups.get(schedule.project.id) ?? [];
      current.push(schedule);
      groups.set(schedule.project.id, current);
    }
    return [...groups.entries()].map(([projectId, items]) => ({
      projectId,
      projectName: items[0]?.project.name ?? "Project",
      schedules: items,
    }));
  }, [schedules]);

  function openCreate() {
    setEditing(null);
    setDraft(emptyDraft(editableProjects[0]?.id));
    setDialogOpen(true);
  }

  function openEdit(schedule: ScheduleSummary) {
    setEditing(schedule);
    setDraft({
      projectId: schedule.project.id,
      cronExpression: schedule.cronExpression,
      timeZone: schedule.timeZone,
      prompt: schedule.prompt,
    });
    setDialogOpen(true);
  }

  async function saveSchedule() {
    if (!(draft.projectId && draft.prompt.trim() && nextRun)) return;
    setBusy(true);
    try {
      const url = editing
        ? `/api/projects/${editing.project.id}/schedules/${editing.id}`
        : `/api/projects/${draft.projectId}/schedules`;
      const response = await fetch(url, {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cronExpression: draft.cronExpression,
          timeZone: draft.timeZone,
          prompt: draft.prompt,
        }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(result.error ?? "Schedule could not be saved.");
      }
      toast.success(editing ? "Schedule updated." : "Schedule created.");
      setDialogOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Schedule could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function setEnabled(schedule: ScheduleSummary, enabled: boolean) {
    setBusy(true);
    try {
      const response = await fetch(
        `/api/projects/${schedule.project.id}/schedules/${schedule.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled }),
        },
      );
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(result.error ?? "Schedule could not be updated.");
      }
      toast.success(enabled ? "Schedule enabled." : "Schedule paused.");
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Schedule could not be updated.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function deleteSchedule() {
    if (!deleting) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/projects/${deleting.project.id}/schedules/${deleting.id}`,
        { method: "DELETE" },
      );
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(result.error ?? "Schedule could not be deleted.");
      }
      toast.success("Schedule deleted. Existing Threads were preserved.");
      setDeleting(null);
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Schedule could not be deleted.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        actions={
          <Button
            disabled={editableProjects.length === 0}
            onClick={openCreate}
          >
            <Plus className="size-4" /> New schedule
          </Button>
        }
        description="Run recurring single-turn prompts and review every result as a Project Thread. Each occurrence uses normal Kestrel usage."
        eyebrow="Work"
        title="Schedules"
      />

      {grouped.length === 0 ? (
        <div className="border-y">
          <ResourceEmpty
            description={
              editableProjects.length
                ? "Create a cron schedule and prompt for one of your Projects."
                : "A Project editor or owner can create scheduled prompts."
            }
            title="No schedules yet"
          />
        </div>
      ) : (
        <div className="space-y-8">
          {grouped.map((group) => (
            <section aria-labelledby={`schedule-project-${group.projectId}`} key={group.projectId}>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="font-medium" id={`schedule-project-${group.projectId}`}>
                  <Link className="hover:underline" href={`/projects/${group.projectId}`}>
                    {group.projectName}
                  </Link>
                </h2>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {group.schedules.length}
                </span>
              </div>
              <ResourceList>
                {group.schedules.map((schedule) => (
                  <ResourceRow
                    actions={
                      schedule.permissions.canEdit ||
                      schedule.permissions.canPause ||
                      schedule.permissions.canEnable ||
                      schedule.permissions.canDelete ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              aria-label="Schedule actions"
                              disabled={busy}
                              size="icon"
                              variant="ghost"
                            >
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {schedule.permissions.canEdit ? (
                              <DropdownMenuItem onSelect={() => openEdit(schedule)}>
                                <Pencil className="size-4" /> Edit
                              </DropdownMenuItem>
                            ) : null}
                            {schedule.enabled && schedule.permissions.canPause ? (
                              <DropdownMenuItem
                                onSelect={() => void setEnabled(schedule, false)}
                              >
                                <Pause className="size-4" /> Pause
                              </DropdownMenuItem>
                            ) : null}
                            {!schedule.enabled && schedule.permissions.canEnable ? (
                              <DropdownMenuItem
                                onSelect={() => void setEnabled(schedule, true)}
                              >
                                <Play className="size-4" /> Enable
                              </DropdownMenuItem>
                            ) : null}
                            {schedule.permissions.canDelete ? (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onSelect={() => setDeleting(schedule)}
                                  variant="destructive"
                                >
                                  <Trash2 className="size-4" /> Delete
                                </DropdownMenuItem>
                              </>
                            ) : null}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null
                    }
                    className="px-1 sm:px-2"
                    description={
                      <span className="line-clamp-2">{schedule.prompt}</span>
                    }
                    key={schedule.id}
                    metadata={
                      <span className="flex flex-wrap items-center gap-x-1">
                        <span className="font-mono">{schedule.cronExpression}</span>
                        <span aria-hidden="true">·</span>
                        <span>{schedule.timeZone}</span>
                        <span aria-hidden="true">·</span>
                        <span>Runs as {schedule.creator?.name ?? "Former member"}</span>
                        {schedule.nextRunAt ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>
                              Next <TimeText mode="relative" value={schedule.nextRunAt} />
                            </span>
                          </>
                        ) : null}
                        {schedule.latestRun ? (
                          <>
                            <span aria-hidden="true">·</span>
                            {schedule.latestRun.threadId ? (
                              <Link
                                className="underline underline-offset-2"
                                href={`/threads/${schedule.latestRun.threadId}`}
                              >
                                {schedule.latestRun.threadTitle || "Latest Thread"}
                              </Link>
                            ) : (
                              <span>
                                Last: {runLabel(schedule)}
                              </span>
                            )}
                            {schedule.latestRun.failure?.message ? (
                              <span aria-label="Latest run failure">
                                — {schedule.latestRun.failure.message}
                              </span>
                            ) : null}
                          </>
                        ) : null}
                      </span>
                    }
                    status={
                      <Badge variant={schedule.enabled ? "secondary" : "outline"}>
                        {schedule.enabled ? "Enabled" : "Paused"}
                      </Badge>
                    }
                    title={
                      <span className="flex items-center gap-2">
                        <CalendarClock className="size-4 text-muted-foreground" />
                        {schedule.latestRun ? runLabel(schedule) : "Scheduled prompt"}
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit schedule" : "New schedule"}</DialogTitle>
            <DialogDescription>
              Each occurrence creates a new Thread in the selected Project.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="schedule-project">Project</Label>
              <Select
                disabled={Boolean(editing)}
                onValueChange={(projectId) =>
                  setDraft((current) => ({ ...current, projectId }))
                }
                value={draft.projectId}
              >
                <SelectTrigger id="schedule-project">
                  <SelectValue placeholder="Choose a Project" />
                </SelectTrigger>
                <SelectContent>
                  {editableProjects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-[1fr_1.25fr]">
              <div className="space-y-2">
                <Label htmlFor="schedule-cron">Cron schedule</Label>
                <Input
                  aria-describedby="schedule-next-run"
                  aria-invalid={!nextRun}
                  id="schedule-cron"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      cronExpression: event.target.value,
                    }))
                  }
                  value={draft.cronExpression}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="schedule-timezone">Timezone</Label>
                <Input
                  id="schedule-timezone"
                  list="schedule-timezones"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      timeZone: event.target.value,
                    }))
                  }
                  value={draft.timeZone}
                />
                <datalist id="schedule-timezones">
                  {timeZones.map((timeZone) => (
                    <option key={timeZone} value={timeZone} />
                  ))}
                </datalist>
              </div>
            </div>
            <p
              className={nextRun ? "text-muted-foreground text-xs" : "text-destructive text-xs"}
              id="schedule-next-run"
              role={nextRun ? "status" : "alert"}
            >
              {nextRun
                ? `Next run: ${nextRun.toLocaleString([], { timeZone: draft.timeZone })}`
                : "Enter a valid five-field cron and IANA timezone."}
            </p>
            <div className="space-y-2">
              <Label htmlFor="schedule-prompt">Prompt</Label>
              <Textarea
                id="schedule-prompt"
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    prompt: event.target.value,
                  }))
                }
                placeholder="What should Kestrel do?"
                rows={8}
                value={draft.prompt}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setDialogOpen(false)} variant="outline">
              Cancel
            </Button>
            <Button
              disabled={
                busy || !draft.projectId || !draft.prompt.trim() || !nextRun
              }
              onClick={() => void saveSchedule()}
            >
              {busy ? "Saving…" : editing ? "Save changes" : "Create schedule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        onOpenChange={(open) => {
          if (!(open || busy)) setDeleting(null);
        }}
        open={Boolean(deleting)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this schedule?</AlertDialogTitle>
            <AlertDialogDescription>
              Future runs will stop. Threads already created by this schedule
              will remain in {deleting?.project.name ?? "the Project"}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void deleteSchedule();
              }}
            >
              {busy ? "Deleting…" : "Delete schedule"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
