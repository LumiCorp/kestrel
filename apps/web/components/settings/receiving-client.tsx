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
        </div>
      </SettingsSection>
    </>
  );
}

function formatEvidenceTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "Never";
}
