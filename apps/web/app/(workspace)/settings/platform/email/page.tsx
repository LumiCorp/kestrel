import { permanentRedirect } from "next/navigation";

export default function LegacyPlatformEmailPage() {
  permanentRedirect("/platform/email");
}
