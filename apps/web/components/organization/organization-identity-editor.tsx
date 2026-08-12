"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { isValidOrganizationSlug } from "@/components/create-organization-dialog";
import { SettingsFormActions } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { organization } from "@/lib/auth-client";

export function OrganizationIdentityEditor({
  id,
  initialName,
  initialSlug,
}: {
  id: string;
  initialName: string;
  initialSlug: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [slug, setSlug] = useState(initialSlug);
  const [busy, setBusy] = useState(false);
  const normalizedName = name.trim();
  const normalizedSlug = slug.trim().toLowerCase();
  const isDirty =
    normalizedName !== initialName || normalizedSlug !== initialSlug;

  async function save() {
    if (!(normalizedName && isValidOrganizationSlug(normalizedSlug))) {
      toast.error("Enter a valid organization name and slug.");
      return;
    }

    setBusy(true);
    try {
      if (normalizedSlug !== initialSlug) {
        const availability = await organization.checkSlug({
          slug: normalizedSlug,
        });
        if (availability.error) throw new Error(availability.error.message);
        if (!availability.data?.status) {
          throw new Error("That organization slug is already in use.");
        }
      }

      const result = await organization.update({
        organizationId: id,
        data: { name: normalizedName, slug: normalizedSlug },
      });
      if (result.error) throw new Error(result.error.message);
      toast.success("Organization identity updated.");
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Organization update failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid max-w-xl gap-4">
      <div className="grid gap-2 sm:grid-cols-[8rem_minmax(0,1fr)] sm:items-center">
        <Label htmlFor="organization-name">Name</Label>
        <Input
          id="organization-name"
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-[8rem_minmax(0,1fr)] sm:items-center">
        <Label htmlFor="organization-slug">Slug</Label>
        <Input
          id="organization-slug"
          maxLength={63}
          onChange={(event) => setSlug(event.target.value.toLowerCase())}
          value={slug}
        />
      </div>
      {isDirty ? (
        <SettingsFormActions status="Unsaved changes">
          <Button
            disabled={busy}
            onClick={() => {
              setName(initialName);
              setSlug(initialSlug);
            }}
            variant="outline"
          >
            Discard
          </Button>
          <Button
            disabled={busy || !normalizedName || !normalizedSlug}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save identity"}
          </Button>
        </SettingsFormActions>
      ) : null}
    </div>
  );
}
