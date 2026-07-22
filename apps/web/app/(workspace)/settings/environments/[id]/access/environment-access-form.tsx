"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { EnvironmentCapabilityGrant } from "@/drizzle/schema";

const capabilities = [
  ["repository.read", "Repository read", "auto"],
  ["repository.push_agent_branch", "Push agent branches", "auto"],
  ["issue.write", "Issues", "ask"],
  ["pull_request.write", "Pull requests", "ask"],
  ["merge.write", "Merges", "ask"],
  ["release.write", "Releases", "ask"],
  ["workflow.dispatch", "Workflows", "ask"],
] as const;

export function EnvironmentAccessForm({
  environmentId,
}: {
  environmentId: string;
}) {
  const [grants, setGrants] = useState<EnvironmentCapabilityGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/organization/environments/${environmentId}/capabilities`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Environment access is unavailable.");
        return (await response.json()) as {
          grants?: EnvironmentCapabilityGrant[];
        };
      })
      .then((payload) => setGrants(payload.grants ?? []))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          toast.error(
            error instanceof Error
              ? error.message
              : "Environment access is unavailable."
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [environmentId]);

  async function setGrant(input: {
    capabilityKey: (typeof capabilities)[number][0];
    enabledMode: "auto" | "ask";
  }) {
    const grant = grants.find(
      (candidate) =>
        candidate.resourceId === null &&
        candidate.capabilityKey === input.capabilityKey
    );
    const enabled = grant?.approvalMode === input.enabledMode;
    setBusyKey(input.capabilityKey);
    try {
      const response = await fetch(
        `/api/organization/environments/${environmentId}/capabilities`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            providerKey: "github",
            capabilityKey: input.capabilityKey,
            resourceId: null,
            approvalMode: enabled ? "deny" : input.enabledMode,
            loggingMode:
              input.capabilityKey === "repository.read"
                ? "metadata_only"
                : "full",
            rateLimitMode: "default",
          }),
        }
      );
      const payload = (await response.json()) as {
        grant?: EnvironmentCapabilityGrant;
        error?: string;
      };
      if (!(response.ok && payload.grant)) {
        throw new Error(payload.error ?? "Environment access update failed.");
      }
      setGrants((current) => [
        ...current.filter((candidate) => candidate.id !== payload.grant!.id),
        payload.grant!,
      ]);
      toast.success("Environment access updated.");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Environment access update failed."
      );
    } finally {
      setBusyKey(null);
    }
  }

  if (loading) {
    return <p className="text-muted-foreground text-sm">Loading access policy…</p>;
  }

  return (
    <div className="divide-y border-y">
      {capabilities.map(([capabilityKey, label, enabledMode]) => {
        const grant = grants.find(
          (candidate) =>
            candidate.resourceId === null &&
            candidate.capabilityKey === capabilityKey
        );
        const enabled = grant?.approvalMode === enabledMode;
        return (
          <div
            className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
            key={capabilityKey}
          >
            <div>
              <div className="font-medium text-sm">{label}</div>
              <p className="text-muted-foreground text-xs">
                {enabledMode === "ask"
                  ? "Requires approval for each external mutation."
                  : "Available automatically within actor permissions."}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={enabled ? "default" : "outline"}>
                {enabled
                  ? enabledMode === "ask"
                    ? "Approval"
                    : "Allowed"
                  : "Denied"}
              </Badge>
              <Button
                disabled={busyKey === capabilityKey}
                onClick={() => void setGrant({ capabilityKey, enabledMode })}
                size="sm"
                variant="outline"
              >
                {enabled ? "Disable" : "Enable"}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
