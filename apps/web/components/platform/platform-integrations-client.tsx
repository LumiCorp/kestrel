"use client";

import { useCallback, useEffect, useState } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

type Provider = "google_workspace" | "microsoft_365";
type Pack = "gmail" | "calendar" | "teams";

type Registration = {
  provider: Provider;
  displayName: string;
  enabled: boolean;
  clientId: string | null;
  tenantOrIssuer: string | null;
  enabledPacks: Pack[];
  supportedPacks: Array<{ id: Pack; label: string; scopes: string[] }>;
  callbackUri: string;
  baseScopes: string[];
  scopes: string[];
  status: "not_configured" | "disabled" | "ready";
  credentialConfigured: boolean;
  revision: number | null;
  persisted: boolean;
  updatedAt: string | null;
};

type Event = {
  id: string;
  action: string;
  message: string;
  createdAt: string;
};

const empty: Registration[] = [
  {
    provider: "google_workspace",
    displayName: "Google Workspace",
    enabled: false,
    clientId: null,
    tenantOrIssuer: null,
    enabledPacks: [],
    supportedPacks: [],
    callbackUri: "",
    baseScopes: [],
    scopes: [],
    status: "not_configured",
    credentialConfigured: false,
    revision: null,
    persisted: false,
    updatedAt: null,
  },
  {
    provider: "microsoft_365",
    displayName: "Microsoft 365",
    enabled: false,
    clientId: null,
    tenantOrIssuer: null,
    enabledPacks: [],
    supportedPacks: [],
    callbackUri: "",
    baseScopes: [],
    scopes: [],
    status: "not_configured",
    credentialConfigured: false,
    revision: null,
    persisted: false,
    updatedAt: null,
  },
];

