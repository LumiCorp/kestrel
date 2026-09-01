CREATE TABLE "project_workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"created_by_user_id" text,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"model_id" text NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"cron_expression" text,
	"time_zone" text,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_workflow_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_workflow_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"workflow_version_id" text NOT NULL,
	"actor_user_id" text,
	"trigger" text NOT NULL,
	"request_id" text,
	"scheduled_for" timestamp with time zone,
	"environment_id_snapshot" text NOT NULL,
	"project_context_revision_id_snapshot" text NOT NULL,
	"model_id_snapshot" text NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"failure_code" text,
	"failure_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_workflow_runs_trigger_check" CHECK ("trigger" IN ('manual', 'scheduled')),
	CONSTRAINT "project_workflow_runs_status_check" CHECK ("status" IN ('queued', 'running', 'waiting_for_input', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "project_workflow_step_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_run_id" text NOT NULL,
	"node_id" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"thread_id" text,
	"turn_id" text,
	"failure_code" text,
	"failure_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_workflow_step_runs_status_check" CHECK ("status" IN ('pending', 'running', 'waiting_for_input', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "project_workflows" ADD CONSTRAINT "project_workflows_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_workflows" ADD CONSTRAINT "project_workflows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_workflows" ADD CONSTRAINT "project_workflows_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_workflows" ADD CONSTRAINT "project_workflows_organization_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_workflow_versions" ADD CONSTRAINT "project_workflow_versions_workflow_id_project_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."project_workflows"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_workflow_versions" ADD CONSTRAINT "project_workflow_versions_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_workflow_runs" ADD CONSTRAINT "project_workflow_runs_workflow_id_project_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."project_workflows"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_workflow_runs" ADD CONSTRAINT "project_workflow_runs_workflow_version_id_project_workflow_versions_id_fk" FOREIGN KEY ("workflow_version_id") REFERENCES "public"."project_workflow_versions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_workflow_runs" ADD CONSTRAINT "project_workflow_runs_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_workflow_step_runs" ADD CONSTRAINT "project_workflow_step_runs_workflow_run_id_project_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."project_workflow_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_workflow_step_runs" ADD CONSTRAINT "project_workflow_step_runs_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_workflow_step_runs" ADD CONSTRAINT "project_workflow_step_runs_turn_id_thread_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."thread_turns"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "project_workflows_project_idx" ON "project_workflows" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX "project_workflows_creator_idx" ON "project_workflows" USING btree ("created_by_user_id");
--> statement-breakpoint
CREATE INDEX "project_workflows_due_idx" ON "project_workflows" USING btree ("enabled","next_run_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "project_workflow_versions_workflow_version_idx" ON "project_workflow_versions" USING btree ("workflow_id","version");
--> statement-breakpoint
CREATE UNIQUE INDEX "project_workflow_runs_request_idx" ON "project_workflow_runs" USING btree ("workflow_id","request_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "project_workflow_runs_occurrence_idx" ON "project_workflow_runs" USING btree ("workflow_id","scheduled_for");
--> statement-breakpoint
CREATE INDEX "project_workflow_runs_status_idx" ON "project_workflow_runs" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "project_workflow_runs_created_idx" ON "project_workflow_runs" USING btree ("workflow_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "project_workflow_step_runs_node_attempt_idx" ON "project_workflow_step_runs" USING btree ("workflow_run_id","node_id","attempt");
--> statement-breakpoint
CREATE INDEX "project_workflow_step_runs_run_status_idx" ON "project_workflow_step_runs" USING btree ("workflow_run_id","status");
--> statement-breakpoint
CREATE INDEX "project_workflow_step_runs_turn_idx" ON "project_workflow_step_runs" USING btree ("turn_id");
