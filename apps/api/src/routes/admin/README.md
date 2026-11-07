# routes/admin/

`superAdmin.ts` — Session 40 (ADMIN_BUILD_GUIDE.md §3 "Session 4"):
Groups/Companies CRUD, investigation search (organizations/users),
platform analytics overview, system health, audit query, plan-change
(folded into the organizations PATCH endpoint). Registered in
server.ts under `/api/v1/admin/super`.

`groupAdmin.ts` — Session 41 (ADMIN_BUILD_GUIDE.md §3 "Session 6",
Group Admin half): scoped companies list + aggregate analytics for
the caller's own group. Gates on isGroupAdmin() (leader of a
group-type org). Registered under `/api/v1/admin/group`. Session 42
added `GET /activity` (this group's own org-scoped audit log, same
searchAuditLog + mandatory-orgId shape as companyAdmin.ts's own
`/activity`) — the Session 6 dashboard shell names an Activity tab
that had no backing route until this pass.

`companyAdmin.ts` — Session 41 (ADMIN_BUILD_GUIDE.md §3 "Session 6",
Company Admin half): thin read-aggregation shell (overview counts,
analytics overview, automation controls, org-scoped audit activity)
wrapping existing People/Work/Goals/Knowledge/Automation services
with no new write surface or auth primitive. Gates on
isCompanyAdmin() (leader of a company-type org). Registered under
`/api/v1/admin/company`. A fifth route, `GET /people`, shipped with
this pass but was removed in Session 43's finalization: it had no
frontend caller — the Company Admin shell's People tab was never
built, and the overview route above answers `totalPeople` with its
own count query, not this one. modules/people/TeamMembers.tsx already
covers the org roster via plain `GET /people`, per the "mostly reuse"
design this whole file follows.

