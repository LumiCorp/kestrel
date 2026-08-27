"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  OrganizationReceivingController,
  type ReceivingConnection,
  type ReceivingDomain,
} from "@/components/settings/receiving-client-controller";
import {
  SettingsRow,
  SettingsRows,
  SettingsSection,
  SettingsStatusNotice,
  SettingsStatusSummary,
} from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function OrganizationReceivingClient() {
  const [connection, setConnection] = useState<ReceivingConnection>();
  const [domains, setDomains] = useState<ReceivingDomain[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [domainId, setDomainId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const controllerRef = useRef<OrganizationReceivingController | null>(null);

  useEffect(() => {
    const controller = new OrganizationReceivingController({
      setApiKey,
      setBusy,
      setConnection,
      setDomainId,
      setDomains,
      setError,
      showInfo: (message) => toast.info(message),
      showSuccess: (message) => toast.success(message),
    });
    controllerRef.current = controller;
    void controller.load();
    return () => {
      controller.deactivate();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
  }, []);

  async function inspectDomains() {
    await controllerRef.current?.inspectDomains(apiKey);
  }

  async function save() {
    await controllerRef.current?.save(apiKey, domainId);
  }

  async function setInboundEnabled(enabled: boolean) {
    if (
      enabled &&
      !window.confirm(
        "Enable inbound receiving? New emails sent to enabled private Triggers can create agent work.",
      )
    ) {
      return;
    }
    if (
      !enabled &&
      !window.confirm(
        "Disable inbound receiving? New emails will stop. Existing Threads and turns continue.",
      )
    ) {
      return;
    }
    await controllerRef.current?.setInboundEnabled(enabled);
  }

  const selected = domains.find((domain) => domain.id === domainId);
  const selectedReady =
    selected?.receiving === "enabled" &&
    selected.status === "verified" &&
    selected.mxStatus === "verified";

  return (
    <>
      <SettingsSection
        description="Kestrel One hosts inbound receiving. This is separate from outbound sending and remains available when Desktop is closed."
        title="Inbound receiving"
      >
        {error ? (
          <SettingsStatusNotice
            description="No credential, locator, provider identifier, or receiving address was included in this error."
            title={error}
            tone="error"
          />
        ) : null}
        <SettingsRows>
          <SettingsRow label="Overall readiness">
            <SettingsStatusSummary
              detail={`Inbound: ${connection?.inboundEnabled ? "enabled" : "disabled"}`}
              status={connection?.readiness.replaceAll("_", " ") ?? "Loading"}
              tone="neutral"
            />
          </SettingsRow>
          <SettingsRow label="Credential">
            <SettingsStatusSummary
              detail="Resend Full access is required; Sending access is not sufficient."
              status={connection?.credentialStatus.replaceAll("_", " ") ?? "Loading"}
              tone={connection?.credentialStatus === "full_access" ? "positive" : "warning"}
            />
          </SettingsRow>
          <SettingsRow label="Receiving domain">
            <SettingsStatusSummary
              detail={`MX: ${connection?.mxStatus ?? "unknown"}`}
              status={connection?.receivingDomain ?? "Not selected"}
              tone={connection?.receivingDomainStatus === "verified" ? "positive" : "neutral"}
            />
          </SettingsRow>
          <SettingsRow label="Webhook">
            <SettingsStatusSummary
              detail="Delivery stays disabled until the complete email-to-agent path is ready."
              status={connection?.webhookStatus.replaceAll("_", " ") ?? "Not staged"}
              tone="neutral"
            />
          </SettingsRow>
          <SettingsRow label="Activation">
            <SettingsStatusSummary
              detail={connection?.inboundEnabled
                ? "New email can create work through enabled private Triggers."
                : activationBlocker(connection?.readiness)}
              status={connection?.inboundEnabled ? "Enabled" : "Disabled"}
              tone={connection?.inboundEnabled ? "positive" : "warning"}
            />
          </SettingsRow>
          <SettingsRow label="Health evidence">
            <SettingsStatusSummary
              detail={`Credential validated: ${formatEvidenceTime(connection?.credentialValidatedAt)} · Domain checked: ${formatEvidenceTime(connection?.domainCheckedAt)}`}
              status={`Health checked: ${formatEvidenceTime(connection?.lastHealthCheckedAt)}`}
              tone="neutral"
            />
          </SettingsRow>
          <SettingsRow label="Test and failure evidence">
            <SettingsStatusSummary
              detail={`Last failure: ${connection?.lastErrorCode ?? "None"}`}
              status={`Last test: ${formatEvidenceTime(connection?.lastTestedAt)}`}
              tone={connection?.lastErrorCode ? "warning" : "neutral"}
            />
          </SettingsRow>
        </SettingsRows>
        <div className="grid max-w-3xl gap-5 pt-5">
          <div className="grid gap-2">
            <Label htmlFor="receiving-api-key">Resend Full access API key</Label>
            <Input
              autoComplete="off"
              id="receiving-api-key"
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={connection?.configured ? "Configured — enter a new key to rotate" : "re_..."}
              type="password"
              value={apiKey}
            />
            <p className="text-muted-foreground text-sm">
              Write-only. Kestrel encrypts the key and never returns it.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || !(apiKey || connection?.configured)}
              onClick={() => void inspectDomains()}
              type="button"
              variant="outline"
            >
              {busy ? "Checking…" : "Check key and domains"}
            </Button>
          </div>
          {domains.length ? (
            <div className="grid gap-2">
              <Label htmlFor="receiving-domain">Verified receiving subdomain</Label>
              <Select onValueChange={setDomainId} value={domainId}>
                <SelectTrigger id="receiving-domain"><SelectValue placeholder="Choose a domain" /></SelectTrigger>
                <SelectContent>
                  {domains.map((domain) => {
                    const ready =
                      domain.receiving === "enabled" &&
                      domain.status === "verified" &&
                      domain.mxStatus === "verified";
                    return (
                      <SelectItem disabled={!ready} key={domain.id} value={domain.id}>
                        {domain.name} · {ready ? "ready" : `${domain.status}, MX ${domain.mxStatus}`}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div>
            <Button disabled={busy || !selectedReady} onClick={() => void save()}>
              {busy ? "Saving…" : "Save inbound receiving"}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {connection?.inboundEnabled || shouldRetryDisable(connection) ? (
              <Button
                disabled={busy}
                onClick={() => void setInboundEnabled(false)}
                type="button"
                variant="destructive"
              >
                {shouldRetryDisable(connection)
                  ? "Retry disabling inbound receiving"
                  : "Disable inbound receiving"}
              </Button>
            ) : (
              <Button
                disabled={busy || !canActivate(connection)}
                onClick={() => void setInboundEnabled(true)}
                type="button"
              >
                Enable inbound receiving
              </Button>
            )}
            <p className="text-muted-foreground text-sm">
              {connection?.inboundEnabled
                ? "Disablement stops new email at Kestrel One. Existing work continues."
                : "Kestrel One enables the staged Resend webhook only after it rechecks current receiving health."}
            </p>
          </div>
        </div>
      </SettingsSection>
    </>
  );
}

function formatEvidenceTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "Never";
}

function canActivate(connection: ReceivingConnection | undefined) {
  return (
    connection?.readiness === "staged" ||
    (connection?.readiness === "error" && !shouldRetryDisable(connection))
  );
}

function shouldRetryDisable(connection: ReceivingConnection | undefined) {
  return connection?.lastErrorCode === "RESEND_RECEIVING_WEBHOOK_DISABLE_FAILED";
}

function activationBlocker(readiness: ReceivingConnection["readiness"] | undefined) {
  switch (readiness) {
    case "staged":
      return "The staged webhook is ready for Kestrel One to verify and enable.";
    case "not_configured":
      return "Configure a Resend Full access key and receiving domain first.";
    case "credential_insufficient":
      return "A Resend Full access key is required.";
    case "domain_unready":
      return "Choose a verified receiving domain with healthy MX records.";
    case "ready_inactive":
      return "Kestrel One is waiting for the receiving webhook to be staged.";
    case "error":
      return "Kestrel One will recheck the staged webhook before retrying the last requested action.";
    default:
      return "Loading current receiving readiness.";
  }
}
