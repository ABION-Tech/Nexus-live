// PRD §8.6 Knowledge Base. Same CRUD shape as networkService.ts's
// network_cos half (no per-record owner — `updatedByUserId` is display
// metadata, not an access-control field). v1 scope per the PRD: "Keep
// simple concatenation for the AI context injection. Add structured
// search/filter." `searchKnowledgeEntries`/`listKnowledgeEntries`'s
// `search` param covers the filter half; `buildKnowledgeContext` below
// covers the concatenation half AIService will call once it exists —
// kept in this file rather than aiService.ts because it's a plain read
// over this table, not an AI-provider concern.
import { withOrgContext } from '../db.js';
import { diffColumns, logActivity, logActivityCreated } from './activityLogService.js';
import type { KnowledgeEntry, KnowledgeEntryInput, KnowledgeListQuery } from '@nexus/shared';

interface KnowledgeEntryRow {
  id: string;
  org_id: string;
  title: string;
  content: string;
  category: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

function toKnowledgeEntry(row: KnowledgeEntryRow): KnowledgeEntry {
  return {
    id: row.id,
    orgId: row.org_id,
    title: row.title,
    content: row.content,
    category: row.category ?? undefined,
    updatedByUserId: row.updated_by_user_id ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at?.toISOString(),
  };
}

export async function listKnowledgeEntries(orgId: string, query: KnowledgeListQuery): Promise<KnowledgeEntry[]> {
  return withOrgContext(orgId, async (client) => {
    const params: unknown[] = [orgId];
    const clauses = ['org_id = $1'];
    if (!query.includeArchived) clauses.push('archived_at is null');
    if (query.category) {
      params.push(query.category);
      clauses.push(`category = $${params.length}`);
    }
    if (query.search) {
      // ILIKE over title+content — "simple concatenation, not ranked
      // retrieval" per PRD §8.6/O1; a vector store is explicitly a v2
      // item (§8.6 "v2 consideration"), so this is deliberately not more
      // sophisticated than substring matching.
      params.push(`%${query.search}%`);
      clauses.push(`(title ilike $${params.length} or content ilike $${params.length})`);
    }
    const { rows } = await client.query<KnowledgeEntryRow>(
      `select * from knowledge_entries where ${clauses.join(' and ')} order by title`,
      params
    );
    return rows.map(toKnowledgeEntry);
  });
}

export async function getKnowledgeEntryById(orgId: string, id: string): Promise<KnowledgeEntry | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<KnowledgeEntryRow>(
      `select * from knowledge_entries where org_id = $1 and id = $2`,
      [orgId, id]
    );
    return rows[0] ? toKnowledgeEntry(rows[0]) : null;
  });
}

export async function createKnowledgeEntry(
  orgId: string,
  input: KnowledgeEntryInput,
  createdByUserId: string
): Promise<KnowledgeEntry> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<KnowledgeEntryRow>(
      `insert into knowledge_entries (org_id, title, content, category, updated_by_user_id)
       values ($1, $2, $3, $4, $5)
       returning *`,
      [orgId, input.title, input.content, input.category ?? null, createdByUserId]
    );
    const entry = toKnowledgeEntry(rows[0]!);
    await logActivityCreated(client, { orgId, actorUserId: createdByUserId, resourceType: 'knowledge_entries', resourceId: entry.id });
    return entry;
  });
}

const KNOWLEDGE_ENTRY_COLUMNS = ['title', 'content', 'category'];

export async function updateKnowledgeEntry(
  orgId: string,
  id: string,
  input: Partial<KnowledgeEntryInput>,
  updatedByUserId: string
): Promise<KnowledgeEntry | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows: beforeRows } = await client.query<KnowledgeEntryRow>(
      `select * from knowledge_entries where org_id = $1 and id = $2 and archived_at is null`,
      [orgId, id]
    );
    const before = beforeRows[0];
    if (!before) return null;

    const { rows } = await client.query<KnowledgeEntryRow>(
      `update knowledge_entries set
         title = coalesce($3, title),
         content = coalesce($4, content),
         category = coalesce($5, category),
         updated_by_user_id = $6,
         updated_at = now()
       where org_id = $1 and id = $2 and archived_at is null
       returning *`,
      [orgId, id, input.title, input.content, input.category, updatedByUserId]
    );
    const after = rows[0];
    if (!after) return null;

    // updated_by_user_id itself isn't diffed — it's set unconditionally
    // on every call (display metadata, not a field the caller chooses to
    // change), same reasoning knowledgeService.ts's header comment gives
    // for why it isn't an access-control field either.
    const changes = diffColumns(before, after, KNOWLEDGE_ENTRY_COLUMNS);
    if (changes.length > 0) {
      await logActivity(client, { orgId, actorUserId: updatedByUserId, resourceType: 'knowledge_entries', resourceId: id, changes });
    }
    return toKnowledgeEntry(after);
  });
}

export async function archiveKnowledgeEntry(orgId: string, id: string, actorUserId: string | null = null): Promise<KnowledgeEntry | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows: beforeRows } = await client.query<KnowledgeEntryRow>(
      `select * from knowledge_entries where org_id = $1 and id = $2 and archived_at is null`,
      [orgId, id]
    );
    const before = beforeRows[0];
    if (!before) return null;

    const { rows } = await client.query<KnowledgeEntryRow>(
      `update knowledge_entries set archived_at = now(), updated_at = now()
       where org_id = $1 and id = $2 and archived_at is null
       returning *`,
      [orgId, id]
    );
    const after = rows[0];
    if (!after) return null;

    const changes = diffColumns(before, after, ['archived_at']);
    if (changes.length > 0) {
      await logActivity(client, { orgId, actorUserId, resourceType: 'knowledge_entries', resourceId: id, changes });
    }
    return toKnowledgeEntry(after);
  });
}

// PRD §8.6: "buildKnowledgeContext_ injects the full knowledge base into
// every AI prompt — confirmed as simple concatenation, not ranked
// retrieval." §8.6's v2 flag: "If the knowledge base grows beyond ~50
// dense entries, concatenating everything will hit token limits" — that
// threshold check belongs to whatever calls this (aiService.ts, once it
// exists), not here; this just does the concatenation itself, ordered
// so entries with the same content produce a stable prompt across calls.
export async function buildKnowledgeContext(orgId: string): Promise<string> {
  const entries = await listKnowledgeEntries(orgId, {});
  return entries
    .map((e) => `# ${e.title}${e.category ? ` (${e.category})` : ''}\n${e.content}`)
    .join('\n\n');
}
