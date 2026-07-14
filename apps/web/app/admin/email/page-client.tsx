"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminStatusBanner } from "@/components/admin/admin-status-banner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

export function EmailIntegrationAdminClient() {
  const [config, setConfig] = useState(emptyConfig);
  const [events, setEvents] = useState<EmailEvent[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Loading email configuration...");

  async function load() {
    const response = await fetch("/api/admin/email", {
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
  }

  useEffect(() => {
    void load();
  }, []);

  async function save(nextEnabled = config.enabled) {
    setBusy(true);
    const response = await fetch("/api/admin/email", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        credentialSource: config.credentialSource,
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
    const response = await fetch("/api/admin/email/test", {
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
    <div className="space-y-6">
      <AdminPageHeader
        description="Configure platform-wide transactional email delivery. Domain verification remains managed in Resend."
        eyebrow="Admin · Email delivery"
        title="Email"
      />
      {message ? (
        <AdminStatusBanner
          description="Email configuration could not be loaded."
          title={message}
          variant="error"
        />
      ) : null}
      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            Resend
            <Badge
              variant={config.status === "ready" ? "default" : "secondary"}
            >
              {config.status.replace("_", " ")}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="grid gap-2">
            <Label htmlFor="email-source">Credential source</Label>
            <Select
              onValueChange={(
                credentialSource: EmailConfig["credentialSource"]
              ) => setConfig((current) => ({ ...current, credentialSource }))}
              value={config.credentialSource}
            >
              <SelectTrigger id="email-source">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="environment">
                  Environment (RESEND_API_KEY)
                </SelectItem>
                <SelectItem value="stored">Encrypted in Kestrel One</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {config.credentialSource === "stored" ? (
            <div className="grid gap-2">
              <Label htmlFor="email-api-key">Resend API key</Label>
              <Input
                autoComplete="off"
                id="email-api-key"
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={
                  config.credentialConfigured
                    ? "Configured — enter a new key to rotate"
                    : "re_..."
                }
                type="password"
                value={apiKey}
              />
            </div>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="email-from-name"
              label="From name"
              onChange={(fromName) =>
                setConfig((current) => ({ ...current, fromName }))
              }
              value={config.fromName}
            />
            <Field
              id="email-from-address"
              label="From address"
              onChange={(fromEmail) =>
                setConfig((current) => ({ ...current, fromEmail }))
              }
              type="email"
              value={config.fromEmail}
            />
          </div>
          <Field
            id="email-reply-to"
            label="Reply-to (optional)"
            onChange={(replyTo) =>
              setConfig((current) => ({ ...current, replyTo: replyTo || null }))
            }
            type="email"
            value={config.replyTo || ""}
          />
          <div className="flex flex-wrap gap-3">
            <Button disabled={busy} onClick={() => void save()}>
              Save configuration
            </Button>
            <Button
              disabled={busy || !config.persisted}
              onClick={() => void testDelivery()}
              variant="outline"
            >
              Send test email
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <Label htmlFor="email-enabled">Enabled</Label>
              <Switch
                checked={config.enabled}
                disabled={
                  busy || (config.status !== "ready" && !config.enabled)
                }
                id="email-enabled"
                onCheckedChange={(enabled) => void save(enabled)}
              />
            </div>
          </div>
          {config.lastTestedAt ? (
            <p className="text-muted-foreground text-sm">
              Last accepted test:{" "}
              {new Date(config.lastTestedAt).toLocaleString()}
            </p>
          ) : null}
        </CardContent>
      </Card>
      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>Platform email activity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {events.length ? (
            events.map((event) => (
              <div
                className="flex items-start justify-between gap-4 border-b pb-3 text-sm"
                key={event.id}
              >
                <div>
                  <div className="font-medium">{event.message}</div>
                  <div className="text-muted-foreground">{event.action}</div>
                </div>
                <time className="whitespace-nowrap text-muted-foreground">
                  {new Date(event.createdAt).toLocaleString()}
                </time>
              </div>
            ))
          ) : (
            <p className="text-muted-foreground text-sm">
              No platform email events yet.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
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
