import "server-only";

import { and, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import { ATTACHMENT_TEXT_EXTRACTABLE_MEDIA_TYPES } from "@kestrel-agents/files";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { processStoredFileRepresentation } from "@/lib/files/service";
import {
  parseRepairFileRepresentationArgs,
  repairFileRepresentationCandidates,
} from "./lib/repair-file-representations-contract";

async function main() {
  const options = parseRepairFileRepresentationArgs(process.argv.slice(2));
  const rows = await knowledgeDb
    .select({
      blobId: schema.fileRepresentations.blobId,
      objectKey: schema.fileBlobs.objectKey,
      filename: sql<string>`(array_agg(${schema.kestrelFiles.filename} order by ${schema.kestrelFiles.id}))[1]`,
      mediaType: schema.fileRepresentations.mediaType,
    })
    .from(schema.fileRepresentations)
    .innerJoin(schema.fileBlobs, eq(schema.fileBlobs.id, schema.fileRepresentations.blobId))
    .innerJoin(schema.kestrelFiles, eq(schema.kestrelFiles.blobId, schema.fileBlobs.id))
    .where(and(
      eq(schema.fileRepresentations.status, "failed"),
      eq(schema.fileBlobs.availabilityStatus, "available"),
      isNull(schema.fileBlobs.deletedAt),
      or(
        like(schema.fileRepresentations.mediaType, "text/%"),
        inArray(
          schema.fileRepresentations.mediaType,
          [...ATTACHMENT_TEXT_EXTRACTABLE_MEDIA_TYPES],
        ),
      ),
      options.organizationId
        ? eq(schema.fileBlobs.organizationId, options.organizationId)
        : undefined,
    ))
    .groupBy(
      schema.fileRepresentations.blobId,
      schema.fileBlobs.objectKey,
      schema.fileRepresentations.mediaType,
    )
    .orderBy(schema.fileRepresentations.blobId)
    .limit(options.limit);
  const candidates = rows;
  let result = {
    mode: options.apply ? "apply" : "dry_run",
    scanned: candidates.length,
    repaired: 0,
    stillFailed: 0,
    skipped: 0,
  };
  if (options.apply) {
    const counts = await repairFileRepresentationCandidates({
      candidates,
      initialSkipped: result.skipped,
      repair: processStoredFileRepresentation,
      inspect: async (candidate) => {
        const [blob, representation] = await Promise.all([
          knowledgeDb.query.fileBlobs.findFirst({
            where: (table, operators) => operators.eq(table.id, candidate.blobId),
          }),
          knowledgeDb.query.fileRepresentations.findFirst({
            where: (table, operators) => operators.eq(table.blobId, candidate.blobId),
          }),
        ]);
        if (!blob || blob.deletedAt || blob.availabilityStatus === "missing") return "missing";
        return representation?.status === "ready" ? "ready" : "failed";
      },
    });
    result = { mode: result.mode, ...counts };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Representation repair failed."}\n`);
  process.exitCode = 1;
});
