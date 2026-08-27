import { createOneReceivingActivationPostHandler } from "@/lib/email/receiving-admin-route-handlers";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export const POST = createOneReceivingActivationPostHandler({
  requireAdmin: requireOrganizationAdmin,
});
