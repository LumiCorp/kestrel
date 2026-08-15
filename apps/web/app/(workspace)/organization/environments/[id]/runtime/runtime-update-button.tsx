"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function RuntimeUpdateButton({
  environmentId,
  aligned,
}: {
  environmentId: string;
  aligned: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [operation, setOperation] = useState<RuntimeOperation | null>(null);
  const operationId = operation?.id;
  const operationTerminal =
    operation?.status === "completed" ||
    operation?.status === "failed" ||
    operation?.status === "cancelled";

  useEffect(() => {
    if (!(operationId && !operationTerminal)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const response = await fetch(
          `/api/organization/environments/${environmentId}/operations`,
        );
        if (!response.ok) throw new Error("Runtime update status failed.");
        const payload = (await response.json()) as {
          operations?: RuntimeOperation[];
        };
        const current = payload.operations?.find(
          (candidate) => candidate.id === operationId,
        );
        if (cancelled) return;
        if (!current) throw new Error("Runtime update operation was not found.");
        setOperation(current);
        if (current.status === "completed") {
          if (current.stage === "environment.update.ready") {
            toast.success("Runtime update completed.");
          } else {
            toast.warning("Runtime update completed with recovery required.");
          }
          router.refresh();
          return;
        }
        if (current.status === "failed" || current.status === "cancelled") {
          toast.error(current.errorMessage ?? "Runtime update failed.");
          router.refresh();
          return;
        }
        timer = setTimeout(() => void poll(), 2000);
      } catch (error) {
        if (!cancelled) {
          toast.error(
            error instanceof Error
              ? error.message
              : "Runtime update status failed.",
          );
        }
      }
    }
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [environmentId, operationId, operationTerminal, router]);

  async function update() {
    setPending(true);
    try {
      const response = await fetch(
        `/api/organization/environments/${environmentId}/runtime-updates`,
        { method: "POST" },
      );
      const payload = (await response.json()) as {
        error?: { message?: string; code?: string };
        operation?: RuntimeOperation;
      };
      if (!response.ok) {
        throw new Error(payload.error?.message ?? payload.error?.code ?? "Runtime update failed.");
      }
      if (!payload.operation) {
        throw new Error("Runtime update operation was not returned.");
      }
      setOperation(payload.operation);
      toast.success("Runtime update queued.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Runtime update failed.");
    } finally {
      setPending(false);
    }
  }
  const active = Boolean(operationId && !operationTerminal);
  const label = aligned
    ? "Runtime is current"
    : pending
      ? "Queuing…"
      : active
        ? "Updating runtime…"
        : operation?.status === "failed" || operation?.status === "cancelled"
          ? "Retry runtime update"
          : operation?.status === "completed" &&
              operation.stage === "environment.update.recovery_required"
            ? "Recovery required"
            : "Update to current runtime";
  return (
    <Button
      disabled={aligned || pending || active}
      onClick={() => void update()}
      type="button"
    >
      <span aria-live="polite">{label}</span>
    </Button>
  );
}

type RuntimeOperation = {
  id: string;
  status: string;
  stage: string;
  errorMessage?: string | null;
};
