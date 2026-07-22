"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { organization } from "@/lib/auth-client";

export function deriveOrganizationSlug(name: string) {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 63)
    .replace(/-+$/u, "");
}

export function isValidOrganizationSlug(slug: string) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(slug);
}

export function CreateOrganizationDialog({
  children,
}: {
  children?: React.ReactNode;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [showSlug, setShowSlug] = useState(false);
  const [slugError, setSlugError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (!showSlug) setSlug(deriveOrganizationSlug(name));
  }, [name, showSlug]);

  useEffect(() => {
    if (!open) return;
    setName("");
    setSlug("");
    setShowSlug(false);
    setSlugError(null);
  }, [open]);

  async function createOrganization() {
    const normalizedName = name.trim();
    const normalizedSlug = slug.trim().toLowerCase();
    if (!isValidOrganizationSlug(normalizedSlug)) {
      setShowSlug(true);
      setSlugError(
        "Use lowercase letters, numbers, and hyphens, beginning and ending with a letter or number."
      );
      return;
    }
    setLoading(true);
    try {
      const availability = await organization.checkSlug({
        slug: normalizedSlug,
      });
      if (availability.error) {
        throw new Error(availability.error.message);
      }
      if (!availability.data?.status) {
        setShowSlug(true);
        setSlugError("That organization slug is already in use. Choose another.");
        return;
      }
      const created = await organization.create({
        name: normalizedName,
        slug: normalizedSlug,
        keepCurrentActiveOrganization: false,
      });
      if (created.error) throw new Error(created.error.message);
      if (!created.data?.id) {
        throw new Error("Organization creation did not return an organization.");
      }
      const activated = await organization.setActive({
        organizationId: created.data.id,
      });
      if (activated.error) throw new Error(activated.error.message);
      toast.success("Organization created. Let’s finish the minimum setup.");
      setOpen(false);
      router.push("/settings/organization/setup");
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Organization creation failed."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        {children ?? (
          <Button className="w-full gap-2" size="sm">
            <Plus className="size-4" /> New organization
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="w-11/12 sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>New organization</DialogTitle>
          <DialogDescription>
            Start with a name. You’ll configure the minimum agent runtime next.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="space-y-2">
            <Label htmlFor="new-organization-name">Organization name</Label>
            <Input
              autoFocus
              id="new-organization-name"
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              placeholder="Acme"
              value={name}
            />
          </div>
          {showSlug ? (
            <div className="space-y-2">
              <Label htmlFor="new-organization-slug">Organization slug</Label>
              <Input
                aria-describedby="new-organization-slug-error"
                aria-invalid={Boolean(slugError)}
                id="new-organization-slug"
                maxLength={63}
                onChange={(event) => {
                  setSlug(event.target.value.toLowerCase());
                  setSlugError(null);
                }}
                value={slug}
              />
              {slugError ? (
                <p
                  className="text-destructive text-xs"
                  id="new-organization-slug-error"
                >
                  {slugError}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button disabled={loading} variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button
            disabled={loading || !name.trim()}
            onClick={() => void createOrganization()}
          >
            {loading ? "Creating…" : "Create and continue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
