# SESSION SCOPE — UI Rehaul (full visual redesign)

Source: `SESSION_LOG.md`'s own "Backlog — added 2026-08-30" entry —
flagged, not sized. This doc sizes it, per the same scope-before-build
sequence billing (`SESSION_46_SCOPE_BILLING.md`) and branding
(`SESSION_SCOPE_BRANDING.md`) already went through. Direction confirmed
so far: **full visual redesign, new look/feel, design system from
scratch** — not a polish pass on the existing Tier 1 system.

---

## 1. What actually exists today (so "from scratch" is a real decision, not a guess)

This isn't a generic/default look that drifted there by accident —
worth being explicit about, since a from-scratch redesign means
deliberately walking away from work that's already been iterated on
twice:

- **`tokens.css`** is sourced from the original MVP's own `index.html`
  — a dark "ops-console" palette (`--bg: #080810`), `Syne` for display
  type, `Space Mono` for small/mono labels, 5–6px button radius, 8–10px
  card radius. Its own header comment records that **Session 11
  deliberately re-pulled these exact numbers from the MVP** after the
  system had "drifted into a generic SaaS admin look" — i.e., this identity
  was chosen and defended once already.
- **Light mode** (`[data-theme='light']`) was added at Session 50 as a
  second surface/text/border set layered on the *same* brand tokens
  (`--accent`, fonts) — brand color and type were explicitly kept
  identical across themes on the theory that "a company's logo doesn't
  recolor itself for a light UI."
- **23 Tier 1 components** (`Button`, `Card`, `Badge`, `Table`,
  `DataGrid`, `Drawer`, `Modal`, `Tabs`, etc.) in `components/ui/`, each
  a thin wrapper emitting `nx-*` class names, styled centrally in
  `components.css`/`patterns.css`. Every module built from Session 38
  onward (admin, org, guest, projects, network, people, chat, tasks…) —
  **13 modules total**, ~880 lines of CSS outside the components
  themselves — was built by matching this existing vocabulary, not
  extending a design system that was still being decided.
- **A per-company branding feature is already scoped** (`NEXT_STEPS.md`
  A1, locked and "ready to build," not yet implemented): Group default →
  Company override, logo + primary color only, folded into `GET /session`.
  It assumes there's a stable `--accent`-shaped hook to override. A
  from-scratch token system needs to either preserve that hook or this
  doc needs to say explicitly that branding's shape changes too.

None of that is a reason not to redo it — it's the reason this needs a
decision, not just a "go," since a from-scratch pass is choosing to
retire a look that was twice reaffirmed, not filling in a gap nobody
had opinions on yet.

## 2. Decisions needed before build

1. **Who is this for? — ANSWERED: demo/sellable-product framing.**
   NEXUS needs to read as a considered product other orgs would pay for
   and see in a demo, not just ABION's own internal working tool. This
   is the single biggest lever on palette/type/density, and it changes
   the strawman in §4 below — see the revised version.
2. **Keep the "ops-console" identity, or actually replace it?** "From
   scratch" was your answer to whether to touch it — but this is a step
   further: same *concept* (dark, mono-labeled, console-like) executed
   better, or a genuinely different concept (different palette family,
   different type pairing, different information density)?
3. **Dark-first or both-equal?** Today dark is `:root` and light is the
   override. Keep that hierarchy, or design both as first-class from day
   one (changes how tokens get named/structured)?
4. **Component API stability.** Do `Button`/`Card`/`Badge`/etc. keep
   their current props (`variant`, `size`, …) and just get restyled
   under the hood, or is this also a chance to redesign the component
   contracts themselves? The former means every existing call site
   (hundreds, across 13 modules) needs zero code changes. The latter
   means every call site is a touch point.
5. **Branding feature sequencing — RESOLVED: neither has to block the
   other, once the token architecture separates two things that the
   strawman in §4 originally conflated.** See §4a below — this also
   caught a real bug in the original strawman (status "done" and the
   brand accent were the same color, which would mean a company setting
   a red brand color turns their own "done" pills red).
6. **Rollout shape.** Big-bang (new system ships complete, cut over all
   13 modules at once) vs incremental (new tokens + a handful of
   flagship screens first, rest migrate module-by-module, both systems
   coexist for a while)? Given the surface area, big-bang is a large,
   high-risk single session; incremental needs a "which modules first"
   call.
7. **Motion.** No motion tokens exist today beyond a reduced-motion
   media query. In scope for this pass, or a separate follow-on?

## 3. Proposed sizing

Not a small session regardless of the remaining answers — realistically:
one session for tokens + Tier 1 components + a design plan review, then
1–2 more to migrate modules in batches, depending on the rollout-shape
answer in §2.6.

