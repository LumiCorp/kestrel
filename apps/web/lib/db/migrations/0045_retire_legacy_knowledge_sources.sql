DELETE FROM "knowledge_kv"
WHERE "key" IN (
  'snapshot:current',
  'snapshot:status-cache',
  'snapshot:repo-config',
  'sources:last-sync',
  'sandbox:active-session'
);

DELETE FROM "tool_providers" WHERE "key" = 'built_in.sandbox';

DROP TABLE IF EXISTS "knowledge_sync_runs";
DROP TABLE IF EXISTS "knowledge_snapshots";
DROP TABLE IF EXISTS "sources";
