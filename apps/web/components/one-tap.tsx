"use client";

import { Key, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { signIn } from "@/lib/auth-client";
import { PasswordInput } from "./password-input";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export function OneTap() {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <Dialog onOpenChange={(change) => setIsOpen(change)} open={isOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-lg md:text-xl">Sign In</DialogTitle>
          <DialogDescription className="text-xs md:text-sm">
            Enter your email below to login to your account
          </DialogDescription>
        </DialogHeader>
        <SignInBox />
      </DialogContent>
    </Dialog>
  );
}

function SignInBox() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
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
        <PasswordInput
          autoComplete="password"
          id="password"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setPassword(e.target.value)
          }
          placeholder="Password"
          value={password}
        />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          onClick={() => {
            setRememberMe(!rememberMe);
          }}
        />
        <Label>Remember me</Label>
      </div>

      <Button
        className="w-full"
        disabled={loading}
        onClick={async () => {
          await signIn.email(
            {
              email,
              password,
              callbackURL: "/",
              rememberMe,
            },
            {
              onRequest: () => {
                setLoading(true);
              },
              onResponse: () => {
                setLoading(false);
              },
              onError: (ctx: any) => {
                toast.error(ctx.error.message);
              },
            }
          );
        }}
        type="submit"
      >
        {loading ? <Loader2 className="animate-spin" size={16} /> : "Login"}
      </Button>
      <Button
        className="gap-2"
        onClick={async () => {
          await signIn.passkey({
            fetchOptions: {
              onSuccess(_context: any) {
                router.push("/");
              },
              onError(context: any) {
                toast.error(context.error.message);
              },
            },
          });
        }}
        variant="outline"
      >
        <Key size={16} />
        Sign-in with Passkey
      </Button>
    </div>
  );
}
