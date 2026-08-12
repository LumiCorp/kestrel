"use client";

import { Loader2, MailCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import {
  OrganizationSetupClient,
  type SetupGateway,
} from "@/components/settings/setup-client";
import { BrandLockup } from "@/components/brand";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { client } from "@/lib/auth-client";
import type { SignupOnboardingState } from "@/lib/signup-onboarding";

export function SignupOnboardingClient({
  email,
  initialCanComplete,
  initialState,
  initialGateways,
  initialVerificationDeliveryFailed,
}: {
  email: string;
  initialCanComplete: boolean;
  initialState: SignupOnboardingState;
  initialGateways: SetupGateway[];
  initialVerificationDeliveryFailed: boolean;
}) {
  const router = useRouter();
  const [inviteCode, setInviteCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [deliveryWarning, setDeliveryWarning] = useState(
    initialVerificationDeliveryFailed,
  );

  async function signOut() {
    await client.signOut();
    window.location.assign("/sign-in");
  }

  if (initialState.state === "email_verification_required") {
    return (
      <OnboardingCard
        description={`We sent a verification link to ${email}. Verify that address before configuring credentials.`}
        icon={<MailCheck className="size-6" />}
        title="Check your email"
      >
        {deliveryWarning ? (
          <div
            className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-950 text-sm"
            role="alert"
          >
            We could not send the first verification email. Resend it below.
          </div>
        ) : null}
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const result = await client.sendVerificationEmail({
                email,
                callbackURL: "/onboarding",
              });
              if (result.error) {
                throw new Error("Verification email could not be sent.");
              }
              setDeliveryWarning(false);
              router.replace("/onboarding");
              toast.success("Verification email sent.");
            } catch (error) {
              setDeliveryWarning(true);
              toast.error("Verification email could not be sent.");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          Resend verification email
        </Button>
        <Button onClick={() => router.refresh()} variant="outline">
          I have verified my email
        </Button>
        <Button onClick={() => void signOut()} variant="ghost">
          Sign out
        </Button>
      </OnboardingCard>
    );
  }

  if (initialState.state === "invite_code_required") {
    async function replaceCode(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      setBusy(true);
      try {
        const response = await fetch("/api/onboarding", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "replace-invite-code",
            inviteCode,
          }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error ?? "This invite code is unavailable.");
        }
        router.refresh();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Invite code failed.",
        );
      } finally {
        setBusy(false);
      }
    }

    return (
      <OnboardingCard
        description="Your original reservation expired. Enter another valid invite code to continue with this account."
        title="Invite code required"
      >
        <form className="grid gap-3" onSubmit={replaceCode}>
          <Label htmlFor="replacement-invite-code">Invite code</Label>
          <Input
            autoCapitalize="characters"
            autoComplete="off"
            id="replacement-invite-code"
            onChange={(event) => setInviteCode(event.target.value)}
            required
            value={inviteCode}
          />
          <Button disabled={busy} type="submit">
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Continue
          </Button>
        </form>
        <Button onClick={() => void signOut()} variant="ghost">
          Sign out
        </Button>
      </OnboardingCard>
    );
  }

  if (!initialState.readiness) {
    return null;
  }

  return (
    <OrganizationSetupClient
      initialCanComplete={initialCanComplete}
      initialGateways={initialGateways}
      initialReadiness={initialState.readiness}
      mode="signup"
    />
  );
}

function OnboardingCard({
  children,
  description,
  icon,
  title,
}: {
  children: React.ReactNode;
  description: string;
  icon?: React.ReactNode;
  title: string;
}) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="flex justify-center pb-8">
          <BrandLockup height={40} />
        </div>
        <Card>
          <CardHeader>
            {icon}
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">{children}</CardContent>
        </Card>
      </div>
    </div>
  );
}
