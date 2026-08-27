"use client";

import { ArrowLeft, Bot, ChevronDown, Wrench } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { WorkflowDefinition } from "@/lib/workflows/contracts";
import { WorkflowCanvas } from "./workflow-canvas";

type RunStep = {
  id: string;
  nodeId: string;
  status: string;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  threadId: string | null;
  failureMessage: string | null;
  turnFailureMessage: string | null;
};

export type WorkflowRunView = {
  id: string;
  status: string;
  output: Record<string, unknown> | null;
  failureMessage: string | null;
  definition: WorkflowDefinition;
  workflow: { id: string; title: string; project: { id: string; name: string } };
  steps: RunStep[];
};

function statusVariant(status: string) {
  if (status === "failed") return "destructive" as const;
  if (status === "completed") return "default" as const;
  return "secondary" as const;
}

function JsonEvidence({
  label,
  value,
}: {
  label: string;
  value: Record<string, unknown> | null;
}) {
  if (value === null) return null;
  return (
    <div>
      <p className="mb-1 text-muted-foreground">{label}</p>
      <pre className="max-h-64 overflow-auto rounded-lg bg-muted/50 p-3 text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export function WorkflowRunClient({ initialRun }: { initialRun: WorkflowRunView }) {
  const [run, setRun] = useState(initialRun);
  const terminal = ["completed", "failed", "cancelled"].includes(run.status);
  useEffect(() => {
    if (terminal) return;
    const timer = window.setInterval(() => {
      void fetch(`/api/workflow-runs/${run.id}`, { cache: "no-store" })
        .then((response) => response.json())
        .then((result: { run?: WorkflowRunView }) => { if (result.run) setRun(result.run); });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [run.id, terminal]);
  const byNode = useMemo(() => new Map(run.steps.map((step) => [step.nodeId, step])), [run.steps]);
  const statuses = Object.fromEntries(run.steps.map((step) => [step.nodeId, step.status]));
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3"><Button asChild size="icon" variant="ghost"><Link href={`/workflows/${run.workflow.id}`}><ArrowLeft className="size-4" /><span className="sr-only">Back</span></Link></Button><div><div className="flex items-center gap-2"><h1 className="font-semibold text-xl">{run.workflow.title}</h1><Badge variant={statusVariant(run.status)}>{run.status.replaceAll("_", " ")}</Badge></div><p className="text-muted-foreground text-sm">{run.workflow.project.name} · Run {run.id.slice(0, 8)}</p></div></div>
      </div>
      {run.failureMessage ? <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-destructive text-sm">{run.failureMessage}</div> : null}
      <div
        className="h-[min(70vh,760px)] min-h-130 overflow-hidden rounded-xl border bg-muted/20"
        data-testid="workflow-run-canvas"
      >
        <WorkflowCanvas definition={run.definition} statuses={statuses} />
      </div>
      <section className="space-y-2" aria-label="Workflow step evidence">
        <h2 className="font-medium">Step evidence</h2>
        {run.definition.nodes.map((node) => {
          const step = byNode.get(node.id);
          const evidence = step?.output as { text?: string; model?: string; toolCalls?: Array<{ toolName: string; state?: string; input?: unknown; output?: unknown; error?: string }> } | null;
          return (
            <details className="group rounded-xl border bg-card" key={node.id}>
              <summary className="flex cursor-pointer list-none items-center gap-3 p-4"><span className="rounded-md bg-muted p-1.5">{node.kind === "kestrel" ? <Bot className="size-4" /> : node.kind === "tool" ? <Wrench className="size-4" /> : <ChevronDown className="size-4" />}</span><span className="flex-1 font-medium text-sm">{node.label}</span><Badge variant={statusVariant(step?.status ?? "pending")}>{(step?.status ?? "pending").replaceAll("_", " ")}</Badge><ChevronDown className="size-4 transition-transform group-open:rotate-180" /></summary>
              <div className="space-y-3 border-t p-4 text-sm">
                {step?.threadId ? <Link className="underline underline-offset-2" href={`/threads/${step.threadId}`}>Open Kestrel task</Link> : null}
                <JsonEvidence label="Step input" value={step?.input ?? null} />
                {evidence?.model ? <p><span className="text-muted-foreground">Model:</span> {evidence.model}</p> : null}
                {evidence?.toolCalls?.length ? <div><p className="mb-2 text-muted-foreground">Internal tool calls</p><div className="space-y-2">{evidence.toolCalls.map((call, index) => <div className="rounded-lg bg-muted/50 p-3" key={`${call.toolName}-${index}`}><p className="font-mono text-xs">{call.toolName}</p><p className="text-muted-foreground text-xs">{call.state ?? "recorded"}</p>{call.input !== undefined ? <pre className="mt-2 max-h-48 overflow-auto text-xs">{JSON.stringify(call.input, null, 2)}</pre> : null}{call.output !== undefined ? <pre className="mt-2 max-h-48 overflow-auto text-xs">{JSON.stringify(call.output, null, 2)}</pre> : null}</div>)}</div></div> : node.kind === "kestrel" || node.kind === "tool" ? <p className="text-muted-foreground">No tool calls recorded yet.</p> : null}
                {evidence?.text ? <div><p className="mb-1 text-muted-foreground">Step output</p><p className="whitespace-pre-wrap">{evidence.text}</p></div> : null}
                <JsonEvidence label="Recorded output" value={step?.output ?? null} />
                {step?.failureMessage || step?.turnFailureMessage ? <p className="text-destructive">{step.failureMessage ?? step.turnFailureMessage}</p> : null}
              </div>
            </details>
          );
        })}
      </section>
      {run.output ? <section className="rounded-xl border bg-card p-4"><h2 className="mb-2 font-medium">Workflow output</h2><pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(run.output, null, 2)}</pre></section> : null}
    </div>
  );
}
