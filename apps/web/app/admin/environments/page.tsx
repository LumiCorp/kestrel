import { permanentRedirect } from "next/navigation";

export default function LegacyAdminEnvironmentsPage() {
  permanentRedirect("/platform/operations");
}
