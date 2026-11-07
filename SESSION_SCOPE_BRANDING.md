# Company-Level Customization — Scoping Doc (branding + terminology)

**Status: scoping only — do not build until §3 is resolved.** Same posture
as `SESSION_47_SCOPE_BILLING.md`: this domain touches RLS and a hierarchy
cascade, and a schema pivot mid-build costs more than a slow scope pass.
Session number intentionally left unassigned — `SESSION_LOG.md` runs
through Session 49 and the code carries an unlogged Session 50 (theme),
so slot this in wherever it actually lands in the queue.

**Confirmed already (locked):**
1. Scope = branding (logo/color) **and** terminology — a company can
   rename a label like "Goals" to its own word.
2. Who sets it = **both**. Group Admin sets a default for every company
   under the group; Company Admin can override it for their own company.

Confirmed by inspection, not assumption:
- Nothing branding/terminology-shaped exists in the schema or UI today.
  The only per-org/per-user customization that exists at all is the
  Session 50 light/dark theme (`user_preferences`, per-user, no org
  concept in it whatsoever).
- IA labels ("Goals", "Work", "Knowledge", etc.) are hardcoded strings in
  `apps/web/src/app/ia.ts` — there is no lookup, no config, nothing that
  currently reads anything to decide what a nav label says. Terminology
  override is a **feature build**, not a config toggle on top of
  something that already exists.

---

## 1. Precedent this borrows from: `org_billing`'s cascade

`org_billing` (0025) already solves "a company either has its own row,
or inherits from its parent group's row, or falls back to a platform
default" — exactly the shape "Group sets a default, Company can
override" needs. Concretely, `resolveEffectiveBilling` (`billingService.ts`):

- reads the org's own row first; if it exists and isn't the no-op
  default, that wins;
- otherwise walks up to `parent_org_id` (once — DECISIONS.md §5, this
  hierarchy is two levels deep by design) and reads the parent's row;
- uses the parent's row only if it opts in via `cascades_to_children`;
- resolves at **read time**, every call — DECISIONS.md §9 explicitly
  rejected writing the group's value down onto every child row, because
  that makes "what's actually in effect" a question with a stale
  possible answer.

Branding should follow the same three rules almost verbatim. The one
real difference: billing resolves a whole row (a tier either applies or
it doesn't); branding more naturally resolves **per field** — a company
might want the group's logo but its own color, or the group's
terminology but nothing else touched. That field-vs-row question is
open — see §3.1.

## 2. Schema sketch (not final — depends on §3)

```sql
create table org_branding (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null unique references organizations(id) on delete cascade,

  logo_url              text,
  primary_color         text,   -- hex; null = inherit/default
  accent_color          text,

  -- IA section/subsection id -> display label, e.g. {"goals": "Objectives"}.
  -- Keyed by ia.ts's existing `id` fields, not free text, so this can
  -- only ever rename something that already has a slot in the IA tree —
  -- not become a general string-replacement engine.
  terminology_overrides jsonb not null default '{}'::jsonb,

  -- Same knob as org_billing.cascades_to_children: does a group's row
  -- here apply to its companies by default. Irrelevant on a company row.
  cascades_to_children  boolean not null default false,

  updated_by_user_id    uuid references users(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

alter table org_branding enable row level security;
alter table org_branding force row level security;

-- Same three-clause shape as org_billing's tenant_isolation (0025):
-- own row, parent's row (read from a company), child's row (read from
-- a group, so a Group Admin can see what each company has overridden).
create policy tenant_isolation on org_branding
  using (
    org_id = app_current_org_id()
    or org_id = (select parent_org_id from organizations where id = app_current_org_id())
    or (select parent_org_id from organizations where id = org_branding.org_id) = app_current_org_id()
  );

grant select, insert, update on org_branding to nexus_app;
```

Absence of a row = "no customization, platform default" — same
"absence means not yet, no sentinel values" convention `org_billing`
and the rest of this schema already follow.

## 3. Open questions — need answers before build

### 3.1 Per-field override, or all-or-nothing per row?
If a company has its own `org_branding` row, does it inherit the
group's values field-by-field for whatever it left blank, or does
having any row of its own mean "ignore the group entirely, even for
untouched fields"? Field-by-field is more useful but means
`resolveEffectiveBranding` returns a *merged* object from up to two
queries, not one row from one query — more like billing's own
"effective" merge, but per-column instead of per-tier.

### 3.2 What's actually brandable?
Logo + one or two colors is a small, safe v1. Confirm before build
whether this should also cover favicon, email-template branding, or a
full theme (multiple named colors) — each of those is a bigger surface
than the schema above assumes.

### 3.3 How far does terminology renaming go?
Two very different sizes of feature hiding behind the same one-line
request:
- **Nav labels only** (IA section/subsection labels in `ia.ts`) — the
  scope the schema above assumes. Bounded: a fixed, known list of
  renameable keys.
- **Every occurrence of the word** ("Goals" also appears in empty
  states, toasts, email copy, AI prompts referencing "goal," etc.) —
  effectively an i18n-style string-lookup pass across the whole
  frontend (and parts of the backend that generate user-facing copy).
  Substantially larger, and not something to half-do — a renamed nav
  label next to un-renamed body copy reads as broken, not customized.

  Recommend confirming **nav-label-only** as the v1 boundary explicitly,
  the same way DECISIONS.md §5 explicitly deferred cross-company
  projects rather than leaving it ambiguous.

### 3.4 Does branding gate on billing tier?
`org_billing`/`hasFeature` already exist as the mechanism for
paid-tier-only features. Worth deciding now whether company-level
customization is free-tier-available or a `starter`/`pro` perk —
cheaper to decide before `brandingService` ships than to retrofit a
`requireFeature` check into every branding route afterward.

### 3.5 Who can write it, and where does it surface?
No new role needed either way — `isCompanyAdmin`/`isGroupAdmin`
(already built, Sessions 40/41) are the natural gates, same "not a new
role" posture the guide already used for Company/Company Admin. Confirm:
- new routes under `admin/companyAdmin.ts` (`PATCH /branding`, own org
  only) and `admin/groupAdmin.ts` (`PATCH /branding`, own org, plus
  `cascades_to_children`) — no cross-org write path needed given the
  RLS shape above already allows a company to read its parent's row.
- effective branding folds into `GET /session` (same "the client
  already calls this on every load" reasoning theme/admin-gate flags
  already use — nav labels and logo are needed before first paint, so a
  second round trip isn't good enough).

### 3.6 Independent companies (no parent group)
An independent company (`parent_org_id is null`) obviously just sets
its own row directly with nothing to inherit from — worth stating
explicitly so it isn't treated as an edge case later, same as
DECISIONS.md §5 already does for independent orgs generally.

---

## Recommendation

Answer 3.1–3.3 first — they change the shape of `org_branding` and of
`resolveEffectiveBranding` enough that starting the migration before
they're settled risks the same costly-pivot outcome the billing scope
doc was written to avoid. 3.4–3.6 are cheap to decide alongside them but
don't change the schema shape.
