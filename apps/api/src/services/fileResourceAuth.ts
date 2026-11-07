// Per-record file trust (PRD §13.3 check 4) — the gap files.ts's header
// has flagged since Session 29 and Session 30 proved live: a same-org
// teammate with no flat `files` grant gets 403 reading a colleague's EOD
// proof attachment even though they can already read the EOD entry
// itself, because files.ts only ever checked the flat `files.read` /
// `files.create` grant and never asked "can this caller access the
// specific record this file is attached to?"
//
// rbac.ts's own header already named this shape: check 4 is "inherently
// record-specific — it needs the actual row... Routes that need it call
// a per-resource trust check themselves, inside the handler." files.ts
// is polymorphic (resource_type/resource_id can point at any table), so
// "the actual row" means dispatching to whatever service already knows
// how to authorize that resource type — not re-implementing eod.ts's
// own/team logic a second time here.
//
// Registry, not a switch inside files.ts: each attachable resource type
// registers how to answer "can this user read/write attachments on this
// specific record", and files.ts just asks the registry. A resource type
// with no entry falls back to the flat `files.*` grant only — the exact
// behavior every resourceType had before this file existed, so adding a
// new attachable resource without an entry here is a silent no-op, not a
// silent security hole.
import { hasPermission } from '../plugins/rbac.js';
import { getEodLogById } from './eodService.js';
import type { SessionUser } from './sessionService.js';

export type FileAccessMode = 'read' | 'write';

export interface FileResourceAuthorizer {
  /** Resolve whether `user` may read (view/download) or write (upload/
   * archive) a file attached to `resourceId` of this resource type.
   * Returns false — never throws — on a missing/foreign record, so
   * callers can treat "not authorized" and "doesn't exist" the same way
   * files.ts already does for its flat-grant 404s. */
  check(user: SessionUser, resourceId: string, mode: FileAccessMode): Promise<boolean>;
}

// eod_logs: mirrors routes/eod.ts's own logic exactly rather than
// re-deriving it — read allowed if you own the entry (it's filed for
// you) or hold the flat `eod.read` grant (the "view the team's EODs"
// case); write (attach/replace/archive a proof file) allowed if you own
// the entry or hold `eod.create` (the "filing for someone else"
// supervisor case eod.ts's own POST / branch uses).
const eodLogsAuthorizer: FileResourceAuthorizer = {
  async check(user, resourceId, mode) {
    const log = await getEodLogById(user.orgId, resourceId);
    if (!log) return false;
    if (log.userId === user.userId) return true; // own record — no grant needed, same as eod.ts's own-filing exception
    return hasPermission(user, 'eod', mode === 'read' ? 'read' : 'create');
  },
};

// company_archive (0023, ADMIN_BUILD_GUIDE.md Session 8): not really
// "per-record" the way eod_logs is — resourceId here is the org's own
// id, since a company doc belongs to the org as a whole rather than to
// one task/EOD row (see fileService.ts's requestFileUpload comment). The
// resourceId === user.orgId check below is a defense-in-depth guard, not
// the actual isolation boundary — RLS already scopes every `files` query
// to the caller's org, so this can only ever be asked about a resourceId
// equal to the caller's own org anyway.
//
// read: true for any org member — this is the entire point of the
// feature (a flat readable doc list for the whole company), so this
// authorizer exists specifically to grant read access nobody's flat
// `files.read` grant would otherwise cover.
// write: always false here — NOT because writing is disallowed, but
// because it's leader-only, and hasPermission's own leader-bypass
// (authorizationService.ts) already returns true on the flat-grant check
// in routes/files.ts *before* this per-record fallback ever runs. A
// non-leader with no flat `files.create` grant should be denied, which
// is exactly what returning false here does.
const companyArchiveAuthorizer: FileResourceAuthorizer = {
  async check(user, resourceId, mode) {
    if (resourceId !== user.orgId) return false;
    return mode === 'read';
  },
};

const registry: Record<string, FileResourceAuthorizer> = {
  eod_logs: eodLogsAuthorizer,
  company_archive: companyArchiveAuthorizer,
};

/** True if this resourceType has a per-record authorizer at all — lets
 * files.ts skip straight to the flat-grant-only path (its pre-Session-31
 * behavior) for resource types nothing here knows how to reason about
 * yet, instead of silently denying everyone. */
export function hasFileResourceAuthorizer(resourceType: string): boolean {
  return resourceType in registry;
}

export async function checkFileResourceAccess(
  user: SessionUser,
  resourceType: string,
  resourceId: string,
  mode: FileAccessMode
): Promise<boolean> {
  const authorizer = registry[resourceType];
  if (!authorizer) return false;
  return authorizer.check(user, resourceId, mode);
}
