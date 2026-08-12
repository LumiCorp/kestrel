import { permanentRedirect } from "next/navigation";

export default function LegacyOrganizationSetupPage() {
  permanentRedirect("/organization/setup");
}
