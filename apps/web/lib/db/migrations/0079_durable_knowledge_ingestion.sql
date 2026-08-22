WITH ranked_nonterminal_runs AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "document_id"
			ORDER BY
				CASE WHEN "status" = 'running' THEN 0 ELSE 1 END,
				"updated_at" DESC,
				"created_at" DESC,
				"id" DESC
		) AS "rank"
	FROM "knowledge_ingestion_runs"
	WHERE "status" IN ('queued', 'running')
)
UPDATE "knowledge_ingestion_runs" AS run
SET
	"status" = 'failed',
	"error" = 'Superseded during durable Knowledge ingestion repair.',
	"diagnostics" = (
		CASE
			WHEN jsonb_typeof(run."diagnostics") = 'object' THEN run."diagnostics"
			ELSE '{}'::jsonb
		END
	) || jsonb_build_object(
		'repair', jsonb_build_object(
			'code', 'KNOWLEDGE_INGESTION_RUN_SUPERSEDED',
			'reason', 'A newer or running nonterminal run was retained for this document.'
		)
	),
	"finished_at" = now(),
	"updated_at" = now()
FROM ranked_nonterminal_runs AS ranked
WHERE run."id" = ranked."id"
	AND ranked."rank" > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_ingestion_runs_active_document_idx"
	ON "knowledge_ingestion_runs" USING btree ("document_id")
	WHERE "status" IN ('queued', 'running');
