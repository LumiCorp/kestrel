import { permanentRedirect } from "next/navigation";

export default function PlatformSettingsPage() {
  permanentRedirect("/platform/users");
}
