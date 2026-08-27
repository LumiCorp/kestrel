LOCK TABLE "member" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
WITH "disabled" AS (
	UPDATE "project_email_triggers" AS "triggers"
	SET
		"enabled" = false,
		"disabled_reason" = 'execution_owner_access_lost',
		"revision" = "triggers"."revision" + 1,
		"updated_at" = now()
	WHERE
		"triggers"."enabled" = true
		AND "triggers"."deleted_at" IS NULL
		AND NOT EXISTS (
			SELECT 1
			FROM "member"
			WHERE
				"member"."organizationId" = "triggers"."organization_id"
				AND "member"."userId" = "triggers"."execution_owner_user_id"
		)
	RETURNING "triggers"."id", "triggers"."project_id", "triggers"."revision"
)
INSERT INTO "project_audit_events" (
	"id",
	"project_id",
	"actor_user_id",
	"action",
	"target_type",
	"target_id",
	"metadata",
	"created_at"
)
SELECT
	gen_random_uuid()::text,
	"project_id",
	NULL,
	'project.email_trigger.disabled',
	'project_email_trigger',
	"id",
	jsonb_build_object(
		'reason', 'execution_owner_access_lost',
		'revision', "revision"
	),
	now()
FROM "disabled";
--> statement-breakpoint
CREATE FUNCTION "disable_project_email_triggers_on_member_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	WITH "disabled" AS (
		UPDATE "project_email_triggers"
		SET
			"enabled" = false,
			"disabled_reason" = 'execution_owner_access_lost',
			"revision" = "revision" + 1,
			"updated_at" = now()
		WHERE
			"organization_id" = OLD."organizationId"
			AND "execution_owner_user_id" = OLD."userId"
			AND "enabled" = true
			AND "deleted_at" IS NULL
		RETURNING "id", "project_id", "revision"
	)
	INSERT INTO "project_audit_events" (
		"id",
		"project_id",
		"actor_user_id",
		"action",
		"target_type",
		"target_id",
		"metadata",
		"created_at"
	)
	SELECT
		gen_random_uuid()::text,
		"project_id",
		NULL,
		'project.email_trigger.disabled',
		'project_email_trigger',
		"id",
		jsonb_build_object(
			'reason', 'execution_owner_access_lost',
			'revision', "revision"
		),
		now()
	FROM "disabled";
	RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "member_delete_disable_project_email_triggers"
BEFORE DELETE ON "member"
FOR EACH ROW
EXECUTE FUNCTION "disable_project_email_triggers_on_member_delete"();
