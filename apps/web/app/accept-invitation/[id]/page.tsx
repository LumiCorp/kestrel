"use client";

import { CheckIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { client, organization, useSession } from "@/lib/auth-client";
import { invitationPath } from "@/lib/invitation-shared";
import { InvitationError } from "./invitation-error";

type Invitation = {
  organizationName: string;
  organizationSlug: string;
  inviterEmail: string;
  id: string;
  status: "pending" | "accepted" | "rejected" | "canceled";
  email: string;
  expiresAt: Date | string;
  organizationId: string;
  role: string;
  inviterId: string;
};

export default function InvitationPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { data: session, isPending: sessionPending } = useSession();
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [invitationStatus, setInvitationStatus] = useState<
    "pending" | "accepted" | "rejected"
  >("pending");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const callbackURL = useMemo(() => invitationPath(params.id), [params.id]);

  useEffect(() => {
    if (!session?.user || sessionPending) return;

    let active = true;
    client.organization
      .getInvitation({ query: { id: params.id } })
      .then((res: any) => {
        if (!active) return;
        if (res.error) {
          setError(
            res.error.message ||
              "This invitation is unavailable for this account.",
          );
          return;
        }
        setInvitation(res.data);
      })
      .catch(() => {
        if (!active) return;
        setError("This invitation could not be loaded. Please try again.");
      });

    return () => {
      active = false;
    };
  }, [params.id, session?.user, sessionPending]);

  async function activateAndContinue(organizationId: string) {
    const active = await organization.setActive({ organizationId });
    if (active.error) {
      throw new Error(
        active.error.message || "Your organization could not be activated.",
      );
    }
    router.replace("/welcome");
  }

  async function handleAccept() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await organization.acceptInvitation({
        invitationId: params.id,
      });
      if (result.error)
        throw new Error(
          result.error.message || "Invitation acceptance failed.",
        );
      setInvitationStatus("accepted");
      if (invitation) await activateAndContinue(invitation.organizationId);
    } catch (acceptError) {
      setError(
        acceptError instanceof Error
          ? acceptError.message
          : "Invitation acceptance failed.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReject() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await organization.rejectInvitation({
        invitationId: params.id,
      });
      if (result.error)
        throw new Error(result.error.message || "Invitation decline failed.");
      setInvitationStatus("rejected");
    } catch (rejectError) {
      setError(
        rejectError instanceof Error
          ? rejectError.message
          : "Invitation decline failed.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleContinue() {
    if (!invitation) return;

    setSubmitting(true);
    setError(null);
    try {
      await activateAndContinue(invitation.organizationId);
    } catch (activationError) {
      setError(
        activationError instanceof Error
          ? activationError.message
          : "Your organization could not be activated.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (sessionPending) return <InvitationSkeleton />;

  if (!session?.user) {
    return (
      <InvitationFrame>
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Organization Invitation</CardTitle>
            <CardDescription>
              Sign in or create an account to review this invitation.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm">
              Use the email address that received the invitation. Kestrel One
              accounts are created from organization invitations.
            </p>
          </CardContent>
          <CardFooter className="flex gap-2">
            <Button asChild className="flex-1" variant="outline">
              <Link
                href={`/sign-in?callbackUrl=${encodeURIComponent(callbackURL)}`}
              >
                Sign in
              </Link>
            </Button>
            <Button asChild className="flex-1">
              <Link
                href={`/sign-in?intent=sign-up&callbackUrl=${encodeURIComponent(callbackURL)}`}
              >
                Create account
              </Link>
            </Button>
          </CardFooter>
        </Card>
      </InvitationFrame>
    );
  }

  if (error && !invitation) {
    return (
      <InvitationFrame>
        <InvitationError
          detail="This invitation is unavailable for the signed-in account. Sign in with the invited email address, or ask the sender for a new invitation."
          signInHref={`/sign-in?callbackUrl=${encodeURIComponent(callbackURL)}`}
        />
      </InvitationFrame>
    );
  }

  if (!invitation) return <InvitationSkeleton />;

  const expiresAt = new Date(invitation.expiresAt);
  return (
    <InvitationFrame>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Organization Invitation</CardTitle>
          <CardDescription>
            You&apos;ve been invited to join an organization
          </CardDescription>
        </CardHeader>
        <CardContent>
          {invitationStatus === "pending" ? (
            <div className="space-y-4">
              <p>
                <strong>{invitation.inviterEmail}</strong> has invited you to
                join <strong>{invitation.organizationName}</strong> as a{" "}
                <strong>{invitation.role || "member"}</strong>.
              </p>
              <p>
                This invitation was sent to <strong>{invitation.email}</strong>{" "}
                and expires {expiresAt.toLocaleString()}.
              </p>
              {error ? (
                <p className="text-destructive text-sm">{error}</p>
              ) : null}
            </div>
          ) : null}
          {invitationStatus === "accepted" ? (
            <div className="space-y-4 text-center">
              <CheckIcon className="mx-auto size-10 text-green-600" />
              <h2 className="font-bold text-2xl">
                Welcome to {invitation.organizationName}!
              </h2>
              <p>
                You&apos;ve joined the organization. Finishing your workspace
                setup…
              </p>
              {error ? (
                <>
                  <p className="text-destructive text-sm">{error}</p>
                  <Button
                    disabled={submitting}
                    onClick={() => void handleContinue()}
                  >
                    Continue to workspace
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}
          {invitationStatus === "rejected" ? (
            <div className="space-y-4 text-center">
              <XIcon className="mx-auto size-10 text-red-600" />
              <h2 className="font-bold text-2xl">Invitation Declined</h2>
              <p>
                You&apos;ve declined the invitation to join{" "}
                {invitation.organizationName}.
              </p>
            </div>
          ) : null}
        </CardContent>
        {invitationStatus === "pending" ? (
          <CardFooter className="flex justify-between">
            <Button
              disabled={submitting}
              onClick={() => void handleReject()}
              variant="outline"
            >
              Decline
            </Button>
            <Button disabled={submitting} onClick={() => void handleAccept()}>
              {submitting ? "Joining…" : "Join organization"}
            </Button>
          </CardFooter>
        ) : null}
      </Card>
    </InvitationFrame>
  );
}

function InvitationFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[80vh] items-center justify-center px-4">
      <div className="mask-[radial-gradient(ellipse_at_center,transparent_20%,black)] pointer-events-none absolute inset-0 flex items-center justify-center bg-white dark:bg-black" />
      {children}
    </div>
  );
}

function InvitationSkeleton() {
  return (
    <InvitationFrame>
      <Card className="mx-auto w-full max-w-md">
        <CardHeader>
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-full" />
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </CardContent>
      </Card>
    </InvitationFrame>
  );
}
