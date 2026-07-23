"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { BrandLockup } from "@/components/brand";
import SignIn from "@/components/sign-in";
import { SignUp } from "@/components/sign-up";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function AuthTabFallback() {
  return <div className="min-h-[320px]" />;
}

export default function Page() {
  return (
    <Suspense fallback={<AuthTabFallback />}>
      <AuthPage />
    </Suspense>
  );
}

function AuthPage() {
  const params = useSearchParams();
  const invited = Boolean(
    params.get("callbackUrl")?.startsWith("/accept-invitation/"),
  );

  return (
    <div className="w-full">
      <div className="flex w-full flex-col items-center justify-center md:py-10">
        <div className="md:w-[400px]">
          <div className="flex justify-center pb-8">
            <BrandLockup height={40} />
          </div>
          <Tabs
            defaultValue={
              params.get("intent") === "sign-up" && invited
                ? "sign-up"
                : "sign-in"
            }
          >
            <TabsList>
              <TabsTrigger value="sign-in">Sign In</TabsTrigger>
              <TabsTrigger value="sign-up">Sign Up</TabsTrigger>
            </TabsList>
            <TabsContent value="sign-in">
              <Suspense fallback={<AuthTabFallback />}>
                <SignIn />
              </Suspense>
            </TabsContent>
            <TabsContent value="sign-up">
              {invited ? (
                <SignUp />
              ) : (
                <p className="rounded border p-4 text-muted-foreground text-sm">
                  Kestrel One accounts are created from an organization
                  invitation.
                </p>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
