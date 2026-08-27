import { createOneReceivingDomainsPostHandler } from "@/lib/email/receiving-admin-route-handlers";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export const POST = createOneReceivingDomainsPostHandler({
  requireAdmin: requireOrganizationAdmin,
});
