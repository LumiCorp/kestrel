"use client";

import { Loader2, MailPlus, MoreHorizontal } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ResourceEmpty, ResourceList, ResourceRow } from "@/components/resource-list";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { isValidOrganizationSlug } from "@/components/create-organization-dialog";
import {
  SettingsActionGroup,
  SettingsDisclosure,
  SettingsRow,
  SettingsRows,
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
import CopyButton from "@/components/ui/copy-button";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { organization, useSession } from "@/lib/auth-client";
import type { ActiveOrganization, Session } from "@/lib/auth-types";
import { isPersonalOrganization } from "@/lib/personal-workspace-shared";

export function OrganizationCard(props: {
  session: Session | null;
  activeOrganization: ActiveOrganization | null;
  invitationOrigin: string | null;
  invitationSetupIssue: string | null;
}) {
  const [optimisticOrg, setOptimisticOrg] = useState<ActiveOrganization | null>(
    props.activeOrganization,
  );
  const [isRevoking, setIsRevoking] = useState<string[]>([]);
  const [isResending, setIsResending] = useState<string[]>([]);
  const [pendingMemberRemoval, setPendingMemberRemoval] = useState<
    NonNullable<ActiveOrganization["members"]>[number] | null
  >(null);
  const [pendingInvitationRevoke, setPendingInvitationRevoke] = useState<
    NonNullable<ActiveOrganization["invitations"]>[number] | null
  >(null);
  const [removingMember, setRemovingMember] = useState(false);

  const { data } = useSession();
  const session = data || props.session;
  const activeIsPersonal = isPersonalOrganization(optimisticOrg);

  const currentMember = optimisticOrg?.members?.find(
    (member) => member.userId === session?.user.id,
  );

  const canEditOrganization =
    !activeIsPersonal &&
    (currentMember?.role === "owner" || currentMember?.role === "admin");

  useEffect(() => {
    setOptimisticOrg(props.activeOrganization);
  }, [props.activeOrganization]);

  const invitations = optimisticOrg?.invitations ?? [];
  const pendingInvitations = invitations.filter(
    (invitation) =>
      invitation.status === "pending" && !isInvitationExpired(invitation),
  );
  const invitationHistory = invitations.filter(
    (invitation) =>
      invitation.status !== "pending" || isInvitationExpired(invitation),
  );

  async function revokeInvitation() {
    if (!(pendingInvitationRevoke && optimisticOrg)) return;
    const invitation = pendingInvitationRevoke;
    setIsRevoking((current) => [...current, invitation.id]);
    try {
      const result = await organization.cancelInvitation({
        invitationId: invitation.id,
      });
      if (result.error) throw new Error(result.error.message);
      setOptimisticOrg({
        ...optimisticOrg,
        invitations: invitations.map((item) =>
          item.id === invitation.id ? { ...item, status: "canceled" } : item,
        ),
      });
      setPendingInvitationRevoke(null);
      toast.success("Invitation revoked.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Invitation revoke failed.",
      );
    } finally {
      setIsRevoking((current) =>
        current.filter((id) => id !== invitation.id),
      );
    }
  }

  function resendInvitation(
    invitation: NonNullable<ActiveOrganization["invitations"]>[number],
  ) {
    const request = isInvitationExpired(invitation)
      ? organization
          .cancelInvitation({ invitationId: invitation.id })
          .then((cancelled: any) => {
            if (cancelled.error) throw new Error(cancelled.error.message);
            return organization.inviteMember({
              email: invitation.email,
              role: invitation.role,
              fetchOptions: { throw: true },
            });
          })
      : organization.inviteMember({
          email: invitation.email,
          role: invitation.role,
          resend: true,
          fetchOptions: { throw: true },
        });

    setIsResending((current) => [...current, invitation.id]);
    toast.promise(request, {
      loading: isInvitationExpired(invitation)
        ? "Sending a new invitation…"
        : "Resending invitation…",
      success: isInvitationExpired(invitation)
        ? "New invitation sent"
        : "Invitation resent",
      error: (error: any) =>
        error.error?.message || error.message || "Invitation delivery failed",
    });
    void Promise.resolve(request)
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        setIsResending((current) =>
          current.filter((id) => id !== invitation.id),
        );
      });
  }

  async function removeMember() {
    if (!(pendingMemberRemoval && optimisticOrg)) return;
    setRemovingMember(true);
    try {
      const result = await organization.removeMember({
        memberIdOrEmail: pendingMemberRemoval.id,
      });
      if (result.error) throw new Error(result.error.message);
      setOptimisticOrg({
        ...optimisticOrg,
        members: (optimisticOrg.members ?? []).filter(
          (member) => member.id !== pendingMemberRemoval.id,
        ),
      });
      setPendingMemberRemoval(null);
      toast.success("Member removed.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Member removal failed.",
      );
    } finally {
      setRemovingMember(false);
    }
  }

  function invitationRow(
    invitation: NonNullable<ActiveOrganization["invitations"]>[number],
  ) {
    const expired = isInvitationExpired(invitation);
    return (
      <ResourceRow
        actions={
          <div className="flex items-center gap-1">
            {invitation.status === "pending" &&
            !expired &&
            props.invitationOrigin ? (
              <CopyButton
                textToCopy={`${props.invitationOrigin}/accept-invitation/${invitation.id}`}
              />
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label={`Actions for invitation to ${invitation.email}`}
                  disabled={
                    isRevoking.includes(invitation.id) ||
                    isResending.includes(invitation.id)
                  }
                  size="icon"
                  variant="ghost"
                >
                  {isRevoking.includes(invitation.id) ||
                  isResending.includes(invitation.id) ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <MoreHorizontal className="size-4" />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {invitation.status === "pending" ? (
                  <DropdownMenuItem
                    onSelect={() => resendInvitation(invitation)}
                  >
                    {expired ? "Send new invitation" : "Resend invitation"}
                  </DropdownMenuItem>
                ) : null}
                {invitation.status === "pending" ? (
                  <DropdownMenuItem
                    className="text-destructive"
                    onSelect={() => setPendingInvitationRevoke(invitation)}
                  >
                    Revoke invitation
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
        description={`${invitationState(invitation)} · ${invitation.role}`}
        key={invitation.id}
        title={invitation.email}
      />
    );
  }

  return (
    <>
      {!activeIsPersonal && optimisticOrg ? (
        <OrganizationIdentity
          canEdit={canEditOrganization}
          organizationRecord={optimisticOrg}
          onUpdated={setOptimisticOrg}
        />
      ) : null}
      <SettingsSection
        actions={
          canEditOrganization && optimisticOrg ? (
            <InviteMemberDialog
              optimisticOrg={optimisticOrg}
              setOptimisticOrg={setOptimisticOrg}
            />
          ) : null
        }
        description={`${optimisticOrg?.members?.length || 1} people with access to this organization.`}
        title="Members"
      >
        <ResourceList>
          {optimisticOrg?.members?.map((member) => (
            <ResourceRow
              actions={
                !activeIsPersonal &&
                member.role !== "owner" &&
                canEditOrganization ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        aria-label={`Actions for ${member.user.name}`}
                        size="icon"
                        variant="ghost"
                      >
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        className="text-destructive"
                        onSelect={() => setPendingMemberRemoval(member)}
                      >
                        {currentMember?.id === member.id
                          ? "Leave organization"
                          : "Remove member"}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null
              }
              description={member.user.email}
              key={member.id}
              status={<span className="capitalize">{member.role}</span>}
              title={
                <span className="flex items-center gap-3">
                  <Avatar className="size-8">
                    <AvatarImage
                      className="object-cover"
                      src={member.user.image || undefined}
                    />
                    <AvatarFallback>
                      {member.user.name?.charAt(0)}
                    </AvatarFallback>
                  </Avatar>
                  {member.user.name}
                </span>
              }
            />
          ))}
          {activeIsPersonal && !optimisticOrg?.members?.length ? (
            <ResourceRow
              description={session?.user.email}
              status="Owner"
              title={session?.user.name || "Personal account"}
            />
          ) : null}
        </ResourceList>
      </SettingsSection>

      {canEditOrganization && props.invitationSetupIssue ? (
        <SettingsStatusNotice
          description={props.invitationSetupIssue}
          title="Invitation delivery needs attention"
          tone="warning"
        />
      ) : null}

      {canEditOrganization && pendingInvitations.length > 0 ? (
        <SettingsSection
          description="Invitations awaiting a response."
          title="Pending invitations"
        >
          <ResourceList>{pendingInvitations.map(invitationRow)}</ResourceList>
        </SettingsSection>
      ) : null}

      {canEditOrganization && invitationHistory.length > 0 ? (
        <SettingsDisclosure
          description={`${invitationHistory.length} completed, canceled, or expired invitation${invitationHistory.length === 1 ? "" : "s"}.`}
          title="Invitation history"
        >
          <ResourceList>{invitationHistory.map(invitationRow)}</ResourceList>
        </SettingsDisclosure>
      ) : null}

      {canEditOrganization && invitations.length === 0 ? (
        <ResourceEmpty
          description="Invite someone when they need access to this organization."
          title="No invitations"
        />
      ) : null}

      <AlertDialog
        onOpenChange={(open) => {
          if (!(open || removingMember)) setPendingMemberRemoval(null);
        }}
        open={Boolean(pendingMemberRemoval)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingMemberRemoval?.id === currentMember?.id
                ? "Leave this organization?"
                : "Remove this member?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingMemberRemoval?.user.name || "This person"} will lose
              organization access immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removingMember}>Cancel</AlertDialogCancel>
            <Button
              disabled={removingMember}
              onClick={() => void removeMember()}
              variant="destructive"
            >
              {removingMember ? "Removing…" : "Remove access"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        onOpenChange={(open) => {
          if (
            !(
              open ||
              (pendingInvitationRevoke &&
                isRevoking.includes(pendingInvitationRevoke.id))
            )
          ) {
            setPendingInvitationRevoke(null);
          }
        }}
        open={Boolean(pendingInvitationRevoke)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this invitation?</AlertDialogTitle>
            <AlertDialogDescription>
              The invitation for {pendingInvitationRevoke?.email} will stop
              working immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button onClick={() => void revokeInvitation()} variant="destructive">
              Revoke invitation
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function isInvitationExpired(invitation: {
  expiresAt: string;
  status: string;
}) {
  return (
    invitation.status === "pending" &&
    Number.isFinite(Date.parse(invitation.expiresAt)) &&
    Date.parse(invitation.expiresAt) <= Date.now()
  );
}

function invitationState(invitation: { expiresAt: string; status: string }) {
  if (isInvitationExpired(invitation)) return "expired";
  return invitation.status;
}

function OrganizationIdentity({
  canEdit,
  organizationRecord,
  onUpdated,
}: {
  canEdit: boolean;
  organizationRecord: ActiveOrganization;
  onUpdated: (organizationRecord: ActiveOrganization) => void;
}) {
  const [name, setName] = useState(organizationRecord.name);
  const [slug, setSlug] = useState(organizationRecord.slug ?? "");
  const [logo, setLogo] = useState(organizationRecord.logo ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(organizationRecord.name);
    setSlug(organizationRecord.slug ?? "");
    setLogo(organizationRecord.logo ?? "");
  }, [organizationRecord]);

  async function save() {
    const normalizedName = name.trim();
    const normalizedSlug = slug.trim().toLowerCase();
    if (!isValidOrganizationSlug(normalizedSlug)) {
      toast.error("Organization slug is invalid.");
      return;
    }
    setBusy(true);
    try {
      if (normalizedSlug !== organizationRecord.slug) {
        const availability = await organization.checkSlug({
          slug: normalizedSlug,
        });
        if (availability.error) throw new Error(availability.error.message);
        if (!availability.data?.status) {
          throw new Error("That organization slug is already in use.");
        }
      }
      const updated = await organization.update({
        organizationId: organizationRecord.id,
        data: {
          name: normalizedName,
          slug: normalizedSlug,
          logo: logo.trim() || null,
        },
      });
      if (updated.error) throw new Error(updated.error.message);
      onUpdated({
        ...organizationRecord,
        name: normalizedName,
        slug: normalizedSlug,
        logo: logo.trim() || null,
      });
      toast.success("Organization identity updated.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Organization update failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  function readLogo(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => setLogo(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  }

  return (
    <SettingsSection
      description="Update the organization details shown in workspace navigation and invitations."
      title="Organization identity"
    >
      <SettingsRows>
        <SettingsRow label="Name">
          <Input
            disabled={!canEdit}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </SettingsRow>
        <SettingsRow label="Slug">
          <Input
            disabled={!canEdit}
            maxLength={63}
            onChange={(event) => setSlug(event.target.value.toLowerCase())}
            value={slug}
          />
        </SettingsRow>
        <SettingsRow
          description="Optional. Upload a replacement or leave the current logo unchanged."
          label="Logo"
        >
          <Input
            accept="image/*"
            disabled={!canEdit}
            onChange={(event) => readLogo(event.target.files?.[0])}
            type="file"
          />
        </SettingsRow>
      </SettingsRows>
      {canEdit ? (
        <SettingsActionGroup className="mt-4">
          <Button
            disabled={busy || !name.trim() || !slug.trim()}
            onClick={() => void save()}
            size="sm"
          >
            {busy ? "Saving…" : "Save identity"}
          </Button>
          {logo ? (
            <Button onClick={() => setLogo("")} size="sm" variant="ghost">
              Remove logo
            </Button>
          ) : null}
        </SettingsActionGroup>
      ) : null}
    </SettingsSection>
  );
}

function InviteMemberDialog({
  setOptimisticOrg,
  optimisticOrg,
}: {
  setOptimisticOrg: (org: ActiveOrganization | null) => void;
  optimisticOrg: ActiveOrganization | null;
}) {
  const router = useRouter();
  const [_open, _setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [loading, _setLoading] = useState(false);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button className="gap-2" size="sm">
          <MailPlus size={16} />
          <p>Invite Member</p>
        </Button>
      </DialogTrigger>
      <DialogContent className="w-11/12 sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Invite Member</DialogTitle>
          <DialogDescription>
            Invite a member to your organization.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label>Email</Label>
          <Input
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            value={email}
          />
          <Label>Role</Label>
          <Select onValueChange={setRole} value={role}>
            <SelectTrigger>
              <SelectValue placeholder="Select a role" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="admin">Admin</SelectItem>
              <SelectItem value="member">Member</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <DialogClose>
            <Button
              disabled={loading}
              onClick={() => {
                const invite = organization.inviteMember({
                  email,
                  role: role as "member",
                  fetchOptions: {
                    throw: true,
                    onSuccess: (ctx: any) => {
                      if (optimisticOrg) {
                        setOptimisticOrg({
                          ...optimisticOrg,
                          invitations: [
                            ...(optimisticOrg?.invitations || []),
                            ctx.data,
                          ],
                        });
                      }
                    },
                  },
                });
                toast.promise(invite, {
                  loading: "Inviting member...",
                  success: "Member invited successfully",
                  error: (error: any) => error.error.message,
                });
                void Promise.resolve(invite)
                  .then(
                    () => {},
                    () => {},
                  )
                  .finally(() => router.refresh());
              }}
            >
              Invite
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
