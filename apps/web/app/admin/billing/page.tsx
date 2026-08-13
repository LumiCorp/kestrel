import { permanentRedirect } from "next/navigation";

export default function LegacyAdminBillingPage() {
  permanentRedirect("/platform/billing");
}
