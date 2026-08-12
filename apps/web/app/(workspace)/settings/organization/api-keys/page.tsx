import { permanentRedirect } from "next/navigation";

export default function LegacyOrganizationApiKeysPage() {
  permanentRedirect("/organization/api-keys");
}
