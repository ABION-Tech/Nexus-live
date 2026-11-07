# modules/admin/

Group Admin + Company Admin + Super Admin dashboards
(ADMIN_BUILD_GUIDE.md §3 "Session 6" and "Session 5"). Scaffolded empty
in Session 37; Group/Company Admin filled in Session 42; Super Admin
filled in Session 43.

- Group Admin: Overview, Companies, People, Operations, Goals,
  Analytics, Activity — routed under `/admin`, visible when
  `CurrentUser.isGroupAdmin` is true (GET /session, backed by
  `authorizationService.isGroupAdmin`).
- Company Admin: Overview, Analytics, Automation, Activity, Settings —
  same `/admin` path prefix, mutually exclusive with Group Admin
  (`CurrentUser.isCompanyAdmin`). People/Work/Goals/Knowledge are
  deliberately NOT duplicated here — a Company Admin is just a
  `leader`, so those stay on their existing top-level sidebar sections;
  Settings is a set of links into the real Settings modules.
- Super Admin: Overview, Organizations (Groups + Companies in one CRUD
  surface — same shape either `orgType`, filtered client-side rather
  than split into two tabs), Users (platform-wide investigation search),
  Audit & Security. Routed under its own `/admin/platform` prefix (not
  shared with Group/Company Admin's `/admin` — `platform_admins` is a
  separate, non-org-scoped table, so a platform admin isn't guaranteed
  mutually exclusive with a group/company leadership membership the way
  Group vs. Company Admin are). Visible when `CurrentUser.isPlatformAdmin`
  is true. "Operations" and "AI & Costs" tabs named in the guide's own
  Session 5 outline are deliberately not built this pass — no backend
  route exposes platform-wide `ai_usage` aggregation yet (aiUsageService.ts's
  own header comment already flags this as later work), and there's no
  "Operations" concept at the platform tier distinct from what
  Organizations/Audit already cover. Real gap, not silently dropped —
  see SESSION_LOG's Session 43 entry.
- The guest-invite surface lives in `modules/settings/GuestInvites.tsx`,
  not here — it's a Settings subsection (`/settings/guests`), matching
  guestService.ts's own header comment ("a page in Settings").
