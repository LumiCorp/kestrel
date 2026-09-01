CREATE UNIQUE INDEX "email_delivery_receipts_organization_id_idx" ON "email_delivery_receipts" USING btree ("organization_id", "id");
--> statement-breakpoint
CREATE TABLE "email_delivery_attachments" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "receipt_id" text NOT NULL,
  "provider_attachment_id" text NOT NULL,
  "provider_order" integer NOT NULL,
  "filename" text,
  "declared_media_type" text,
  "provider_size_bytes" bigint NOT NULL,
  "disposition" text,
  "content_id" text,
  "import_state" text DEFAULT 'available' NOT NULL,
  "failure_code" text,
  "file_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "email_delivery_attachments_provider_order_check" CHECK ("provider_order" >= 0),
  CONSTRAINT "email_delivery_attachments_provider_size_check" CHECK ("provider_size_bytes" >= 0),
  CONSTRAINT "email_delivery_attachments_import_state_check" CHECK ("import_state" IN ('available', 'importing', 'ready', 'failed')),
  CONSTRAINT "email_delivery_attachments_failure_check" CHECK (("import_state" = 'failed') = ("failure_code" IS NOT NULL)),
  CONSTRAINT "email_delivery_attachments_ready_file_check" CHECK (("import_state" = 'ready') = ("file_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "email_delivery_attachments" ADD CONSTRAINT "email_delivery_attachments_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "email_delivery_attachments" ADD CONSTRAINT "email_delivery_attachments_organization_receipt_fk" FOREIGN KEY ("organization_id", "receipt_id") REFERENCES "public"."email_delivery_receipts"("organization_id", "id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "email_delivery_attachments" ADD CONSTRAINT "email_delivery_attachments_file_id_kestrel_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."kestrel_files"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "email_delivery_attachments_receipt_provider_idx" ON "email_delivery_attachments" USING btree ("receipt_id", "provider_attachment_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "email_delivery_attachments_receipt_order_idx" ON "email_delivery_attachments" USING btree ("receipt_id", "provider_order");
--> statement-breakpoint
CREATE UNIQUE INDEX "email_delivery_attachments_file_idx" ON "email_delivery_attachments" USING btree ("file_id") WHERE "file_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "email_delivery_attachments_receipt_idx" ON "email_delivery_attachments" USING btree ("receipt_id");
--> statement-breakpoint
CREATE INDEX "email_delivery_attachments_import_state_idx" ON "email_delivery_attachments" USING btree ("import_state", "updated_at");
