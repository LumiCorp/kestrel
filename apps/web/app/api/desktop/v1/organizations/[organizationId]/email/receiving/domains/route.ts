import { createDesktopReceivingDomainsPostHandler } from "@/lib/email/receiving-admin-route-handlers";
import { requireDesktopReceivingAdmin } from "@/lib/email/desktop-receiving-auth";

export const POST = createDesktopReceivingDomainsPostHandler({
  requireAdmin: requireDesktopReceivingAdmin,
});
