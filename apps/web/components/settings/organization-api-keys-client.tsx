"use client";

import { MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { readJson } from "@/components/admin/admin-client-utils";
import { ResourceEmpty, ResourceList, ResourceRow } from "@/components/resource-list";
import {
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
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
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<AdminApiKey | null>(null);

  async function load() {
    setStatus("Loading API keys...");
    const response = await fetch("/api/organization/api-keys", {
      cache: "no-store",
    });
    const json = await readJson<AdminApiKey[] | { error?: string }>(response);
    if (!(response.ok && Array.isArray(json))) {
      setStatus(
        Array.isArray(json)
          ? "Failed to load API keys"
          : json.error || "Failed to load API keys",
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
    setCreateOpen(false);
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
    setPendingRevoke(null);
    toast.success("API key revoked.");
    await load();
  }

  return (
    <SettingsPage>
      <SettingsPageHeader
        actions={
          <Button onClick={() => setCreateOpen(true)} size="sm">
            <Plus className="size-4" /> New key
          </Button>
        }
        description="Manage organization credentials used by integrations and automation."
        eyebrow="Credentials"
        title="API keys"
      />

      <SettingsSection
        description="Organization credentials with administrative access."
        title="Active keys"
      >
        {status ? (
          <div className="border-y py-4 text-muted-foreground text-sm">
            {status}
          </div>
        ) : null}
        {!status && keys.length === 0 ? (
          <ResourceEmpty
            description="Create one when an integration needs organization-level access."
            title="No API keys"
          />
        ) : null}
        {keys.length > 0 ? (
          <ResourceList>
            {keys.map((key) => (
              <ResourceRow
                actions={
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        aria-label={`Actions for ${key.name}`}
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
                        onSelect={() => setPendingRevoke(key)}
                      >
                        <Trash2 className="size-4" /> Revoke key
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                }
                description={`${key.userName || "Unknown creator"} · ${key.userEmail || "No email"}`}
                key={key.id}
                metadata={
                  <>
                    <code>{key.start}…</code>
                    {" · Created "}
                    <TimeText mode="date" value={key.createdAt} />
                    {key.expiresAt ? (
                      <>
                        {" · Expires "}
                        <TimeText mode="date" value={key.expiresAt} />
                      </>
                    ) : null}
                  </>
                }
                title={key.name}
              />
            ))}
          </ResourceList>
        ) : null}
      </SettingsSection>

      <Dialog onOpenChange={setCreateOpen} open={createOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create organization API key</DialogTitle>
            <DialogDescription>
              Name the integration and optionally choose an expiration time.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="organization-api-key-name">Key name</Label>
              <Input
                id="organization-api-key-name"
                onChange={(event) => setName(event.target.value)}
                placeholder="Deployment automation"
                value={name}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="organization-api-key-expiration">
                Expiration (optional)
              </Label>
              <Input
                id="organization-api-key-expiration"
                onChange={(event) => setExpiresAt(event.target.value)}
                type="datetime-local"
                value={expiresAt}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setCreateOpen(false)} variant="outline">
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void createKey()}>
              {busy ? "Creating…" : "Create key"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!open) setRevealedToken(null);
        }}
        open={Boolean(revealedToken)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save this API key now</DialogTitle>
            <DialogDescription>
              The token is shown once. Store it securely before closing.
            </DialogDescription>
          </DialogHeader>
          <code className="block overflow-x-auto bg-muted px-3 py-2 font-mono text-sm">
            {revealedToken}
          </code>
          <DialogFooter>
            <Button
              onClick={() =>
                revealedToken
                  ? void navigator.clipboard.writeText(revealedToken)
                  : undefined
              }
              variant="outline"
            >
              Copy
            </Button>
            <Button onClick={() => setRevealedToken(null)}>Done</Button>
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
              {pendingRevoke?.name || "This key"} will stop working
              immediately. This action cannot be undone.
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
