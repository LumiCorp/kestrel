"use client";

import { ChevronDownIcon } from "@radix-ui/react-icons";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2, MailPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  CreateOrganizationDialog,
  isValidOrganizationSlug,
} from "@/components/create-organization-dialog";
import {
  SettingsPanel,
  SettingsPanelContent,
  SettingsPanelHeader,
  SettingsPanelTitle,
  SettingsActionGroup,
  SettingsRow,
  SettingsRows,
  SettingsSection,
} from "@/components/settings/settings-section";
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
import {
  organization,
  useListOrganizations,
  useSession,
} from "@/lib/auth-client";
import type { ActiveOrganization, Session } from "@/lib/auth-types";
import { isPersonalOrganization } from "@/lib/personal-workspace-shared";

export function OrganizationCard(props: {
  session: Session | null;
  activeOrganization: ActiveOrganization | null;
  invitationOrigin: string | null;
  invitationSetupIssue: string | null;
}) {
  const router = useRouter();
  const organizations = useListOrganizations();
  const [optimisticOrg, setOptimisticOrg] = useState<ActiveOrganization | null>(
    props.activeOrganization,
  );
  const [isRevoking, setIsRevoking] = useState<string[]>([]);
  const [isResending, setIsResending] = useState<string[]>([]);
  const inviteVariants = {
    hidden: { opacity: 0, height: 0 },
    visible: { opacity: 1, height: "auto" },
    exit: { opacity: 0, height: 0 },
  };

  const { data } = useSession();
  const session = data || props.session;
  const personalOrg =
    organizations.data?.find((org: any) => isPersonalOrganization(org)) ?? null;
  const teamOrganizations =
    organizations.data?.filter((org: any) => !isPersonalOrganization(org)) ??
    [];
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

  return (
    <>
      {!activeIsPersonal && optimisticOrg ? (
        <OrganizationIdentity
          canEdit={canEditOrganization}
          organizationRecord={optimisticOrg}
          onUpdated={setOptimisticOrg}
        />
      ) : null}
      <SettingsPanel>
        <SettingsPanelHeader>
          <SettingsPanelTitle>Organization</SettingsPanelTitle>
          <div className="flex justify-between">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <div className="flex cursor-pointer items-center gap-1">
                  <p className="text-sm">
                    <span className="font-bold" />{" "}
                    {activeIsPersonal
                      ? "Personal"
                      : optimisticOrg?.name || "Personal"}
                  </p>

                  <ChevronDownIcon />
                </div>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {personalOrg ? (
                  <DropdownMenuItem
                    className="py-1"
                    onClick={async () => {
                      if (personalOrg.id === optimisticOrg?.id) {
                        return;
                      }

                      setOptimisticOrg({
                        members: [],
                        invitations: [],
                        ...personalOrg,
                      });
                      const { data: activeData } = await organization.setActive(
                        {
                          organizationId: personalOrg.id,
                        },
                      );
                      setOptimisticOrg(activeData);
                      router.refresh();
                    }}
                  >
                    <p className="sm text-sm">Personal</p>
                  </DropdownMenuItem>
                ) : null}
                {teamOrganizations.map((org: any) => (
                  <DropdownMenuItem
                    className="py-1"
                    key={org.id}
                    onClick={async () => {
                      if (org.id === optimisticOrg?.id) {
                        return;
                      }
                      setOptimisticOrg({
                        members: [],
                        invitations: [],
                        ...org,
                      });
                      const { data: activeData } = await organization.setActive(
                        {
                          organizationId: org.id,
                        },
                      );
                      setOptimisticOrg(activeData);
                      router.refresh();
                    }}
                  >
                    <p className="sm text-sm">{org.name}</p>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <div>
              <CreateOrganizationDialog />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Avatar className="rounded-none">
              <AvatarImage
                className="h-full w-full rounded-none object-cover"
                src={optimisticOrg?.logo || undefined}
              />
              <AvatarFallback className="rounded-none">
                {(activeIsPersonal ? "Personal" : optimisticOrg?.name)?.charAt(
                  0,
                ) || "P"}
              </AvatarFallback>
            </Avatar>
            <div>
              <p>
                {activeIsPersonal
                  ? "Personal"
                  : optimisticOrg?.name || "Personal"}
              </p>
              <p className="text-muted-foreground text-xs">
                {optimisticOrg?.members?.length || 1} members
              </p>
            </div>
          </div>
        </SettingsPanelHeader>
        <SettingsPanelContent>
          <div className="flex flex-col gap-8 md:flex-row">
            <div className="flex grow flex-col gap-2">
              <p className="border-b-2 border-b-foreground/10 font-medium">
                Members
              </p>
              <div className="flex flex-col gap-2">
                {optimisticOrg?.members?.map((member) => (
                  <div
                    className="flex items-center justify-between"
                    key={member.id}
                  >
                    <div className="flex items-center gap-2">
                      <Avatar className="h-9 w-9 sm:flex">
                        <AvatarImage
                          className="object-cover"
                          src={member.user.image || undefined}
                        />
                        <AvatarFallback>
                          {member.user.name?.charAt(0)}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="text-sm">{member.user.name}</p>
                        <p className="text-muted-foreground text-xs">
                          {member.role}
                        </p>
                      </div>
                    </div>
                    {!activeIsPersonal &&
                      member.role !== "owner" &&
                      (currentMember?.role === "owner" ||
                        currentMember?.role === "admin") && (
                        <Button
                          onClick={() => {
                            organization.removeMember({
                              memberIdOrEmail: member.id,
                            });
                          }}
                          size="sm"
                          variant="destructive"
                        >
                          {currentMember?.id === member.id ? "Leave" : "Remove"}
                        </Button>
                      )}
                  </div>
                ))}
                {activeIsPersonal && !optimisticOrg?.members?.length && (
                  <div>
                    <div className="flex items-center gap-2">
                      <Avatar>
                        <AvatarImage src={session?.user.image || undefined} />
                        <AvatarFallback>
                          {session?.user.name?.charAt(0)}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="text-sm">{session?.user.name}</p>
                        <p className="text-muted-foreground text-xs">Owner</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
            {canEditOrganization ? (
              <div className="flex grow flex-col gap-2">
                <p className="border-b-2 border-b-foreground/10 font-medium">
                  Invites
                </p>
                {props.invitationSetupIssue ? (
                  <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-950 text-sm dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                    {props.invitationSetupIssue}
                  </p>
                ) : null}
                <div className="flex flex-col gap-2">
                  <AnimatePresence>
                    {optimisticOrg?.invitations?.map((invitation) => (
                      <motion.div
                        animate="visible"
                        className="flex items-center justify-between"
                        exit="exit"
                        initial="hidden"
                        key={invitation.id}
                        layout
                        variants={inviteVariants}
                      >
                        <div>
                          <p className="text-sm">{invitation.email}</p>
                          <p className="text-muted-foreground text-xs">
                            {invitationState(invitation)} · {invitation.role}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          {invitation.status === "pending" ? (
                            <Button
                              disabled={isRevoking.includes(invitation.id)}
                              onClick={() => {
                                organization.cancelInvitation(
                                  {
                                    invitationId: invitation.id,
                                  },
                                  {
                                    onRequest: () => {
                                      setIsRevoking((current) => [
                                        ...current,
                                        invitation.id,
                                      ]);
                                    },
                                    onSuccess: () => {
                                      toast.message(
                                        "Invitation revoked successfully",
                                      );
                                      setIsRevoking((current) =>
                                        current.filter(
                                          (id) => id !== invitation.id,
                                        ),
                                      );
                                      setOptimisticOrg({
                                        ...optimisticOrg,
                                        invitations:
                                          optimisticOrg?.invitations?.map(
                                            (inv) =>
                                              inv.id === invitation.id
                                                ? { ...inv, status: "canceled" }
                                                : inv,
                                          ) || [],
                                      });
                                    },
                                    onError: (ctx: any) => {
                                      toast.error(ctx.error.message);
                                      setIsRevoking((current) =>
                                        current.filter(
                                          (id) => id !== invitation.id,
                                        ),
                                      );
                                    },
                                  },
                                );
                              }}
                              size="sm"
                              variant="destructive"
                            >
                              {isRevoking.includes(invitation.id) ? (
                                <Loader2 className="animate-spin" size={16} />
                              ) : (
                                "Revoke"
                              )}
                            </Button>
                          ) : null}
                          {invitation.status === "pending" &&
                          !isInvitationExpired(invitation) ? (
                            <Button
                              disabled={isResending.includes(invitation.id)}
                              onClick={() => {
                                const resend = organization.inviteMember({
                                  email: invitation.email,
                                  role: invitation.role,
                                  resend: true,
                                  fetchOptions: { throw: true },
                                });
                                setIsResending((current) => [
                                  ...current,
                                  invitation.id,
                                ]);
                                toast.promise(resend, {
                                  loading: "Resending invitation…",
                                  success: "Invitation resent",
                                  error: (error: any) =>
                                    error.error?.message ||
                                    "Invitation delivery failed",
                                });
                                void Promise.resolve(resend)
                                  .then(
                                    () => {},
                                    () => {},
                                  )
                                  .finally(() => {
                                    setIsResending((current) =>
                                      current.filter(
                                        (id) => id !== invitation.id,
                                      ),
                                    );
                                  });
                              }}
                              size="sm"
                              variant="outline"
                            >
                              {isResending.includes(invitation.id)
                                ? "Sending…"
                                : "Resend"}
                            </Button>
                          ) : null}
                          {isInvitationExpired(invitation) ? (
                            <Button
                              disabled={isResending.includes(invitation.id)}
                              onClick={() => {
                                const renew = organization
                                  .cancelInvitation({
                                    invitationId: invitation.id,
                                  })
                                  .then((cancelled: any) => {
                                    if (cancelled.error)
                                      throw new Error(cancelled.error.message);
                                    return organization.inviteMember({
                                      email: invitation.email,
                                      role: invitation.role,
                                      fetchOptions: { throw: true },
                                    });
                                  });
                                setIsResending((current) => [
                                  ...current,
                                  invitation.id,
                                ]);
                                toast.promise(renew, {
                                  loading: "Sending a new invitation…",
                                  success: "New invitation sent",
                                  error: (error: any) =>
                                    error.error?.message ||
                                    error.message ||
                                    "Invitation renewal failed",
                                });
                                void Promise.resolve(renew)
                                  .then(
                                    (result: any) => {
                                      if (result?.data && optimisticOrg) {
                                        setOptimisticOrg({
                                          ...optimisticOrg,
                                          invitations: [
                                            result.data,
                                            ...(
                                              optimisticOrg.invitations || []
                                            ).filter(
                                              (item) =>
                                                item.id !== invitation.id,
                                            ),
                                          ],
                                        });
                                      }
                                    },
                                    () => {},
                                  )
                                  .finally(() => {
                                    setIsResending((current) =>
                                      current.filter(
                                        (id) => id !== invitation.id,
                                      ),
                                    );
                                  });
                              }}
                              size="sm"
                              variant="outline"
                            >
                              {isResending.includes(invitation.id)
                                ? "Sending…"
                                : "Send new invite"}
                            </Button>
                          ) : null}
                          {invitation.status === "pending" &&
                          !isInvitationExpired(invitation) &&
                          props.invitationOrigin ? (
                            <div>
                              <CopyButton
                                textToCopy={`${props.invitationOrigin}/accept-invitation/${invitation.id}`}
                              />
                            </div>
                          ) : null}
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                  {!activeIsPersonal &&
                    optimisticOrg?.invitations?.length === 0 && (
                      <motion.p
                        animate={{ opacity: 1 }}
                        className="text-muted-foreground text-sm"
                        exit={{ opacity: 0 }}
                        initial={{ opacity: 0 }}
                      >
                        No Active Invitations
                      </motion.p>
                    )}
                </div>
              </div>
            ) : null}
          </div>
          <div className="mt-4 flex w-full justify-end">
            <div>
              <div>
                {canEditOrganization &&
                  !activeIsPersonal &&
                  optimisticOrg?.id && (
                    <InviteMemberDialog
                      optimisticOrg={optimisticOrg}
                      setOptimisticOrg={setOptimisticOrg}
                    />
                  )}
              </div>
            </div>
          </div>
        </SettingsPanelContent>
      </SettingsPanel>
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
        <Button className="w-full gap-2" size="sm" variant="secondary">
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
