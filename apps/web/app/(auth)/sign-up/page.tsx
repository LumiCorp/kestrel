import { Suspense } from "react";
import { AccessCodeSignUp } from "@/components/access-code-sign-up";

export default function SignUpPage() {
  return (
    <Suspense fallback={<div className="min-h-dvh" />}>
      <AccessCodeSignUp />
    </Suspense>
  );
}
