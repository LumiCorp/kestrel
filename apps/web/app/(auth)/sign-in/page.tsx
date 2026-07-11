"use client";

import { Suspense } from "react";
import SignIn from "@/components/sign-in";
import { SignUp } from "@/components/sign-up";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function AuthTabFallback() {
  return <div className="min-h-[320px]" />;
}

export default function Page() {
  return (
    <div className="w-full">
      <div className="flex w-full flex-col items-center justify-center md:py-10">
        <div className="md:w-[400px]">
          <Tabs defaultValue="sign-in">
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
              <Suspense fallback={<AuthTabFallback />}>
                <SignUp />
              </Suspense>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
