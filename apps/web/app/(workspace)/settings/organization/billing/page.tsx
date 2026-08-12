import { permanentRedirect } from "next/navigation";

export default function LegacyOrganizationBillingPage() {
  permanentRedirect("/organization/billing");
}