**Status: scoping only for now — build deliberately deferred.** Nothing
below should be treated as a build kickoff; it's here so the next time
this comes up, the thinking doesn't start from zero. §2.1 and §2.5 are
resolved (above); §2.2–2.4, §2.6–2.7 are still open and should get a
real pass before any code gets written, same as this doc's own §1
exists so "from scratch" wasn't a guess.

---

## 4. Strawman design plan (reactable, not locked)

Revised for the answered §2.1: this needs to read as a **considered,
sellable product** — something that holds up in a demo to an outside
org, not just a tool that works for ABION internally. That shifts the
brief from "instrument panel" toward "confident, well-made SaaS,"
without sliding into the generic templated defaults the frontend-design
skill flags (warm-cream-and-terracotta, near-black-with-one-neon-accent,
identical-rounded-SaaS-cards). Still dark-primary, since that's
consistent with how the product is actually used, but built to look
like a decision, not left-over MVP styling.

### 4a. Token architecture — resolves §2.5

Two separate token layers, not one flat palette. This is the actual
answer to "does branding's hook survive the rehaul": it survives by
construction, because brand color and status/semantic color stop being
the same variable.

- **Brand layer** — one overridable value, `--brand-accent` (today's
  `--accent` renamed). This is the thing `org_branding` (A1) actually
  overrides: Group sets a default, Company can override per PATCH, the
  effective value folds into `GET /session` same as A1 already scopes,
  and the frontend sets it once via `document.documentElement.style
  .setProperty('--brand-accent', value)` — no component changes needed
  either way. Derived shades (`--brand-accent-hover`, `--brand-accent
  -bright`) get computed at apply-time in JS (lighten/darken the one
  source value), not hand-picked per palette, so an arbitrary company
  color always produces a usable hover/bright pair.
- **Semantic/status layer** — fixed, never touched by branding:
  `--status-done`, `--status-blocked`, `--status-in-progress`,
  `--status-warning`. These stay constant regardless of a company's
  brand color, for the obvious reason: a task being "done" should look
  the same shade of green whether the company's brand color is jade,
  red, or navy.

Consequence for §4 below: the jade `#3ecf8e` is `--brand-accent`'s
*default* value (what Group-level/free-tier orgs see, unbranded), not a
hardcoded status color — the original draft used it for both, which is
the bug this section exists to fix. `--status-done` gets its own fixed
value, coincidentally close to jade by default but tracked separately
from day one.

This also means **build order genuinely doesn't matter anymore**: the
rehaul can introduce `--brand-accent` as a real, overridable variable
without `org_branding`'s routes existing yet (it just won't be
overridden by anything, same as today), and `org_branding` can ship
first or land later and set the same variable — neither implementation
has to wait on or guess at the other's shape.


**Color** — a genuinely distinctive dark base rather than the current
generic near-black-plus-indigo formula:
- `--ink` `#10131a` (a deep blue-slate base, not pure black or purple-black)
- `--panel` `#171b24` / `--panel-raised` `#1f2430` (surfaces, subtle step)
- `--line` `rgba(235,238,245,0.07)` (hairline, not soft-shadow elevation)
- `--brand-accent` `#3ecf8e` (default, overridable per §4a — a confident
  jade/emerald, distinct from both SaaS-purple and SaaS-terracotta;
  a company can replace this via `org_branding` without touching
  anything below)
- `--status-done` `#3ecf8e`, `--status-blocked` `#e2554f`,
  `--status-in-progress` `#f0a84e`, `--status-warning` `#e0b84a` — fixed,
  independent of `--brand-accent`, kept legible against the slate base.

**Type** — one confident grotesk for UI/body (something with real
character at display sizes — not a default system-UI stand-in) paired
with one mono face reserved strictly for identifiers/timestamps
(`NEXUS-001`, dates) — a functional pairing, not decoration. Clear type
scale with intentional weight jumps (not just size jumps) between
headline/label/body, per the type-scale guidance a demo-facing product
should actually show off.

**Layout** — left-aligned, generous but not padded-for-its-own-sake
spacing; data-dense views (task lists, org hierarchy) stay dense, but
framing chrome around them (page headers, empty states, onboarding)
gets real breathing room — the contrast between "dense where the work
happens" and "considered where a new viewer lands" is itself part of
reading as a real product rather than a spreadsheet with a coat of paint.

**Principles** — the brand accent spent deliberately (one color, not
smeared across every button/link/badge) and never doing double duty as
a status color; status always paired with a text state, not color
alone; real identifiers visible rather than hidden; and specifically:
nothing that reads as leftover from the original single-org MVP — every
screen should look like it was built for a product other companies
could plausibly run their own operations on, not like ABION's internal
tool that happens to be visible to guests.

Still just a strawman — worth a real pass (mood references, actual
component mockups) once you're ready to schedule the build itself.
