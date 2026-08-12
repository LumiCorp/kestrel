import { permanentRedirect } from "next/navigation";

export default function LegacyOrganizationEmailPage() {
  permanentRedirect("/organization/email");
}
