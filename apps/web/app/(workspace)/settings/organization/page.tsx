import { permanentRedirect } from "next/navigation";

export default function LegacyOrganizationSettingsPage() {
  permanentRedirect("/organization");
}
