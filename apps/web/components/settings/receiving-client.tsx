"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
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

type ReceivingConnection = {
  provider: "resend";
  configured: boolean;
  credentialStatus: "not_configured" | "full_access" | "insufficient" | "error";
  credentialValidatedAt: string | null;
  receivingDomain: string | null;
  receivingDomainStatus: "not_selected" | "pending" | "verified" | "failed";
  mxStatus: "unknown" | "pending" | "verified" | "failed";
  domainCheckedAt: string | null;
  webhookStatus: "not_staged" | "staged" | "active" | "disabled" | "error";
  inboundEnabled: boolean;
  lastHealthCheckedAt: string | null;
  lastTestedAt: string | null;
  lastErrorCode: string | null;
  readiness: string;
};

type Domain = {
  id: string;
  name: string;
  status: "pending" | "verified" | "failed";
  receiving: "enabled" | "disabled";
  mxStatus: "unknown" | "pending" | "verified" | "failed";
};

export function OrganizationReceivingClient() {
  const [connection, setConnection] = useState<ReceivingConnection>();
  const [domains, setDomains] = useState<Domain[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [domainId, setDomainId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    const response = await fetch("/api/organization/email/receiving", {
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(body.error || "Could not load inbound receiving.");
      return;
    }
    setConnection(body.connection);
    setError(undefined);
  }, []);

  useEffect(() => void load(), [load]);

  async function inspectDomains() {
    setBusy(true);
    const response = await fetch(
      "/api/organization/email/receiving/domains",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey || undefined }),
      },
    );
    const body = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setError(body.error || "Could not inspect Resend receiving domains.");
      return;
    }
    setDomains(body.domains || []);
    setError(undefined);
    if (!(body.domains || []).length) {
      toast.info("No Resend receiving domains are available for this key.");
    }
  }

  async function save() {
    setBusy(true);
    const response = await fetch("/api/organization/email/receiving", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        apiKey: apiKey || undefined,
        receivingDomainId: domainId,
      }),
    });
    const body = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setError(body.error || "Could not save inbound receiving.");
      return;
    }
    setConnection(body.connection);
    setApiKey("");
    setDomainId("");
    setDomains([]);
    setError(undefined);
    toast.success("Inbound receiving configuration saved.");
    await load();
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
