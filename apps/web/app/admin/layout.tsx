import { requireAuthenticatedShell } from "@/lib/knowledge/auth";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAuthenticatedShell({ requireAdmin: true });
  return children;
}
