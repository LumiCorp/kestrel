"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  SettingsDangerSection,
  SettingsDisclosure,
  SettingsStatusNotice,
} from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function OrganizationDeletePanel({
  organizationName,
  operation,
}: {
  organizationName: string;
  operation: {
    status: string;
    stage: string;
    errorMessage: string | null;
    inventory: Record<string, unknown> | null;
  } | null;
}) {
  const router = useRouter();
  const [confirmationName, setConfirmationName] = useState("");
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    try {
      const response = await fetch("/api/organization/deletion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmationName }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok)
        throw new Error(
          payload?.error ?? "Organization deletion could not start.",
        );
      toast.success(
        "Organization teardown requested. You will be returned to your Personal workspace when it completes.",
      );
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Organization deletion could not start.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function retry() {
    setBusy(true);
    try {
      const response = await fetch("/api/organization/deletion", {
        method: "PATCH",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok)
        throw new Error(
          payload?.error ?? "Organization deletion retry failed.",
        );
      toast.success("Organization teardown retry requested.");
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Organization deletion retry failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (operation) {
    return (
      <div className="space-y-6">
        <SettingsStatusNotice
          description={
            operation.status === "failed"
              ? operation.errorMessage ||
                "The failed stage remains available for review and retry."
              : `Current stage: ${operation.stage}`
          }
          title={
            operation.status === "failed"
              ? "Deletion needs attention"
              : "Deletion in progress"
          }
          tone={operation.status === "failed" ? "error" : "info"}
        />
        {operation.status === "failed" ? (
          <Button
            disabled={busy}
            onClick={() => void retry()}
            variant="outline"
          >
            {busy ? "Retrying…" : "Retry teardown"}
          </Button>
        ) : null}
        <SettingsDisclosure
          description="Stage, status, error, and captured inventory."
          title="Technical evidence"
        >
          <div className="space-y-3 text-sm">
            <p>
              <span className="text-muted-foreground">Stage:</span>{" "}
              {operation.stage}
            </p>
            <p>
              <span className="text-muted-foreground">Status:</span>{" "}
              {operation.status}
            </p>
            {operation.errorMessage ? (
              <p className="text-destructive">{operation.errorMessage}</p>
            ) : null}
            {operation.inventory ? (
              <pre className="overflow-x-auto bg-muted p-3 text-xs">
                {JSON.stringify(operation.inventory, null, 2)}
              </pre>
            ) : null}
          </div>
        </SettingsDisclosure>
      </div>
    );
  }
  return (
    <SettingsDangerSection
      description="This removes every Environment, Workspace machine and volume, managed compute resource, and organization record."
      title="Permanent deletion"
    >
      <div className="space-y-5">
        <SettingsStatusNotice
          description="Cancel any paid subscription in Billing before continuing. Deletion remains blocked while billing preconditions are unmet."
          title="Billing must be settled first"
          tone="warning"
        />
        <div className="space-y-2">
          <Label htmlFor="organization-delete-confirmation">
            Type {organizationName} to confirm
          </Label>
          <Input
            id="organization-delete-confirmation"
            onChange={(event) => setConfirmationName(event.target.value)}
            value={confirmationName}
          />
        </div>
        <Button
          disabled={busy || confirmationName !== organizationName}
          onClick={() => void remove()}
          variant="destructive"
        >
          {busy ? "Requesting…" : "Delete organization"}
        </Button>
      </div>
    </SettingsDangerSection>
  );
}