export function PlatformIntegrationsClient() {
  const [registrations, setRegistrations] = useState(empty);
  const [events, setEvents] = useState<Event[]>([]);
  const [message, setMessage] = useState("Loading Platform integrations...");

  const load = useCallback(async () => {
    const response = await fetch("/api/platform/integrations", {
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setMessage(body.error || "Failed to load Platform integrations.");
      return;
    }
    setRegistrations(body.registrations || empty);
    setEvents(body.events || []);
    setMessage("");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <SettingsPage>
      <SettingsPageHeader
        description="Register the hosted Google and Microsoft applications Kestrel One uses for personal Apps. Capability packs and scopes are fixed by Kestrel One contracts."
        eyebrow="Platform · Integrations"
        title="Personal integrations"
      />
      {message ? (
        <SettingsStatusNotice
          description="The last saved registration remains unchanged."
          title={message}
          tone="error"
        />
      ) : null}
      <SettingsSection
        description="Kestrel One is the OAuth client. Client secrets are encrypted at rest and never returned after saving."
        title="Hosted OAuth registrations"
      >
        <div className="grid gap-4">
          {registrations.map((registration) => (
            <RegistrationCard
              key={registration.provider}
              onSaved={load}
              registration={registration}
            />
          ))}
        </div>
      </SettingsSection>
      <SettingsSection
        description="Configuration actions only. Secrets, authorization codes, and provider tokens are never recorded here."
        title="Activity"
      >
        <div className="divide-y border-y">
          {events.length ? (
            events.map((event) => (
              <div
                className="flex flex-col justify-between gap-1 py-3 text-sm sm:flex-row sm:gap-4"
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
            <p className="py-4 text-muted-foreground text-sm">
              No Platform integration events yet.
            </p>
          )}
        </div>
      </SettingsSection>
    </SettingsPage>
  );
}

function RegistrationCard({
  registration,
  onSaved,
}: {
  registration: Registration;
  onSaved: () => Promise<void>;
}) {
  const [clientId, setClientId] = useState(registration.clientId || "");
  const [clientSecret, setClientSecret] = useState("");
  const [tenantOrIssuer, setTenantOrIssuer] = useState(
    registration.tenantOrIssuer || "",
  );
  const [enabledPacks, setEnabledPacks] = useState<Pack[]>(
    registration.enabledPacks,
  );
  const [enabled, setEnabled] = useState(registration.enabled);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setClientId(registration.clientId || "");
    setClientSecret("");
    setTenantOrIssuer(registration.tenantOrIssuer || "");
    setEnabledPacks(registration.enabledPacks);
    setEnabled(registration.enabled);
  }, [registration]);
  const scopes = [
    ...registration.baseScopes,
    ...new Set(
      registration.supportedPacks
        .filter((pack) => enabledPacks.includes(pack.id))
        .flatMap((pack) => pack.scopes),
    ),
  ];

  async function save(nextEnabled = enabled) {
    setBusy(true);
    const response = await fetch("/api/platform/integrations", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: registration.provider,
        clientId,
        clientSecret: clientSecret || undefined,
        tenantOrIssuer:
          registration.provider === "microsoft_365"
            ? tenantOrIssuer || null
            : null,
        enabledPacks,
        enabled: nextEnabled,
      }),
    });
    const body = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      toast.error(body.error || "Failed to save OAuth registration.");
      return;
    }
    setClientSecret("");
    setEnabled(nextEnabled);
    toast.success(`${registration.displayName} registration saved.`);
    await onSaved();
  }

  function togglePack(pack: Pack, checked: boolean) {
    setEnabledPacks((current) =>
      checked
        ? [...new Set([...current, pack])]
        : current.filter((value) => value !== pack),
    );
  }

  const configured =
    registration.credentialConfigured && Boolean(registration.clientId);
  return (
    <SettingsDisclosure
      defaultOpen={!configured}
      description={`${registration.status.replace("_", " ")} · revision ${registration.revision ?? "not saved"}`}
      title={registration.displayName}
    >
      <div className="grid max-w-3xl gap-5">
        <SettingsRows>
          <SettingsRow label="Registration status">
            <div className="flex items-center gap-3">
              <SettingsStatusSummary
                detail={
                  configured
                    ? "Hosted client and encrypted secret are configured"
                    : "Client ID and secret required"
                }
                status={
                  registration.status === "ready"
                    ? "Ready"
                    : "Configuration required"
                }
                tone={registration.status === "ready" ? "positive" : "warning"}
              />
              <Badge variant="outline">
                {registration.enabled ? "Enabled" : "Disabled"}
              </Badge>
            </div>
          </SettingsRow>
          <SettingsRow label="Callback URI">
            <code className="break-all text-xs">
              {registration.callbackUri}
            </code>
          </SettingsRow>
        </SettingsRows>
        <div className="grid gap-2">
          <Label htmlFor={`${registration.provider}-client-id`}>
            Hosted OAuth client ID
          </Label>
          <Input
            id={`${registration.provider}-client-id`}
            onChange={(event) => setClientId(event.target.value)}
            value={clientId}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${registration.provider}-client-secret`}>
            Hosted OAuth client secret
          </Label>
          <Input
            autoComplete="off"
            id={`${registration.provider}-client-secret`}
            onChange={(event) => setClientSecret(event.target.value)}
            placeholder={
              registration.credentialConfigured
                ? "Configured — enter a new secret to rotate"
                : "Enter client secret"
            }
            type="password"
            value={clientSecret}
          />
          <p className="text-muted-foreground text-xs">
            The secret is encrypted before storage and never returned to this
            browser.
          </p>
        </div>
        {registration.provider === "microsoft_365" ? (
          <div className="grid gap-2">
            <Label htmlFor="microsoft-tenant">Tenant ID (optional)</Label>
            <Input
              id="microsoft-tenant"
              onChange={(event) => setTenantOrIssuer(event.target.value)}
              placeholder="Organizations or tenant GUID"
              value={tenantOrIssuer}
            />
          </div>
        ) : null}
        <div className="grid gap-3">
          <Label>Capability packs</Label>
          {registration.supportedPacks.map((pack) => (
            <label
              className="flex cursor-pointer items-start gap-3 rounded-md border p-3"
              htmlFor={`${registration.provider}-${pack.id}`}
              key={pack.id}
            >
              <Checkbox
                checked={enabledPacks.includes(pack.id)}
                id={`${registration.provider}-${pack.id}`}
                onCheckedChange={(checked) =>
                  togglePack(pack.id, checked === true)
                }
              />
              <span>
                <span className="block font-medium text-sm">{pack.label}</span>
                <span className="block text-muted-foreground text-xs">
                  {pack.scopes.join(" · ")}
                </span>
              </span>
            </label>
          ))}
          <p className="text-muted-foreground text-xs">
            Scopes are derived from these selected Kestrel One packs. Free-form
            scopes are not accepted.
          </p>
        </div>
        <div className="grid gap-2">
          <Label>Requested provider scopes</Label>
          <div className="rounded-md border bg-muted/30 p-3 text-xs">
            {scopes.length
              ? scopes.map((scope) => <div key={scope}>{scope}</div>)
              : "Select a capability pack to see its scopes."}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save registration"}
          </Button>
          <div className="flex items-center gap-2">
            <Label htmlFor={`${registration.provider}-enabled`}>Enabled</Label>
            <Switch
              checked={enabled}
              disabled={busy}
              id={`${registration.provider}-enabled`}
              onCheckedChange={(next) => void save(next)}
            />
          </div>
        </div>
      </div>
    </SettingsDisclosure>
  );
}
