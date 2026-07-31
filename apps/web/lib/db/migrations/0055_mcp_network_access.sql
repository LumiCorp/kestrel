ALTER TABLE "mcp_servers"
  ADD COLUMN "network_access" text DEFAULT 'full' NOT NULL;
--> statement-breakpoint
ALTER TABLE "mcp_servers"
  ADD CONSTRAINT "mcp_servers_network_access_check"
  CHECK ("network_access" IN ('full', 'none'));
--> statement-breakpoint
ALTER TABLE "mcp_servers"
  ADD CONSTRAINT "mcp_servers_remote_network_access_check"
  CHECK ("source_type" <> 'remote' OR "network_access" = 'full');
