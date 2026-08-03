ALTER TABLE "app_operation_approvals"
  ADD COLUMN IF NOT EXISTS "external_approval_binding" jsonb,
  ADD COLUMN IF NOT EXISTS "authority_revision" text;

UPDATE "app_operation_approvals"
   SET "status" = 'expired',
       "payload" = CASE
         WHEN "app_key" = 'email' THEN '{"redacted":true}'::jsonb
         ELSE "payload"
       END,
       "updated_at" = now()
 WHERE "status" IN ('pending', 'approved')
   AND (
     "external_approval_binding" IS NULL OR
     "authority_revision" IS NULL OR
     length("authority_revision") = 0
   );

ALTER TABLE "app_operation_approvals"
  DROP CONSTRAINT IF EXISTS "app_operation_approvals_external_binding_check";

ALTER TABLE "app_operation_approvals"
  ADD CONSTRAINT "app_operation_approvals_external_binding_check"
  CHECK (
    "status" NOT IN ('pending', 'approved') OR (
      "external_approval_binding" IS NOT NULL AND
      "authority_revision" IS NOT NULL AND
      length("authority_revision") > 0
    )
  );

CREATE INDEX IF NOT EXISTS "app_operation_approvals_authority_idx"
  ON "app_operation_approvals" (
    "organization_id",
    "thread_id",
    "operation_key",
    "authority_revision",
    "status",
    "expires_at"
  );
