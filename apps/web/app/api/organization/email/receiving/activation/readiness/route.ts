import { createOneReceivingReadinessPostHandler } from "@/lib/email/receiving-admin-route-handlers";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export const POST = createOneReceivingReadinessPostHandler({
  requireAdmin: requireOrganizationAdmin,
});
