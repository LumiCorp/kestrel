import { permanentRedirect } from "next/navigation";

export default function LegacyOrganizationMembersPage() {
  permanentRedirect("/organization/people");
}
