ALTER TABLE "app_operation_approvals"
  ADD COLUMN "lifecycle_version" text DEFAULT 'legacy_v1' NOT NULL;
--> statement-breakpoint
ALTER TABLE "app_operation_approvals"
  ADD COLUMN "interaction_id" text;
--> statement-breakpoint
ALTER TABLE "app_operation_approvals"
  ADD COLUMN "availability_status" text;
--> statement-breakpoint
ALTER TABLE "app_operation_approvals"
  ALTER COLUMN "status" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "app_operation_approvals"
  ADD CONSTRAINT "app_operation_approvals_interaction_fk"
  FOREIGN KEY ("interaction_id") REFERENCES "thread_interactions"("id")
  ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX "app_operation_approvals_availability_expiry_idx"
  ON "app_operation_approvals" ("lifecycle_version", "availability_status", "expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "app_operation_approvals_interaction_idx"
  ON "app_operation_approvals" ("interaction_id")
  WHERE "interaction_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "app_operation_approvals"
  DROP CONSTRAINT "app_operation_approvals_lifecycle_check";
--> statement-breakpoint
ALTER TABLE "app_operation_approvals"
  ADD CONSTRAINT "app_operation_approvals_lifecycle_version_check"
  CHECK ("lifecycle_version" IN ('legacy_v1', 'interaction_v2'));
--> statement-breakpoint
ALTER TABLE "app_operation_approvals"
  ADD CONSTRAINT "app_operation_approvals_availability_status_check"
  CHECK (
    "availability_status" IS NULL
    OR "availability_status" IN ('available', 'consumed', 'expired')
  );
--> statement-breakpoint
ALTER TABLE "app_operation_approvals"
  ADD CONSTRAINT "app_operation_approvals_ownership_check"
  CHECK (
    (
      "lifecycle_version" = 'legacy_v1'
      AND "status" IS NOT NULL
      AND "interaction_id" IS NULL
      AND "availability_status" IS NULL
    )
    OR
    (
      "lifecycle_version" = 'interaction_v2'
      AND "status" IS NULL
      AND "decided_by_user_id" IS NULL
      AND "decided_at" IS NULL
      AND "availability_status" IS NOT NULL
    )
  );
--> statement-breakpoint
ALTER TABLE "app_operation_approvals"
  ADD CONSTRAINT "app_operation_approvals_lifecycle_check"
  CHECK (
    (
      "lifecycle_version" = 'legacy_v1'
      AND (
        (
          "status" = 'pending'
          AND "decided_by_user_id" IS NULL
          AND "decided_at" IS NULL
          AND "consumed_execution_id" IS NULL
          AND "consumed_at" IS NULL
        )
        OR
        (
          "status" IN ('approved', 'denied')
          AND "decided_by_user_id" IS NOT NULL
          AND "decided_at" IS NOT NULL
          AND "consumed_execution_id" IS NULL
          AND "consumed_at" IS NULL
        )
        OR
        (
          "status" = 'consumed'
          AND "decided_by_user_id" IS NOT NULL
          AND "decided_at" IS NOT NULL
          AND "consumed_execution_id" IS NOT NULL
          AND "consumed_at" IS NOT NULL
        )
        OR
        (
          "status" = 'expired'
          AND "consumed_execution_id" IS NULL
          AND "consumed_at" IS NULL
        )
      )
    )
    OR
    (
      "lifecycle_version" = 'interaction_v2'
      AND (
        (
          "availability_status" = 'available'
          AND "consumed_execution_id" IS NULL
          AND "consumed_at" IS NULL
        )
        OR
        (
          "availability_status" = 'consumed'
          AND "interaction_id" IS NOT NULL
          AND "consumed_execution_id" IS NOT NULL
          AND "consumed_at" IS NOT NULL
        )
        OR
        (
          "availability_status" = 'expired'
          AND "consumed_execution_id" IS NULL
          AND "consumed_at" IS NULL
        )
      )
    )
  );
--> statement-breakpoint
ALTER TABLE "thread_interactions"
  DROP CONSTRAINT "thread_interactions_effect_status_check";
--> statement-breakpoint
ALTER TABLE "thread_interactions"
  ADD CONSTRAINT "thread_interactions_effect_status_check"
  CHECK (
    "effect_status" IS NULL
    OR "effect_status" IN ('not_started', 'started', 'committed', 'unknown')
  );
