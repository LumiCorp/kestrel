import { asc, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import {
  requireActiveOrganization,
  requireAdminOrganization,
} from "@/lib/knowledge/auth";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { errorResponse } from "@/lib/knowledge/http";
import { KV_KEYS, kvGet } from "@/lib/knowledge/kv";
import {
  createKnowledgeSource,
  createSourceSchema,
} from "@/lib/knowledge/mutations";
import { getSnapshotRepoConfig } from "@/lib/knowledge/snapshot-config";

export async function GET() {
  try {
    const { organizationId } = await requireActiveOrganization();

    const [allSources, lastSyncAt, snapshotConfig] = await Promise.all([
      knowledgeDb
        .select()
        .from(schema.sources)
        .where(eq(schema.sources.organizationId, organizationId))
        .orderBy(asc(schema.sources.label)),
      kvGet<number>(KV_KEYS.LAST_SOURCE_SYNC, organizationId),
      getSnapshotRepoConfig(organizationId),
    ]);

    const github = allSources.filter((source) => source.type === "github");
    const youtube = allSources.filter((source) => source.type === "youtube");
    const snapshotRepo = snapshotConfig.snapshotRepo || null;
    const snapshotBranch = snapshotConfig.snapshotBranch || "main";

    return NextResponse.json({
      total: github.length + youtube.length,
      lastSyncAt,
      youtubeEnabled: true,
      snapshotRepo,
      snapshotBranch,
      snapshotRepoUrl: snapshotRepo
        ? `https://github.com/${snapshotRepo}`
        : null,
      github: {
        count: github.length,
        sources: github,
      },
      youtube: {
        count: youtube.length,
        sources: youtube,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { organizationId, session } = await requireAdminOrganization();
    const body = createSourceSchema.parse(await request.json());

    const source = await createKnowledgeSource({
      actorUserId: session.user.id,
      body,
      organizationId,
    });

    return NextResponse.json(source, { status: 201 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
