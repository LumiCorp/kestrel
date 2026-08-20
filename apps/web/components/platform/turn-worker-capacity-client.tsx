"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AdminDataTable } from "@/components/admin/admin-data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type RuntimeState = {
  revision: number;
  desired: { concurrencyPerMachine: number; activeMachineCount: number };
  applied: {
    healthyActiveMachineCount: number;
    effectiveCapacity: number;
    inventoryFingerprint: string;
    drift: string[];
  };
  queue: {
    running: number;
    queued: number;
    waiting: number;
    oldestQueuedAt: string | null;
  };
  admission: { closed: boolean; expiresAt: string | null };
  operation: {
    id: string | null;
    state: string;
    stage: string | null;
    queuedAt: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    result: unknown;
  };
  machines: Array<{
    id: string;
    state: string;
    region: string;
    role: string;
    standbyForMachineIds: string[];
    image: string | null;
    resolvedImageDigest: string | null;
    instanceId: string | null;
    cpuKind: string | null;
    cpus: number | null;
    memoryMb: number | null;
    configuredConcurrency: number | null;
    healthStatus: string;
  }>;
};

const ACTIVE_OPERATION_STATES = new Set(["queued", "running"]);

export function TurnWorkerCapacityClient() {
  const [state, setState] = useState<RuntimeState | null>(null);
  const [concurrency, setConcurrency] = useState(16);
  const [activeMachines, setActiveMachines] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (syncForm = false) => {
    try {
      const response = await fetch("/api/platform/runtime/turn-workers", {
        cache: "no-store",
      });
      const body = (await response.json().catch(() => ({}))) as
        | RuntimeState
        | { error?: string };
      if (!(response.ok && ("revision" in body))) {
        setError(
          "error" in body
            ? (body.error ?? "Runtime state unavailable.")
            : "Runtime state unavailable.",
        );
        return;
      }
      setState(body);
      if (syncForm) {
        setConcurrency(body.desired.concurrencyPerMachine);
        setActiveMachines(body.desired.activeMachineCount);
      }
      setError(null);
    } catch {
      setError("Runtime state unavailable. Check the connection and retry.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  useEffect(() => {
    if (!(state && ACTIVE_OPERATION_STATES.has(state.operation.state))) return;
    const timer = window.setInterval(() => void load(false), 2000);
    return () => window.clearInterval(timer);
  }, [load, state]);

  async function submit() {
    if (!state) return;
    setSubmitting(true);
    try {
      const response = await fetch("/api/platform/runtime/turn-workers", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: state.revision,
          expectedInventoryFingerprint: state.applied.inventoryFingerprint,
          concurrencyPerMachine: concurrency,
          activeMachineCount: activeMachines,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        state?: RuntimeState;
      };
      if (!response.ok) {
        if (body.state) {
          setState(body.state);
          setConcurrency(body.state.desired.concurrencyPerMachine);
          setActiveMachines(body.state.desired.activeMachineCount);
        }
        toast.error(body.error ?? "Capacity request was rejected.");
        return;
      }
      toast.success("Capacity request accepted.");
      await load(false);
    } catch {
      toast.error("Capacity request failed. Check the connection and retry.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <p className="text-muted-foreground text-sm">Loading Turn Worker capacity…</p>;
  }
  if (!state) {
    return (
      <div className="space-y-3 border-y py-4">
        <p className="text-destructive text-sm">{error}</p>
        <Button onClick={() => void load(true)} variant="outline">Retry</Button>
      </div>
    );
  }

  const operationActive = ACTIVE_OPERATION_STATES.has(state.operation.state);
  const validCapacity =
    Number.isInteger(concurrency) &&
    concurrency >= 1 &&
    concurrency <= 64 &&
    Number.isInteger(activeMachines) &&
    activeMachines >= 1 &&
    activeMachines <= 8;
  const desiredCapacity =
    state.desired.concurrencyPerMachine * state.desired.activeMachineCount;
  const operationResult =
    state.operation.result && typeof state.operation.result === "object"
      ? (state.operation.result as { message?: unknown })
      : null;

  return (
    <div className="space-y-7">
      {error ? (
        <div className="border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
          {error}
        </div>
      ) : null}
      <div className="grid gap-4 border-y py-4 text-sm sm:grid-cols-2 lg:grid-cols-5">
        <Metric label="Desired capacity" value={`${desiredCapacity} slots`} />
        <Metric label="Applied capacity" value={`${state.applied.effectiveCapacity} slots`} />
        <Metric label="Running / queued" value={`${state.queue.running} / ${state.queue.queued}`} />
        <Metric label="Waiting" value={String(state.queue.waiting)} />
        <Metric
          label="Admission"
          value={state.admission.closed ? "Closed" : "Open"}
        />
      </div>

      {state.applied.drift.length > 0 ? (
        <div className="border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm">
          <div className="font-medium">Runtime drift requires attention</div>
          <div className="mt-1 text-muted-foreground">
            {state.applied.drift.join(", ")}
          </div>
        </div>
      ) : null}

      <section className="space-y-3">
        <div>
          <h2 className="font-semibold text-base">Capacity request</h2>
          <p className="text-muted-foreground text-sm">
            Changes are applied asynchronously by the Control Worker. Stops and
            started-Machine reconfiguration require zero running turns.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="turn-worker-slots">Slots per Machine</Label>
            <Input
              className="w-36"
              id="turn-worker-slots"
              max={64}
              min={1}
              onChange={(event) => setConcurrency(event.target.valueAsNumber)}
              type="number"
              value={concurrency}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="turn-worker-machines">Active Machines</Label>
            <Input
              className="w-36"
              id="turn-worker-machines"
              max={8}
              min={1}
              onChange={(event) => setActiveMachines(event.target.valueAsNumber)}
              type="number"
              value={activeMachines}
            />
          </div>
          <Button
            disabled={operationActive || submitting || !validCapacity}
            onClick={() => void submit()}
          >
            {submitting ? "Submitting…" : "Apply capacity"}
          </Button>
          <Button onClick={() => void load(true)} variant="outline">
            Refresh
          </Button>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold text-base">Operation</h2>
          <Badge variant={operationActive ? "secondary" : "outline"}>
            {state.operation.state}
          </Badge>
          {state.operation.stage ? (
            <span className="text-muted-foreground text-sm">{state.operation.stage}</span>
          ) : null}
        </div>
        {state.admission.closed ? (
          <div className="text-amber-700 text-sm dark:text-amber-300">
            <p>
              New turn claims are deferred until this operation completes or
              the admission lease expires.
            </p>
            {state.admission.expiresAt ? (
              <p>Lease expires {new Date(state.admission.expiresAt).toLocaleString()}.</p>
            ) : null}
          </div>
        ) : null}
        {typeof operationResult?.message === "string" ? (
          <p className="text-destructive text-sm">{operationResult.message}</p>
        ) : null}
        <p className="text-muted-foreground text-sm">
          Oldest queued: {state.queue.oldestQueuedAt ? new Date(state.queue.oldestQueuedAt).toLocaleString() : "none"}
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold text-base">Machines</h2>
        <AdminDataTable
          columns={[
            { key: "machine", label: "Machine" },
            { key: "role", label: "Role" },
            { key: "state", label: "State / health" },
            { key: "runtime", label: "Runtime" },
            { key: "resources", label: "Resources" },
            { key: "capacity", label: "Slots" },
            { key: "standbys", label: "Watches" },
          ]}
          rows={state.machines.map((machine) => ({
            machine: (
              <div>
                <div className="font-mono text-xs">{machine.id}</div>
                <div className="text-muted-foreground text-xs">{machine.region}</div>
              </div>
            ),
            role: machine.role.replaceAll("_", " "),
            state: `${machine.state} / ${machine.healthStatus}`,
            runtime: (
              <div className="max-w-64 text-xs">
                <div
                  className="truncate font-mono"
                  title={machine.resolvedImageDigest ?? machine.image ?? undefined}
                >
                  {machine.image ?? "unknown"}
                </div>
                <div className="text-muted-foreground">
                  version {machine.instanceId ?? "unknown"}
                </div>
              </div>
            ),
            resources: `${machine.cpus ?? "?"} ${machine.cpuKind ?? "CPU"} · ${machine.memoryMb ?? "?"} MB`,
            capacity: machine.configuredConcurrency ?? "invalid",
            standbys: machine.standbyForMachineIds.length
              ? machine.standbyForMachineIds.join(", ")
              : "—",
          }))}
        />
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground text-xs uppercase tracking-wide">{label}</div>
      <div className="mt-1 font-semibold text-lg">{value}</div>
    </div>
  );
}
