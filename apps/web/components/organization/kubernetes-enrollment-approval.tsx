"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  SettingsPage,
  SettingsPageHeader,
  SettingsRows,
  SettingsRow,
  SettingsSection,
  SettingsStatusNotice,
} from "@/components/settings/settings-section";

export function KubernetesEnrollmentApproval({
  enrollment,
}: {
  enrollment: {
    id: string;
    connectorName: string;
    connectorVersion: string;
    fingerprint: string;
    status: string;
    expiresAt: string | Date;
  };
}) {
  const router = useRouter();
  const [fingerprint, setFingerprint] = useState("");
  const [busy, setBusy] = useState(false);
  async function approve() {
    setBusy(true);
    try {
      const response = await fetch(
        `/api/organization/infrastructure/kubernetes/enrollments/${enrollment.id}/approve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fingerprint: fingerprint.trim() }),
        },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Connector approval failed.");
      toast.success("Kubernetes connector approved.");
      router.push("/organization/connections");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Connector approval failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <SettingsPage>
      <SettingsPageHeader
        description="Compare this fingerprint with the value printed by the Helm installation before approving the shared connector identity."
        eyebrow="Kubernetes BYOC"
        title="Verify connector"
      />
      {enrollment.status !== "pending" ? (
        <SettingsStatusNotice description="Return to Connections to inspect its current state." title={`Enrollment is ${enrollment.status}`} tone="info" />
      ) : null}
      <SettingsSection title="Enrollment request">
        <SettingsRows>
          <SettingsRow label="Connector">{enrollment.connectorName}</SettingsRow>
          <SettingsRow label="Version">{enrollment.connectorVersion}</SettingsRow>
          <SettingsRow label="Expires">{new Date(enrollment.expiresAt).toLocaleString()}</SettingsRow>
          <SettingsRow label="Expected fingerprint">
            <code className="break-all text-xs">{enrollment.fingerprint}</code>
          </SettingsRow>
        </SettingsRows>
        {enrollment.status === "pending" ? (
          <div className="mt-5 max-w-xl space-y-3">
            <Label htmlFor="connector-fingerprint">Fingerprint from Helm</Label>
            <Input id="connector-fingerprint" onChange={(event) => setFingerprint(event.target.value)} spellCheck={false} value={fingerprint} />
            <Button disabled={busy || fingerprint.trim() !== enrollment.fingerprint} onClick={() => void approve()}>
              {busy ? "Approving…" : "Approve matching fingerprint"}
            </Button>
          </div>
        ) : null}
      </SettingsSection>
    </SettingsPage>
  );
}
