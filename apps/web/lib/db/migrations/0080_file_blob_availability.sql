ALTER TABLE "file_blobs"
  ADD COLUMN "availability_status" text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE "file_blobs"
  ADD COLUMN "availability_checked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "file_blobs"
  ADD CONSTRAINT "file_blobs_availability_check"
  CHECK ("availability_status" IN ('unknown', 'available', 'missing'));
