import { permanentRedirect } from "next/navigation";

export default function LegacyAdminUsersPage() {
  permanentRedirect("/platform/users");
}
