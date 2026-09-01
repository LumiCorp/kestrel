ALTER TABLE "organization_receiving_connections"
ADD COLUMN "health_check_sequence" bigint DEFAULT 0 NOT NULL;
