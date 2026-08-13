import { permanentRedirect } from "next/navigation";

export default function LegacyAdminDocsPage() {
  permanentRedirect("/platform/docs");
}
