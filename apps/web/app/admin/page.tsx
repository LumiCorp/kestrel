import { permanentRedirect } from "next/navigation";

export default function AdminPage() {
  permanentRedirect("/platform/operations");
}
