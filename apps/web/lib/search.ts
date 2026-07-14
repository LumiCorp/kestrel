import { sql } from "drizzle-orm";
import { knowledgeDb } from "@/lib/knowledge/db";

export async function searchWorkspace(input: {
  organizationId: string;
  userId: string;
  query: string;
  limit?: number;
  projectId?: string;
}) {
  const query = input.query.trim();
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 20);
  const projectId = input.projectId ?? null;
  if (!query) {
    return { projects: [], threads: [], messages: [] };
  }

  const [projects, threads, messages] = await Promise.all([
    knowledgeDb.execute(sql`
      select
        p.id,
        p.name,
        p.description,
        p.updated_at as "updatedAt",
        pm.role,
        ts_rank_cd(
          to_tsvector('simple', coalesce(p.name, '') || ' ' || coalesce(p.description, '')),
          websearch_to_tsquery('simple', ${query})
        )::float as rank
      from projects p
      inner join project_members pm on pm.project_id = p.id
      inner join "member" om on om.id = pm.organization_member_id
      where
        p.organization_id = ${input.organizationId}
        and om."organizationId" = ${input.organizationId}
        and om."userId" = ${input.userId}
        and p.archived_at is null
        and (${projectId}::text is null or p.id = ${projectId})
        and to_tsvector('simple', coalesce(p.name, '') || ' ' || coalesce(p.description, ''))
          @@ websearch_to_tsquery('simple', ${query})
      order by rank desc, p.updated_at desc, p.id asc
      limit ${limit}
    `),
    knowledgeDb.execute(sql`
      select
        t.id,
        t.title,
        t.project_id as "projectId",
        t.updated_at as "updatedAt",
        ts_rank_cd(
          to_tsvector('simple', coalesce(t.title, '')),
          websearch_to_tsquery('simple', ${query})
        )::float as rank
      from threads t
      where
        t.organization_id = ${input.organizationId}
        and t.archived_at is null
        and (${projectId}::text is null or t.project_id = ${projectId})
        and (
          (t.project_id is null and t.created_by_user_id = ${input.userId})
          or exists (
            select 1
            from project_members pm
            inner join "member" om on om.id = pm.organization_member_id
            inner join projects p on p.id = pm.project_id
            where
              pm.project_id = t.project_id
              and om."organizationId" = ${input.organizationId}
              and om."userId" = ${input.userId}
              and p.archived_at is null
          )
        )
        and to_tsvector('simple', coalesce(t.title, ''))
          @@ websearch_to_tsquery('simple', ${query})
      order by rank desc, t.updated_at desc, t.id asc
      limit ${limit}
    `),
    knowledgeDb.execute(sql`
      select
        m.id,
        m.thread_id as "threadId",
        t.title as "threadTitle",
        t.project_id as "projectId",
        m.search_text as "searchText",
        m.created_at as "createdAt",
        ts_rank_cd(
          to_tsvector('simple', coalesce(m.search_text, '')),
          websearch_to_tsquery('simple', ${query})
        )::float as rank
      from thread_messages m
      inner join threads t on t.id = m.thread_id
      where
        t.organization_id = ${input.organizationId}
        and t.archived_at is null
        and (${projectId}::text is null or t.project_id = ${projectId})
        and (
          (t.project_id is null and t.created_by_user_id = ${input.userId})
          or exists (
            select 1
            from project_members pm
            inner join "member" om on om.id = pm.organization_member_id
            inner join projects p on p.id = pm.project_id
            where
              pm.project_id = t.project_id
              and om."organizationId" = ${input.organizationId}
              and om."userId" = ${input.userId}
              and p.archived_at is null
          )
        )
        and to_tsvector('simple', coalesce(m.search_text, ''))
          @@ websearch_to_tsquery('simple', ${query})
      order by rank desc, m.created_at desc, m.id asc
      limit ${limit}
    `),
  ]);

  return {
    projects: Array.from(projects),
    threads: Array.from(threads),
    messages: Array.from(messages),
  };
}
