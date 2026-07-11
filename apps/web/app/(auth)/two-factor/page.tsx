"use client";

import { AlertCircle, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
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
import { client } from "@/lib/auth-client";

const TOTP_CODE_REGEX = /^\d+$/;

export default function Component() {
  const [totpCode, setTotpCode] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (totpCode.length !== 6 || !TOTP_CODE_REGEX.test(totpCode)) {
      setError("TOTP code must be 6 digits");
      return;
    }
    client.twoFactor
      .verifyTotp({
        code: totpCode,
      })
      .then((res: any) => {
        if (res.data?.token) {
          setSuccess(true);
          setError("");
        } else {
          setError("Invalid TOTP code");
        }
      });
  };

  return (
    <main className="flex min-h-[calc(100vh-10rem)] flex-col items-center justify-center">
      <Card className="w-[350px]">
        <CardHeader>
          <CardTitle>TOTP Verification</CardTitle>
          <CardDescription>
            Enter your 6-digit TOTP code to authenticate
          </CardDescription>
        </CardHeader>
        <CardContent>
          {success ? (
            <div className="flex flex-col items-center justify-center space-y-2">
              <CheckCircle2 className="h-12 w-12 text-green-500" />
              <p className="font-semibold text-lg">Verification Successful</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              <div className="space-y-2">
                <Label htmlFor="totp">TOTP Code</Label>
                <Input
                  id="totp"
                  inputMode="numeric"
                  maxLength={6}
                  onChange={(e) => setTotpCode(e.target.value)}
                  pattern="\d{6}"
                  placeholder="Enter 6-digit code"
                  required
                  type="text"
                  value={totpCode}
                />
              </div>
              {error && (
                <div className="mt-2 flex items-center text-red-500">
                  <AlertCircle className="mr-2 h-4 w-4" />
                  <span className="text-sm">{error}</span>
                </div>
              )}
              <Button className="mt-4 w-full" type="submit">
                Verify
              </Button>
            </form>
          )}
        </CardContent>
        <CardFooter className="gap-2 text-muted-foreground text-sm">
          <Link href="/two-factor/otp">
            <Button size="sm" variant="link">
              Switch to Email Verification
            </Button>
          </Link>
        </CardFooter>
      </Card>
    </main>
  );
}
