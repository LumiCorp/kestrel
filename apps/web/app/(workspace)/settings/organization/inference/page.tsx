import { permanentRedirect } from "next/navigation";

export default function LegacyOrganizationInferencePage() {
  permanentRedirect("/organization/inference");
}
