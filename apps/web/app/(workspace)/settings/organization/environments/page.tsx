import { permanentRedirect } from "next/navigation";

export default function LegacyOrganizationEnvironmentsPage() {
  permanentRedirect("/organization");
}
