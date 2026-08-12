import { permanentRedirect } from "next/navigation";

export default function LegacyOrganizationUsagePage() {
  permanentRedirect("/organization/usage");
}
