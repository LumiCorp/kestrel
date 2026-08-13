import { permanentRedirect } from "next/navigation";

export default function LegacyPlatformUsersPage() {
  permanentRedirect("/platform/users");
}
