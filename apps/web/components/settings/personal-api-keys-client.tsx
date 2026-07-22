"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  SettingsPage,
  SettingsPageHeader,
  SettingsPanel,
  SettingsPanelContent,
  SettingsPanelHeader,
  SettingsPanelTitle,
} from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TimeText } from "@/components/ui/time-text";
import { client } from "@/lib/auth-client";

type PersonalApiKey = {
  id: string;
  name: string | null;
  enabled: boolean;
  start: string | null;
  expiresAt: string | Date | null;
  createdAt: string | Date;
};

export function UserApiKeysClient() {
  const [keys, setKeys] = useState<PersonalApiKey[]>([]);
  const [newKeyName, setNewKeyName] = useState("");
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading API keys...");
  const [busy, setBusy] = useState(false);

  async function loadKeys() {
    setStatus("Loading API keys...");
    const result = await client.apiKey.list();
    setKeys((result.data?.apiKeys ?? []) as PersonalApiKey[]);
    setStatus("");
  }

  useEffect(() => {
    void loadKeys();
  }, []);

  async function createKey() {
    if (!newKeyName.trim()) {
      return;
    }

    setBusy(true);
    try {
      const result = await client.apiKey.create({
        name: newKeyName.trim(),
        prefix: "sk",
      });
      setRevealedKey(result.data?.key ?? null);
      setNewKeyName("");
      await loadKeys();
      toast.success("API key created.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to create API key"
      );
    } finally {
      setBusy(false);
    }
  }

  async function revokeKey(keyId: string) {
    setBusy(true);
    try {
      await client.apiKey.delete({ keyId });
      await loadKeys();
      toast.success("API key revoked.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to revoke API key"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsPage>
      <SettingsPageHeader
        actions={
          <Button asChild size="sm" variant="outline">
            <Link href="/settings/profile">Back to Profile</Link>
          </Button>
        }
        description="Create personal API keys for SDK clients, scripts, and automation workflows."
        eyebrow="Account"
        title="Personal API Keys"
      />

      {revealedKey ? (
        <SettingsPanel data-testid="personal-api-key-reveal">
          <SettingsPanelHeader>
            <SettingsPanelTitle>Save your API key now</SettingsPanelTitle>
          </SettingsPanelHeader>
          <SettingsPanelContent className="space-y-3">
            <p className="text-muted-foreground text-sm">
              This key is only shown once. Copy it now and store it securely.
            </p>
            <code className="block rounded-md bg-muted px-3 py-2 font-mono text-sm">
              {revealedKey}
            </code>
            <div className="flex gap-2">
              <Button
                onClick={() => void navigator.clipboard.writeText(revealedKey)}
                size="sm"
                variant="outline"
              >
                Copy
              </Button>
              <Button onClick={() => setRevealedKey(null)} size="sm">
                Done
              </Button>
            </div>
          </SettingsPanelContent>
        </SettingsPanel>
      ) : null}

      <SettingsPanel>
        <SettingsPanelHeader>
          <SettingsPanelTitle>Create a new key</SettingsPanelTitle>
        </SettingsPanelHeader>
        <SettingsPanelContent className="flex flex-col gap-3 md:flex-row">
          <div className="flex-1 space-y-2">
            <Label htmlFor="personal-api-key-name">Key name</Label>
            <Input
              data-testid="personal-api-key-name"
              id="personal-api-key-name"
              onChange={(event) => setNewKeyName(event.target.value)}
              placeholder="My SDK app"
              value={newKeyName}
            />
          </div>
          <div className="flex items-end">
            <Button
              data-testid="personal-api-key-create"
              disabled={busy || !newKeyName.trim()}
              onClick={() => void createKey()}
            >
              Create Key
            </Button>
          </div>
        </SettingsPanelContent>
      </SettingsPanel>

      <SettingsPanel>
        <SettingsPanelHeader>
          <SettingsPanelTitle>Your keys</SettingsPanelTitle>
        </SettingsPanelHeader>
        <SettingsPanelContent className="divide-y">
          {status ? (
            <div className="text-muted-foreground text-sm">{status}</div>
          ) : null}
          {keys.length === 0 ? (
            <div className="text-muted-foreground text-sm">
              No API keys yet. Create one to get started.
            </div>
          ) : (
            keys.map((key) => (
              <div
                className="flex flex-col justify-between gap-3 py-4 md:flex-row md:items-center"
                key={key.id}
              >
                <div>
                  <div className="font-medium">{key.name || "Unnamed key"}</div>
                  <div className="text-muted-foreground text-sm">
                    {`${key.start || "sk_..."} · Created `}
                    <TimeText mode="date" value={key.createdAt} />
                    {key.expiresAt ? (
                      <>
                        {" · Expires "}
                        <TimeText mode="date" value={key.expiresAt} />
                      </>
                    ) : null}
                  </div>
                </div>
                <Button
                  data-testid={`personal-api-key-delete-${key.id}`}
                  disabled={busy}
                  onClick={() => void revokeKey(key.id)}
                  size="sm"
                  variant="destructive"
                >
                  Revoke
                </Button>
              </div>
            ))
          )}
        </SettingsPanelContent>
      </SettingsPanel>
    </SettingsPage>
  );
}
