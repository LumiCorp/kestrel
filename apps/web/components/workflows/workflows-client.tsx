"use client";

import { GitBranch, MoreHorizontal, Play, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { ResourceEmpty, ResourceList, ResourceRow } from "@/components/resource-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { WorkflowDefinition } from "@/lib/workflows/contracts";

export type WorkflowSummary = {
  id: string;
  project: { id: string; name: string };
  title: string;
  description: string;
  modelId: string;
  currentVersion: number;
  state: "Draft" | "Active" | "Needs attention";
  hasDraft: boolean;
  attentionMessage: string | null;
  enabled: boolean;
  cronExpression: string | null;
  timeZone: string | null;
  nextRunAt: string | null;
  definition: WorkflowDefinition;
  permissions: { canEdit: boolean; canRun: boolean; canDelete: boolean };
  latestRun: { id: string; status: string; createdAt: string } | null;
};

export function WorkflowsClient({ workflows, canCreate }: { workflows: WorkflowSummary[]; canCreate: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function run(workflow: WorkflowSummary) {
    setBusy(true);
    try {
      if (workflow.state !== "Active") throw new Error("Review and activate this workflow before running it.");
      const response = await fetch(`/api/projects/${workflow.project.id}/workflows/${workflow.id}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: crypto.randomUUID(), input: {} }),
      });
      const result = await response.json() as { runId?: string; error?: string };
      if (!(response.ok && result.runId)) throw new Error(result.error ?? "Workflow could not start.");
      router.push(`/workflows/runs/${result.runId}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Workflow could not start.");
      setBusy(false);
    }
  }

  async function remove(workflow: WorkflowSummary) {
    if (!window.confirm(`Delete “${workflow.title}”? Existing child tasks are preserved.`)) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${workflow.project.id}/workflows/${workflow.id}`, { method: "DELETE" });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(result.error ?? "Workflow could not be deleted.");
      }
      toast.success("Workflow deleted.");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Workflow could not be deleted.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        actions={<Button asChild disabled={!canCreate}><Link href="/workflows/new"><Plus className="size-4" /> New workflow</Link></Button>}
        description="Compose named Kestrel workflows from autonomous work, explicit Actions, deterministic gates, joins, and a final output. Run them now or on a schedule."
        eyebrow="Work"
        title="Workflows"
      />
      {workflows.length === 0 ? <div className="border-y"><ResourceEmpty description={canCreate ? "Describe a workflow or build one on the canvas." : "A Project editor or owner can create workflows."} title="No workflows yet" /></div> : (
        <ResourceList>
          {workflows.map((workflow) => (
            <ResourceRow
              actions={<DropdownMenu><DropdownMenuTrigger asChild><Button aria-label="Workflow actions" disabled={busy} size="icon" variant="ghost"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">{workflow.permissions.canRun && workflow.state === "Active" ? <DropdownMenuItem onSelect={() => void run(workflow)}><Play className="size-4" /> Run</DropdownMenuItem> : null}<DropdownMenuItem asChild><Link href={`/workflows/${workflow.id}`}>Open graph</Link></DropdownMenuItem>{workflow.permissions.canDelete ? <><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => void remove(workflow)} variant="destructive"><Trash2 className="size-4" /> Delete</DropdownMenuItem></> : null}</DropdownMenuContent></DropdownMenu>}
              description={workflow.attentionMessage ?? (workflow.description || `${workflow.definition.nodes.length} steps · ${workflow.definition.edges.length} connections`)}
              key={workflow.id}
              metadata={<span>{workflow.project.name} · {workflow.modelId} · v{workflow.currentVersion}{workflow.cronExpression ? ` · ${workflow.cronExpression} ${workflow.timeZone}` : " · Manual"}{workflow.latestRun ? <> · Latest: <Link className="underline underline-offset-2" href={`/workflows/runs/${workflow.latestRun.id}`}>{workflow.latestRun.status.replaceAll("_", " ")}</Link></> : null}</span>}
              status={<Badge variant={workflow.state === "Needs attention" ? "destructive" : workflow.state === "Active" ? "default" : "secondary"}>{workflow.state}{workflow.hasDraft ? " · New draft" : ""}</Badge>}
              title={<Link className="flex items-center gap-2 hover:underline" href={`/workflows/${workflow.id}`}><GitBranch className="size-4 text-muted-foreground" />{workflow.title}</Link>}
            />
          ))}
        </ResourceList>
      )}
    </>
  );
}
