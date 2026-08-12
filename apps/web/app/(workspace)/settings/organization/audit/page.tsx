import { permanentRedirect } from "next/navigation";

export default function LegacyOrganizationAuditPage() {
  permanentRedirect("/organization/audit");
}
