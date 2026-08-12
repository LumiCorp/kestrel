"use client";

import { Loader2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
} from "@/components/settings/settings-section";
import {
  isoInstantToLocalDateTimeInput,
  localDateTimeInputToIsoInstant,
} from "@/lib/datetime-local";
import type { SignupAccessCodeAdminRow } from "@/lib/signup-access-codes";

export function SignupCodesClient({
  initialCodes,
}: {
  initialCodes: SignupAccessCodeAdminRow[];
}) {
  const [codes, setCodes] = useState(initialCodes);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [maxRedemptions, setMaxRedemptions] = useState("1");
  const [expiresAt, setExpiresAt] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [createdCode, setCreatedCode] = useState<string | null>(null);

  async function refresh() {
    const response = await fetch("/api/admin/signup-codes", {
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? "Invite codes unavailable.");
    setCodes(payload.codes);
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusyId("create");
    try {
      const response = await fetch("/api/admin/signup-codes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code,
          label,
          maxRedemptions: Number(maxRedemptions),
          expiresAt: localDateTimeInputToIsoInstant(expiresAt),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Invite code creation failed.");
      setCreatedCode(payload.rawCode);
      setCode("");
      setLabel("");
      setMaxRedemptions("1");
      setExpiresAt("");
      await refresh();
      toast.success("Invite code created.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Invite code creation failed.");
    } finally {
      setBusyId(null);
    }
  }

  async function update(
    id: string,
    change: { enabled?: boolean; maxRedemptions?: number; expiresAt?: string | null },
  ) {
    setBusyId(id);
    try {
      const response = await fetch(`/api/admin/signup-codes/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(change),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Invite code update failed.");
      await refresh();
      toast.success("Invite code updated.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Invite code update failed.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <SettingsPage>
      <SettingsPageHeader
        description="Create reusable account-access codes. Organization invitations remain separate and email-bound."
        eyebrow="Platform"
        title="Signup codes"
      />
      <SettingsSection
        description="The raw code is shown only after creation. Every code has a required usage cap."
        title="Create code"
      >
        <form className="grid gap-4 lg:grid-cols-4" onSubmit={create}>
          <div className="grid gap-2">
            <Label htmlFor="new-signup-code">Code</Label>
            <Input
              id="new-signup-code"
              onChange={(event) => setCode(event.target.value)}
              placeholder="BUILDWITHKESTREL"
              required
              value={code}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-signup-label">Label</Label>
            <Input
              id="new-signup-label"
              onChange={(event) => setLabel(event.target.value)}
              required
              value={label}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-signup-cap">Maximum uses</Label>
            <Input
              id="new-signup-cap"
              min={1}
              onChange={(event) => setMaxRedemptions(event.target.value)}
              required
              type="number"
              value={maxRedemptions}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-signup-expiry">
              Expiration (optional, local time)
            </Label>
            <Input
              id="new-signup-expiry"
              onChange={(event) => setExpiresAt(event.target.value)}
              type="datetime-local"
              value={expiresAt}
            />
          </div>
          <div className="lg:col-span-4">
            <Button disabled={busyId === "create"} type="submit">
              {busyId === "create" ? <Loader2 className="size-4 animate-spin" /> : null}
              Create signup code
            </Button>
          </div>
        </form>
        {createdCode ? (
          <div className="mt-5 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-4">
            <p className="font-medium text-sm">Copy this code now</p>
            <code className="mt-2 block select-all text-base">{createdCode}</code>
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection
        description="Reservations expire after one hour. Disabling a code prevents new reservations without revoking accounts."
        title="Codes and usage"
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className="py-3 pr-4">Code</th>
                <th className="py-3 pr-4">Status</th>
                <th className="py-3 pr-4">Usage</th>
                <th className="py-3 pr-4">Onboarded</th>
                <th className="py-3 pr-4">Expiration (local time)</th>
                <th className="py-3 pr-4">Creator</th>
                <th className="py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {codes.map((item) => (
                <SignupCodeRow
                  busy={busyId === item.id}
                  item={item}
                  key={item.id}
                  onUpdate={(change) => update(item.id, change)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </SettingsSection>
    </SettingsPage>
  );
}

function SignupCodeRow({
  busy,
  item,
  onUpdate,
}: {
  busy: boolean;
  item: SignupAccessCodeAdminRow;
  onUpdate: (change: {
    enabled?: boolean;
    maxRedemptions?: number;
    expiresAt?: string | null;
  }) => Promise<void>;
}) {
  const [cap, setCap] = useState(String(item.maxRedemptions));
  const initialExpiry = isoInstantToLocalDateTimeInput(item.expiresAt);
  const [expiry, setExpiry] = useState(initialExpiry);

  async function save() {
    const change: {
      maxRedemptions: number;
      expiresAt?: string | null;
    } = { maxRedemptions: Number(cap) };
    if (expiry !== initialExpiry) {
      change.expiresAt = localDateTimeInputToIsoInstant(expiry);
    }
    await onUpdate(change);
  }

  return (
    <tr className="border-b align-top">
      <td className="py-4 pr-4">
        <div className="font-medium">{item.label}</div>
        <code className="text-muted-foreground text-xs">{item.codeHint}</code>
      </td>
      <td className="py-4 pr-4 capitalize">{item.status}</td>
      <td className="py-4 pr-4">
        {item.committedUsage}/{item.maxRedemptions}
        <div className="text-muted-foreground text-xs">
          {item.activeReservations} reserved · {item.verifiedRedemptions} verified
        </div>
      </td>
      <td className="py-4 pr-4">{item.completedOnboardings}</td>
      <td className="py-4 pr-4">
        <Input
          aria-label={`Expiration in local time for ${item.label}`}
          className="w-48"
          onChange={(event) => setExpiry(event.target.value)}
          type="datetime-local"
          value={expiry}
        />
      </td>
      <td className="py-4 pr-4">{item.createdBy?.email ?? "Unknown"}</td>
      <td className="py-4">
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label={`Maximum uses for ${item.label}`}
            className="w-20"
            min={item.committedUsage || 1}
            onChange={(event) => setCap(event.target.value)}
            type="number"
            value={cap}
          />
          <Button
            disabled={busy}
            onClick={() => void save()}
            size="sm"
            variant="outline"
          >
            Save
          </Button>
          <Button
            disabled={busy}
            onClick={() => void onUpdate({ enabled: !item.enabled })}
            size="sm"
            variant={item.enabled ? "destructive" : "default"}
          >
            {item.enabled ? "Disable" : "Enable"}
          </Button>
        </div>
      </td>
    </tr>
  );
}
