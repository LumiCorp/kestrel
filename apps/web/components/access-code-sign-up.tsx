"use client";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { BrandLockup } from "@/components/brand";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { client, signUp } from "@/lib/auth-client";
import { SIGNUP_ACCESS_CODE_HEADER } from "@/lib/signup-access-code-shared";

function displayNameFromEmail(email: string) {
  return email.trim().split("@", 1)[0]?.trim() || "Kestrel user";
}

export function AccessCodeSignUp() {
  const params = useSearchParams();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState(params.get("invite") ?? "");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    try {
      const result = await signUp.email({
        email,
        password,
        name: displayNameFromEmail(email),
        callbackURL: "/onboarding",
        fetchOptions: {
          headers: { [SIGNUP_ACCESS_CODE_HEADER]: inviteCode },
        },
      });
      if (result?.error) {
        throw new Error(result.error.message);
      }

      let verificationDeliveryFailed = false;
      try {
        const verification = await client.sendVerificationEmail({
          email,
          callbackURL: "/onboarding",
        });
        verificationDeliveryFailed = Boolean(verification?.error);
      } catch {
        verificationDeliveryFailed = true;
      }

      if (verificationDeliveryFailed) {
        router.push("/onboarding?verificationDelivery=failed");
      } else {
        router.push("/onboarding");
      }
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Account creation failed.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="flex justify-center pb-8">
          <BrandLockup height={40} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Create your Kestrel One account</CardTitle>
            <CardDescription>
              Enter the invite code you received to get started.
            </CardDescription>
          </CardHeader>
          <form onSubmit={submit}>
            <CardContent className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="signup-email">Email</Label>
                <Input
                  autoComplete="email"
                  id="signup-email"
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  type="email"
                  value={email}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="signup-password">Password</Label>
                <Input
                  autoComplete="new-password"
                  id="signup-password"
                  minLength={8}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  type="password"
                  value={password}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="signup-invite-code">Invite code</Label>
                <Input
                  autoCapitalize="characters"
                  autoComplete="off"
                  id="signup-invite-code"
                  onChange={(event) => setInviteCode(event.target.value)}
                  required
                  value={inviteCode}
                />
              </div>
              <Button disabled={loading} type="submit">
                {loading ? <Loader2 className="size-4 animate-spin" /> : null}
                Create account
              </Button>
            </CardContent>
          </form>
          <CardFooter className="justify-center border-t pt-5 text-sm">
            Already have an account?&nbsp;
            <Link className="underline" href="/sign-in">
              Sign in
            </Link>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
