"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  SettingsDisclosure,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsRows,
  SettingsSection,
  SettingsStatusNotice,
  SettingsStatusSummary,
} from "@/components/settings/settings-section";
import { Badge } from "@/components/ui/badge";
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
import { Switch } from "@/components/ui/switch";

type EmailConfig = {
  provider: "resend";
  enabled: boolean;
  credentialSource: "stored" | "environment";
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  status: "disabled" | "not_configured" | "needs_test" | "ready" | "error";
  credentialConfigured: boolean;
  lastTestedAt: string | null;
  persisted: boolean;
};

type EmailEvent = {
  id: string;
  action: string;
  message: string;
  createdAt: string;
};

const emptyConfig: EmailConfig = {
  provider: "resend",
  enabled: false,
  credentialSource: "environment",
  fromName: "Kestrel One",
  fromEmail: "",
  replyTo: null,
  status: "not_configured",
  credentialConfigured: false,
  lastTestedAt: null,
  persisted: false,
};

export function EmailIntegrationAdminClient({
  scope = "platform",
  children,
}: {
  scope?: "platform" | "organization";
  children?: ReactNode;
}) {
  const [config, setConfig] = useState(emptyConfig);
  const [events, setEvents] = useState<EmailEvent[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Loading email configuration...");
  const apiBase =
    scope === "organization" ? "/api/organization/email" : "/api/platform/email";
  const hasTestPrerequisites = Boolean(
    config.credentialConfigured && config.fromEmail.trim()
  );
  const configured = config.persisted && hasTestPrerequisites;
  const tested = config.status === "ready" || config.enabled;

  const load = useCallback(async () => {
    const response = await fetch(apiBase, {
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setMessage(body.error || "Failed to load email configuration.");
      return;
    }
    setConfig({ ...emptyConfig, ...body.config });
    setEvents(body.events || []);
    setMessage("");
  }, [apiBase]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(nextEnabled = config.enabled) {
    setBusy(true);
    const response = await fetch(apiBase, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        credentialSource:
          scope === "organization" ? "stored" : config.credentialSource,
        apiKey: apiKey || undefined,
        fromName: config.fromName,
        fromEmail: config.fromEmail,
        replyTo: config.replyTo || null,
        enabled: nextEnabled,
      }),
    });
    const body = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      toast.error(body.error || "Failed to save email configuration.");
      return;
    }
    setConfig({ ...emptyConfig, ...body.config });
    setApiKey("");
    toast.success(
      body.config.enabled
        ? "Email delivery enabled."
        : "Email configuration saved."
    );
    await load();
  }

  async function testDelivery() {
    setBusy(true);
    const response = await fetch(`${apiBase}/test`, {
      method: "POST",
    });
    const body = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      toast.error(body.error || "Email test failed.");
      await load();
      return;
    }
    setConfig({ ...emptyConfig, ...body.config });
    toast.success("Resend accepted the test email.");
    await load();
  }

  return (
    <SettingsPage>
      <SettingsPageHeader
        description={
          scope === "organization"
            ? "Configure the sender used by this organization's Apps and agents. Domain verification remains managed in Resend."
            : "Configure platform-wide authentication and system email delivery. Domain verification remains managed in Resend."
        }
        eyebrow={
          scope === "organization"
            ? "Organization · App email"
            : "Platform · System email"
        }
        title={scope === "organization" ? "Organization email" : "System email"}
      />
      {message ? (
        <SettingsStatusNotice
          description="The last saved state remains unchanged."
          title={message}
          tone="error"
        />
      ) : null}
      <SettingsSection
        description="Complete each step in order. Delivery cannot be enabled until Resend accepts a test message."
        title="Readiness"
      >
        <SettingsRows>
          <SettingsRow label="1 · Configure">
            <SettingsStatusSummary
              detail={configured ? config.fromEmail : "Sender and credential required"}
              status={configured ? "Complete" : "Next action"}
              tone={configured ? "positive" : "warning"}
            />
          </SettingsRow>
          <SettingsRow label="2 · Test">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <SettingsStatusSummary
                detail={config.lastTestedAt ? new Date(config.lastTestedAt).toLocaleString() : "Not tested"}
                status={tested ? "Accepted" : configured ? "Ready to test" : "Waiting"}
                tone={tested ? "positive" : configured ? "warning" : "neutral"}
              />
              <Button
                disabled={busy || !configured}
                onClick={() => void testDelivery()}
                size="sm"
                variant="outline"
              >
                Send test email
              </Button>
            </div>
          </SettingsRow>
          <SettingsRow label="3 · Enable">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <SettingsStatusSummary
                detail="Production delivery"
                status={config.enabled ? "Enabled" : tested ? "Ready to enable" : "Waiting"}
                tone={config.enabled ? "positive" : tested ? "warning" : "neutral"}
              />
              <div className="flex items-center gap-2">
                <Label htmlFor="email-enabled">Enabled</Label>
                <Switch
                  checked={config.enabled}
                  disabled={busy || !(tested || config.enabled)}
                  id="email-enabled"
                  onCheckedChange={(enabled) => void save(enabled)}
                />
              </div>
            </div>
          </SettingsRow>
        </SettingsRows>
      </SettingsSection>

      {children}

      <SettingsSection
        description="Sender identity and credential changes are saved without enabling delivery."
        title="Configuration"
      >
        <SettingsDisclosure
          defaultOpen={!configured}
          description={`${config.provider} · ${config.status.replace("_", " ")}`}
          title={configured ? "Edit sender and credentials" : "Configure sender and credentials"}
        >
          <div className="grid max-w-3xl gap-5">
            {scope === "platform" ? (
              <div className="grid gap-2">
                <Label htmlFor="email-source">Credential source</Label>
                <Select
                  onValueChange={(credentialSource: EmailConfig["credentialSource"]) =>
                    setConfig((current) => ({ ...current, credentialSource }))
                  }
                  value={config.credentialSource}
                >
                  <SelectTrigger id="email-source"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="environment">Environment (RESEND_API_KEY)</SelectItem>
                    <SelectItem value="stored">Encrypted in Kestrel One</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {scope === "organization" || config.credentialSource === "stored" ? (
              <div className="grid gap-2">
                <Label htmlFor="email-api-key">Resend API key</Label>
                <Input
                  autoComplete="off"
                  id="email-api-key"
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={config.credentialConfigured ? "Configured — enter a new key to rotate" : "re_..."}
                  type="password"
                  value={apiKey}
                />
              </div>
            ) : null}
            {scope === "platform" && config.credentialSource === "environment" && !config.credentialConfigured ? (
              <SettingsStatusNotice
                description="Set it in the deployment environment, or store an encrypted Resend key here."
                title="RESEND_API_KEY is unavailable to this deployment."
                tone="warning"
              />
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="email-from-name" label="From name" onChange={(fromName) => setConfig((current) => ({ ...current, fromName }))} value={config.fromName} />
              <Field id="email-from-address" label="From address" onChange={(fromEmail) => setConfig((current) => ({ ...current, fromEmail }))} type="email" value={config.fromEmail} />
            </div>
            <Field id="email-reply-to" label="Reply-to (optional)" onChange={(replyTo) => setConfig((current) => ({ ...current, replyTo: replyTo || null }))} type="email" value={config.replyTo || ""} />
            <div><Button disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save configuration"}</Button></div>
          </div>
        </SettingsDisclosure>
      </SettingsSection>

      <SettingsSection
        description="Recent configuration, test, and delivery events."
        title="Activity"
      >
        <SettingsDisclosure
          description={`${events.length} recent event${events.length === 1 ? "" : "s"}`}
          title={scope === "organization" ? "Organization email activity" : "Platform email activity"}
        >
          <div className="divide-y border-y">
            {events.length ? events.map((event) => (
              <div className="flex flex-col justify-between gap-1 py-3 text-sm sm:flex-row sm:gap-4" key={event.id}>
                <div><div className="font-medium">{event.message}</div><div className="text-muted-foreground">{event.action}</div></div>
                <time className="whitespace-nowrap text-muted-foreground">{new Date(event.createdAt).toLocaleString()}</time>
              </div>
            )) : <p className="py-4 text-muted-foreground text-sm">No {scope} email events yet.</p>}
          </div>
        </SettingsDisclosure>
      </SettingsSection>
    </SettingsPage>
  );
}

function Field({
  id,
  label,
  onChange,
  type = "text",
  value,
}: {
  id: string;
  label: string;
  onChange: (value: string) => void;
  type?: string;
  value: string;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        onChange={(event) => onChange(event.target.value)}
        type={type}
        value={value}
      />
    </div>
  );
}
