"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { readJson } from "@/components/admin/admin-client-utils";
import { AdminDataTable } from "@/components/admin/admin-data-table";
import { AdminEmptyState } from "@/components/admin/admin-empty-state";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminStatusBanner } from "@/components/admin/admin-status-banner";
import { AppPage } from "@/components/app-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TimeText } from "@/components/ui/time-text";

type AdminApiKey = {
  id: string;
  name: string;
  prefix: string;
  start: string;
  enabled: boolean;
  expiresAt: string | null;
  createdAt: string;
  userName: string | null;
  userEmail: string | null;
};

export function ApiKeysAdminClient() {
  const [keys, setKeys] = useState<AdminApiKey[]>([]);
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading API keys...");
  const [busy, setBusy] = useState(false);

  async function load() {
    setStatus("Loading API keys...");
    const response = await fetch("/api/organization/api-keys", { cache: "no-store" });
    const json = await readJson<AdminApiKey[] | { error?: string }>(response);
    if (!(response.ok && Array.isArray(json))) {
      setStatus(
        Array.isArray(json)
          ? "Failed to load API keys"
          : json.error || "Failed to load API keys"
      );
      return;
    }
    setKeys(json);
    setStatus("");
  }

  useEffect(() => {
    void load();
  }, []);

  async function createKey() {
    setBusy(true);
    const response = await fetch("/api/organization/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: name || "Admin key",
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      }),
    });
    const json = await readJson<{ token?: string; error?: string }>(response);
    setBusy(false);
    if (!response.ok) {
      toast.error(json.error || "Failed to create key");
      return;
    }
    setRevealedToken(json.token || null);
    setName("");
    setExpiresAt("");
    toast.success("API key created.");
    await load();
  }

  async function revokeKey(id: string) {
    setBusy(true);
    const response = await fetch(`/api/organization/api-keys/${id}`, {
      method: "DELETE",
    });
    const json = await readJson<{ error?: string }>(response);
    setBusy(false);
    if (!response.ok) {
      toast.error(json.error || "Failed to revoke key");
      return;
    }
    toast.success("API key revoked.");
    await load();
  }

  return (
    <AppPage>
      <AdminPageHeader
        description="Create app-owned admin keys for integrations and revoke them when they are no longer needed."
        eyebrow="Credentials"
        title="API Keys"
      />

      {revealedToken ? (
        <AdminStatusBanner
          description={revealedToken}
          title="Copy this token now. It will not be shown again."
          variant="warning"
        />
      ) : null}

      <div className="grid gap-3 border border-border/70 bg-card p-4 md:grid-cols-[1fr_240px_auto]">
        <Input
          onChange={(event) => setName(event.target.value)}
          placeholder="Key name"
          value={name}
        />
        <Input
          onChange={(event) => setExpiresAt(event.target.value)}
          type="datetime-local"
          value={expiresAt}
        />
        <Button disabled={busy} onClick={() => void createKey()}>
          Create Key
        </Button>
      </div>

      {status ? (
        <div className="text-muted-foreground text-sm">{status}</div>
      ) : null}

      <AdminDataTable
        columns={[
          { key: "name", label: "Name" },
          { key: "creator", label: "Created By" },
          { key: "token", label: "Prefix" },
          { key: "expires", label: "Expires" },
          { key: "actions", label: "Actions", className: "text-right" },
        ]}
        empty={
          <AdminEmptyState
            description="Create your first organization-scoped admin key to support integration workflows."
            title="No API keys"
          />
        }
        rows={keys.map((key) => ({
          name: <div className="font-medium">{key.name}</div>,
          creator: (
            <div className="text-sm">
              <div>{key.userName || "Unknown"}</div>
              <div className="text-muted-foreground">
                {key.userEmail || "No email"}
              </div>
            </div>
          ),
          token: <code className="text-sm">{key.start}…</code>,
          expires: (
            <span className="text-muted-foreground text-sm">
              <TimeText mode="datetime" value={key.expiresAt} />
            </span>
          ),
          actions: (
            <Button
              disabled={busy}
              onClick={() => void revokeKey(key.id)}
              size="sm"
              variant="destructive"
            >
              Revoke
            </Button>
          ),
        }))}
      />
    </AppPage>
  );
}
