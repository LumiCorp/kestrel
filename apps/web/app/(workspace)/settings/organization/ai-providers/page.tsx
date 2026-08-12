import { permanentRedirect } from "next/navigation";

export default function LegacyOrganizationAiProvidersPage() {
  permanentRedirect("/organization/connections");
}
