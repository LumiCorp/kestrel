"use client";

import Link from "next/link";
import type { ReactNode } from "react";
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

export function OrganizationReceivingClient({
  requiresPublicWebhookUrl,
}: {
  requiresPublicWebhookUrl: boolean;
}) {
  const [connection, setConnection] = useState<ReceivingConnection>();
  const [domains, setDomains] = useState<ReceivingDomain[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [domainId, setDomainId] = useState("");
  const [managedDomain, setManagedDomain] = useState("");
  const [webhookBaseUrl, setWebhookBaseUrl] = useState("");
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
      setManagedDomain,
      setWebhookBaseUrl,
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
    await controllerRef.current?.save(
      apiKey,
      domainId,
      managedDomain,
      webhookBaseUrl,
    );
  }

  async function setInboundEnabled(enabled: boolean) {
    if (
      enabled &&
      !window.confirm(
        "Enable inbound email? New messages sent to enabled Email Triggers can create agent work.",
      )
    ) {
      return;
    }
    if (
      !(
        enabled ||
        window.confirm(
          "Disable inbound email? New messages will stop. Existing Threads and turns continue.",
        )
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
  const hasConnectionInput = Boolean(managedDomain.trim() || selectedReady);
  const canSave = Boolean(
    !busy &&
      hasConnectionInput &&
      (apiKey || connection?.configured) &&
      (!requiresPublicWebhookUrl || webhookBaseUrl.trim()),
  );

  return (
    <SettingsSection
      description="Give people an email address that creates agent work. Each address is configured as an Email Trigger."
      title="Inbound email"
    >
      {error ? (
        <SettingsStatusNotice
          description="Correct the setup step below and try again. Secrets and receiving addresses are not included in this error."
          title={error}
          tone="error"
        />
      ) : null}

      <ol className="grid max-w-3xl gap-8">
        <SetupStep
          description={
            requiresPublicWebhookUrl
              ? "Resend must be able to reach this local Kestrel instance."
              : "Kestrel uses this deployment's public URL automatically."
          }
          number={1}
          title={
            requiresPublicWebhookUrl
              ? "Connect local development to the internet"
              : "Confirm the webhook destination"
          }
        >
          {requiresPublicWebhookUrl ? (
            <div className="grid gap-2">
              <Label htmlFor="receiving-webhook-base-url">
                Public tunnel URL
              </Label>
              <Input
                autoCapitalize="none"
                autoComplete="off"
                id="receiving-webhook-base-url"
                inputMode="url"
                onChange={(event) => setWebhookBaseUrl(event.target.value)}
                placeholder="https://your-subdomain.ngrok.app"
                spellCheck={false}
                type="url"
                value={webhookBaseUrl}
              />
              <p className="text-muted-foreground text-sm">
                Start ngrok or another tunnel for port 43103, then paste its
                HTTPS origin. Kestrel adds the private inbound route.
              </p>
            </div>
          ) : (
            <SettingsStatusSummary
              detail="No webhook URL needs to be entered."
              status="Automatic"
              tone="positive"
            />
          )}
        </SetupStep>

        <SetupStep
          description="Use the receiving domain Resend assigned to your account and a Full Access API key."
          number={2}
          title="Connect Resend"
        >
          <div className="grid gap-5">
            <div className="grid gap-2">
              <Label htmlFor="managed-receiving-domain">
                Resend-managed receiving domain
              </Label>
              <Input
                autoCapitalize="none"
                id="managed-receiving-domain"
                onChange={(event) => {
                  setManagedDomain(event.target.value);
                  setDomainId("");
                }}
                placeholder="example.resend.app"
                spellCheck={false}
                value={managedDomain}
              />
              <p className="text-muted-foreground text-sm">
                Enter the <code>*.resend.app</code> domain shown in Resend. You
                will choose each address alias when creating an Email Trigger.
              </p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="receiving-api-key">
                Resend Full Access API key
              </Label>
              <Input
                autoComplete="off"
                id="receiving-api-key"
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={
                  connection?.configured
                    ? "Configured — enter a new key to rotate"
                    : "re_..."
                }
                type="password"
                value={apiKey}
              />
              <p className="text-muted-foreground text-sm">
                Sending-only keys cannot configure receiving. Kestrel encrypts
                this key and never returns it.
              </p>
            </div>

            <div>
              <Button disabled={!canSave} onClick={() => void save()}>
                {busy
                  ? "Connecting…"
                  : connection?.configured
                    ? "Update Resend connection"
                    : "Connect Resend"}
              </Button>
            </div>

            <details className="rounded-lg border px-4 py-3">
              <summary className="cursor-pointer font-medium text-sm">
                Use a custom receiving domain instead
              </summary>
              <div className="grid gap-4 pt-4">
                <p className="text-muted-foreground text-sm">
                  Custom domains require verified DNS and healthy MX records in
                  Resend.
                </p>
                <div>
                  <Button
                    disabled={busy || !(apiKey || connection?.configured)}
                    onClick={() => void inspectDomains()}
                    type="button"
                    variant="outline"
                  >
                    {busy ? "Checking…" : "Check key and custom domains"}
                  </Button>
                </div>
                {domains.length ? (
                  <div className="grid gap-2">
                    <Label htmlFor="receiving-domain">Receiving domain</Label>
                    <Select
                      onValueChange={(value) => {
                        setDomainId(value);
                        setManagedDomain("");
                      }}
                      value={domainId}
                    >
                      <SelectTrigger id="receiving-domain">
                        <SelectValue placeholder="Choose a domain" />
                      </SelectTrigger>
                      <SelectContent>
                        {domains.map((domain) => {
                          const ready =
                            domain.receiving === "enabled" &&
                            domain.status === "verified" &&
                            domain.mxStatus === "verified";
                          return (
                            <SelectItem
                              disabled={!ready}
                              key={domain.id}
                              value={domain.id}
                            >
                              {domain.name} ·{" "}
                              {ready
                                ? "ready"
                                : `${domain.status}, MX ${domain.mxStatus}`}
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
              </div>
            </details>
          </div>
        </SetupStep>

        <SetupStep
          description="Kestrel stages the Resend webhook during connection, then runs its readiness checks when you enable it."
          number={3}
          title="Turn on inbound email"
        >
          <div className="flex flex-wrap items-center gap-3">
            {connection?.inboundEnabled || shouldRetryDisable(connection) ? (
              <Button
                disabled={busy}
                onClick={() => void setInboundEnabled(false)}
                type="button"
                variant="destructive"
              >
                {shouldRetryDisable(connection)
                  ? "Retry disabling inbound email"
                  : "Disable inbound email"}
              </Button>
            ) : (
              <Button
                disabled={busy || !canActivate(connection)}
                onClick={() => void setInboundEnabled(true)}
                type="button"
              >
                Enable inbound email
              </Button>
            )}
            <SettingsStatusSummary
              detail={
                connection?.inboundEnabled
                  ? "Messages can create agent work."
                  : activationBlocker(connection?.readiness)
              }
              status={connection?.inboundEnabled ? "Enabled" : "Not enabled"}
              tone={connection?.inboundEnabled ? "positive" : "warning"}
            />
          </div>
        </SetupStep>

        <SetupStep
          description="Create an Email Trigger for each address. The alias you choose becomes the part before @."
          number={4}
          title="Create email addresses"
        >
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild variant="outline">
              <Link href="/triggers">Open Email Triggers</Link>
            </Button>
            <p className="text-muted-foreground text-sm">
              {connection?.receivingDomain
                ? `Example: support@${connection.receivingDomain}`
                : "Connect Resend first to establish the address domain."}
            </p>
          </div>
        </SetupStep>
      </ol>

      <details className="mt-8 max-w-3xl rounded-lg border px-4 py-3">
        <summary className="cursor-pointer font-medium text-sm">
          Technical status
        </summary>
        <SettingsRows className="mt-4">
          <SettingsRow label="Overall readiness">
            <SettingsStatusSummary
              detail={`Inbound: ${connection?.inboundEnabled ? "enabled" : "disabled"}`}
              status={connection?.readiness.replaceAll("_", " ") ?? "Loading"}
              tone="neutral"
            />
          </SettingsRow>
          <SettingsRow label="Credential">
            <SettingsStatusSummary
              detail="Resend Full Access is required."
              status={
                connection?.credentialStatus.replaceAll("_", " ") ??
                "Loading"
              }
              tone={
                connection?.credentialStatus === "full_access"
                  ? "positive"
                  : "warning"
              }
            />
          </SettingsRow>
          <SettingsRow label="Receiving domain">
            <SettingsStatusSummary
              detail={
                connection?.receivingDomainKind === "resend_managed"
                  ? "Managed by Resend"
                  : `MX: ${connection?.mxStatus ?? "unknown"}`
              }
              status={connection?.receivingDomain ?? "Not selected"}
              tone={
                connection?.receivingDomainStatus === "verified"
                  ? "positive"
                  : "neutral"
              }
            />
          </SettingsRow>
          <SettingsRow label="Webhook">
            <SettingsStatusSummary
              detail="Delivery remains closed until activation succeeds."
              status={
                connection?.webhookStatus.replaceAll("_", " ") ?? "Not staged"
              }
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
      </details>
    </SettingsSection>
  );
}

function SetupStep({
  children,
  description,
  number,
  title,
}: {
  children: ReactNode;
  description: string;
  number: number;
  title: string;
}) {
  return (
    <li className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3">
      <div className="flex size-8 items-center justify-center rounded-full border bg-muted font-semibold text-sm">
        {number}
      </div>
      <div className="grid gap-4 pt-1">
        <div>
          <h3 className="font-semibold text-sm">{title}</h3>
          <p className="mt-1 text-muted-foreground text-sm">{description}</p>
        </div>
        {children}
      </div>
    </li>
  );
}

function formatEvidenceTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "Never";
}

function canActivate(connection: ReceivingConnection | undefined) {
  return connection?.readiness === "staged";
}

function shouldRetryDisable(connection: ReceivingConnection | undefined) {
  return (
    connection?.lastErrorCode === "RESEND_RECEIVING_WEBHOOK_DISABLE_FAILED"
  );
}

function activationBlocker(
  readiness: ReceivingConnection["readiness"] | undefined,
) {
  switch (readiness) {
    case "staged":
      return "The Resend webhook is staged and ready.";
    case "not_configured":
      return "Complete the Resend connection first.";
    case "credential_insufficient":
      return "Replace the key with a Resend Full Access key.";
    case "domain_unready":
      return "Finish verifying the receiving domain in Resend.";
    case "ready_inactive":
      return "Reconnect Resend to stage the webhook.";
    case "error":
      return "Correct the connection error above, then reconnect Resend.";
    default:
      return "Loading current readiness.";
  }
}
