import { permanentRedirect } from "next/navigation";

export default function LegacyOrganizationAgentDefaultsPage() {
  permanentRedirect("/organization/agent-defaults");
}
