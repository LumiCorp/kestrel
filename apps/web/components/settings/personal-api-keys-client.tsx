"use client";

import { MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
  SettingsStatusNotice,
} from "@/components/settings/settings-section";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<PersonalApiKey | null>(
    null,
  );

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
      setCreateOpen(false);
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
      setPendingRevoke(null);
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
          <Button onClick={() => setCreateOpen(true)} size="sm">
            <Plus className="size-4" /> New key
          </Button>
        }
        description="Create personal API keys for SDK clients, scripts, and automation workflows."
        eyebrow="Account"
        title="Personal API Keys"
      />

      <SettingsSection
        description="Personal credentials currently able to access Kestrel One."
        title="Your keys"
      >
        <div className="divide-y border-y">
          {status ? (
            <div className="py-4 text-muted-foreground text-sm">{status}</div>
          ) : null}
          {keys.length === 0 ? (
            <SettingsStatusNotice
              className="my-4"
              description="Create one when a script or SDK client needs access."
              title="No API keys yet"
            />
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
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      aria-label={`Actions for ${key.name || "unnamed key"}`}
                      disabled={busy}
                      size="icon"
                      variant="ghost"
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      className="text-destructive"
                      data-testid={`personal-api-key-delete-${key.id}`}
                      onSelect={() => setPendingRevoke(key)}
                    >
                      <Trash2 className="size-4" /> Revoke key
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))
          )}
        </div>
      </SettingsSection>

      <Dialog onOpenChange={setCreateOpen} open={createOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create personal API key</DialogTitle>
            <DialogDescription>
              Name the client or workflow that will use this credential.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="personal-api-key-name">Key name</Label>
            <Input
              data-testid="personal-api-key-name"
              id="personal-api-key-name"
              onChange={(event) => setNewKeyName(event.target.value)}
              placeholder="My SDK app"
              value={newKeyName}
            />
          </div>
          <DialogFooter>
            <Button onClick={() => setCreateOpen(false)} variant="outline">
              Cancel
            </Button>
            <Button
              data-testid="personal-api-key-create"
              disabled={busy || !newKeyName.trim()}
              onClick={() => void createKey()}
            >
              {busy ? "Creating…" : "Create key"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!open) setRevealedKey(null);
        }}
        open={Boolean(revealedKey)}
      >
        <DialogContent data-testid="personal-api-key-reveal">
          <DialogHeader>
            <DialogTitle>Save your API key now</DialogTitle>
            <DialogDescription>
              This key is shown once. Store it in your secret manager before closing.
            </DialogDescription>
          </DialogHeader>
          <code className="block overflow-x-auto bg-muted px-3 py-2 font-mono text-sm">
            {revealedKey}
          </code>
          <DialogFooter>
            <Button
              onClick={() =>
                revealedKey
                  ? void navigator.clipboard.writeText(revealedKey)
                  : undefined
              }
              variant="outline"
            >
              Copy
            </Button>
            <Button onClick={() => setRevealedKey(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        onOpenChange={(open) => {
          if (!(open || busy)) setPendingRevoke(null);
        }}
        open={Boolean(pendingRevoke)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this API key?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRevoke?.name || "This key"} will stop working immediately. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button
              disabled={busy}
              onClick={() =>
                pendingRevoke ? void revokeKey(pendingRevoke.id) : undefined
              }
              variant="destructive"
            >
              {busy ? "Revoking…" : "Revoke key"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsPage>
  );
}
