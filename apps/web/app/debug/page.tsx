import { permanentRedirect } from "next/navigation";

export default function DebugPage() {
  permanentRedirect("/admin/environments");
}
