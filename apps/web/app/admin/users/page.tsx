import { permanentRedirect } from "next/navigation";

export default function LegacyAdminUsersPage() {
  permanentRedirect("/settings/platform/users");
}
