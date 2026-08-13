import { redirect } from "next/navigation";
import { SignupOnboardingClient } from "@/components/signup-onboarding-client";
import { getSignupOnboardingSnapshot } from "@/lib/signup-onboarding";
import { auth } from "../(auth)/auth";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ verificationDelivery?: string }>;
}) {
  const [session, query] = await Promise.all([auth(), searchParams]);
  if (!session?.user) {
    redirect("/sign-in?callbackUrl=/onboarding");
  }

  const snapshot = await getSignupOnboardingSnapshot({
    userId: session.user.id,
  });
  if (snapshot.onboarding.state === "not_applicable") {
    redirect("/");
  }
  if (snapshot.onboarding.state === "complete") {
    redirect("/threads/new");
  }

  return (
    <main className="min-h-dvh bg-background px-4 py-14 sm:px-6">
      <div className="mx-auto max-w-[70rem]">
        <SignupOnboardingClient
          email={session.user.email}
          initialCanComplete={snapshot.canComplete}
          initialGateways={snapshot.gateways}
          initialState={snapshot.onboarding}
          initialVerificationDeliveryFailed={
            query.verificationDelivery === "failed"
          }
        />
      </div>
    </main>
  );
}
