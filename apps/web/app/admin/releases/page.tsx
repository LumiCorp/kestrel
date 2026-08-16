import { permanentRedirect } from "next/navigation";

export default function LegacyAdminReleasesPage() {
  permanentRedirect("/platform/operations");
}
