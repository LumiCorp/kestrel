import { SignupCodesClient } from "@/components/settings/signup-codes-client";
import { requireAuthenticatedShell } from "@/lib/knowledge/auth";
import { listSignupAccessCodes } from "@/lib/signup-access-codes";

export default async function SignupCodesPage() {
  await requireAuthenticatedShell({ requireAdmin: true });
  return <SignupCodesClient initialCodes={await listSignupAccessCodes()} />;
}
