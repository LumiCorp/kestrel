"use client";

import { Key, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { client, signIn } from "@/lib/auth-client";
import { getCallbackURL } from "@/lib/shared";
import { cn } from "@/lib/utils";

export default function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, startTransition] = useTransition();
  const [rememberMe, setRememberMe] = useState(false);
  const [hasHydrated, setHasHydrated] = useState(false);
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    setHasHydrated(true);
  }, []);

  const LastUsedIndicator = () => (
    <span className="absolute top-0 right-0 ml-auto rounded-md bg-blue-100 px-2 py-1 font-medium text-blue-700 text-xs dark:bg-blue-900 dark:text-blue-300">
      Last Used
    </span>
  );

  return (
    <Card className="max-w-md rounded-none">
      <CardHeader>
        <CardTitle className="text-lg md:text-xl">Sign In</CardTitle>
        <CardDescription className="text-xs md:text-sm">
          Enter your email below to login to your account
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              onChange={(e) => {
                setEmail(e.target.value);
              }}
              placeholder="m@example.com"
              required
              type="email"
              value={email}
            />
          </div>

          <div className="grid gap-2">
            <div className="flex items-center">
              <Label htmlFor="password">Password</Label>
              <Link
                className="ml-auto inline-block text-sm underline"
                href="/forget-password"
              >
                Forgot your password?
              </Link>
            </div>

            <Input
              autoComplete="password"
              id="password"
              onChange={(e) => setPassword(e.target.value)}
              placeholder="password"
              type="password"
              value={password}
            />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="remember"
              onClick={() => {
                setRememberMe(!rememberMe);
              }}
            />
            <Label htmlFor="remember">Remember me</Label>
          </div>

          <Button
            className="flex w-full items-center justify-center"
            disabled={loading}
            onClick={() => {
              startTransition(async () => {
                await signIn.email(
                  { email, password, rememberMe },
                  {
                    onSuccess(_context: any) {
                      toast.success("Successfully signed in");
                      router.push(getCallbackURL(params));
                    },
                    onError(context: any) {
                      toast.error(context.error.message);
                    },
                  }
                );
              });
            }}
            type="submit"
          >
            <div className="relative flex w-full items-center justify-center">
              {loading ? (
                <Loader2 className="animate-spin" size={16} />
              ) : (
                "Login"
              )}
              {hasHydrated && client.isLastUsedLoginMethod("email") && (
                <LastUsedIndicator />
              )}
            </div>
          </Button>

          <div
            className={cn(
              "flex w-full items-center gap-2",
              "flex-col justify-between"
            )}
          >
            <Button
              className={cn("relative flex w-full items-center gap-2")}
              onClick={async () => {
                await signIn.passkey({
                  fetchOptions: {
                    onSuccess() {
                      toast.success("Successfully signed in");
                      router.push(getCallbackURL(params));
                    },
                    onError(context: any) {
                      toast.error(
                        `Authentication failed: ${context.error.message}`
                      );
                    },
                  },
                });
              }}
              variant="outline"
            >
              <Key size={16} />
              <span>Sign in with Passkey</span>
              {hasHydrated && client.isLastUsedLoginMethod("passkey") && (
                <LastUsedIndicator />
              )}
            </Button>
          </div>
        </div>
      </CardContent>
      <CardFooter>
        <div className="flex w-full justify-center border-t pt-4">
          <p className="text-center text-muted-foreground text-xs">
            Kestrel One by Lumi Corp
          </p>
        </div>
      </CardFooter>
    </Card>
  );
}
