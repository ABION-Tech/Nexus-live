# FUTURE SCOPE — Admin, Analytics, Investigation & Observability

**Status: Phase 1 planning complete — superseded by `ADMIN_BUILD_GUIDE.md`
(repo root).** That document is now the reference for implementation,
scoped to 9 sessions (numbered relative to its own start — see its own
header; in this repo's actual session numbering they begin at
**Session 36**, since `SESSION_LOG.md` runs through Session 35 as of this
update).

Phase 1 (architecture & data-model inspection, called for below) found the
org hierarchy piece of this spec **already built** — `organizations.org_type`/
`parent_org_id` and `org_memberships` (migration `0006_org_hierarchy_memberships.sql`),
built for an unrelated reason (a person holding different roles in
different companies simultaneously) but sufficient foundation for the
Group→Company model this spec calls for. Everything else below — Super
Admin, Group/Company Admin surfaces, guests, projects, AI usage tracking,
audit log, PostHog — is confirmed **not** built (see `ADMIN_BUILD_GUIDE.md`
§0 for the full inspection notes) and is what the 9 sessions actually build.

Do not start implementation against the raw spec preserved below — it
predates the architecture inspection and doesn't reflect what's already in
place. `ADMIN_BUILD_GUIDE.md` is the locked plan; this file is kept for
historical context only (the original ask, preserved verbatim per its own
prior note).

---

## Full spec, as originally provided (historical — see status note above)

(Preserved verbatim below for reference during that planning session.)

---

NEXUS — Administration, Analytics, Investigation & Observability

Complete Production Implementation Scope

Objective

Build the complete administrative and intelligence layer for NEXUS.

NEXUS must support:

- Platform-level Super Administration
- Optional Groups containing selected Companies
- Independent Companies that belong to no Group
- Company-level administration
- Group-level administration
- Hierarchical analytics
- Product analytics
- Operational analytics
- AI usage and cost monitoring
- System observability
- Security/audit logging
- Super Admin investigation and drill-down

The implementation must be scope-aware, secure, modular, and multi-organization ready, without prematurely building a full multi-tenant billing/enterprise platform.

---

1. CANONICAL ORGANIZATIONAL MODEL

The NEXUS organizational structure is:

NEXUS PLATFORM
│
├── GROUP A
│   ├── COMPANY A
│   ├── COMPANY B
│   └── COMPANY C
│
├── GROUP B
│   ├── COMPANY D
│   └── COMPANY E
│
├── INDEPENDENT COMPANY F
│
└── INDEPENDENT COMPANY G

Below Company:

Company
│
├── Departments
│
├── Teams / Groups
│
└── Users

Critical rule

A Company may belong to zero or one Group.

Therefore:

companies.group_id = nullable

A null "group_id" means:

«This is an independent Company.»

A Group must never automatically inherit Companies that have not been explicitly assigned to it.

---

2. ADMINISTRATION HIERARCHY

There are three administrative scopes:

SUPER ADMIN
    ↓
GROUP ADMIN
    ↓
COMPANY ADMIN

These are not merely three UI screens.

They are three authorization scopes.

Super Admin

Scope:

PLATFORM

Can investigate the entire NEXUS ecosystem.

Group Admin

Scope:

GROUP

Can access the Group and only the Companies explicitly belonging to it.

Company Admin

Scope:

COMPANY

Can access only their Company.

---

3. SUPER ADMIN

Super Admin is the NEXUS platform authority.

Super Admin can:

- View all Groups
- View all Companies
- View independent Companies
- Create Groups
- Create Companies
- Assign Companies to Groups
- Remove Companies from Groups
- Manage platform users
- Manage platform-level permissions
- Investigate Groups
- Investigate Companies
- Investigate users
- View platform analytics
- View Group analytics
- View Company analytics
- View AI usage/cost
- View system health
- View integrations
- View automation health
- View security events
- View audit logs
- View platform errors

Super Admin should be able to move seamlessly between:

NEXUS
→ Group
→ Company
→ Department/Team
→ User
→ Activity/Event

---

4. SUPER ADMIN INVESTIGATION MODE

This is a core feature.

Super Admin should have an Investigate capability.

Investigation is primarily read-only inspection.

It must not automatically impersonate users or modify their data.

Investigation flow

SUPER ADMIN
      ↓
GROUP
      ↓
COMPANY
      ↓
TEAM / DEPARTMENT
      ↓
USER
      ↓
ACTIVITY / OPERATIONS / AUDIT

Group investigation

Super Admin can inspect:

- Group profile
- Companies
- Group users
- Company distribution
- Operational activity
- Tasks
- Goals
- Feature usage
- AI usage
- AI cost
- Automations
- Errors
- Activity
- Audit history

Company investigation

Super Admin can inspect:

- Company profile
- Users
- Departments
- Teams
- Tasks
- Goals
- Analytics
- AI usage
- AI cost
- Automations
- Integrations
- Activity
- Audit history
- System errors affecting the Company

User investigation

Where permitted, Super Admin can inspect:

- Account information
- Role
- Company
- Group
- Activity
- Feature usage
- Tasks
- Goals
- AI usage
- relevant audit history

Do not expose unnecessary sensitive content merely because the user is being investigated.

---

5. IMPERSONATION

Do NOT automatically implement user impersonation as part of ordinary investigation.

If added later, it must be separate from investigation.

Potential future model:

Investigate
→ Read-only

Impersonate
→ Explicit privileged action

Impersonation must require:

- explicit confirmation
- reason
- audit record
- start timestamp
- end timestamp
- persistent visible banner
- clear exit mechanism
- preferably read-only mode by default

---

6. GROUP ADMIN

A Group Admin is attached to a specific Group.

They can access:

- their Group
- Companies explicitly belonging to their Group
- aggregate Group analytics
- permitted Company-level summaries
- Group activity
- Group operations

They cannot access:

- other Groups
- independent Companies
- Companies belonging to another Group
- Super Admin functionality

Group dashboard

Display:

GROUP OVERVIEW

Companies
Users
Active Users

Tasks
Completed
Overdue
Completion Rate

Goals
Active
Completed

AI Requests
AI Cost

Automation Success
Recent Activity

---

7. COMPANY ADMIN

Company Admin is attached to a specific Company.

They can access:

- Company users
- Departments
- Teams
- Tasks
- Goals
- Company analytics
- Company activity
- Company automations
- permitted integrations
- Company settings
- permitted audit information

They cannot access another Company.

Company dashboard

Display:

COMPANY OVERVIEW

Employees
Active Today

Tasks
Completed
Overdue
Completion Rate

Goals
Active
Completed

AI Requests
AI Cost

Automation Success
Recent Activity

---

8. SCOPE-AWARE AUTHORIZATION

Do not implement permissions as simply:

role === "admin"

Authorization must evaluate:

ACTOR
+
ROLE
+
PERMISSION
+
SCOPE
+
RESOURCE

Example:

Super Admin
permission: analytics:view
scope: PLATFORM

Group Admin
permission: analytics:view
scope: GROUP
group_id: grp_001

Company Admin
permission: analytics:view
scope: COMPANY
company_id: cmp_001

Authorization must happen server-side.

Frontend hiding is not security.

---

9. ORGANIZATIONAL DATA MODEL

At minimum support:

groups
companies
departments
teams
users

Group

id
name
description
status
created_at
updated_at

Company

id
name
description
group_id nullable
status
created_at
updated_at

Important relationship

Group 1 ─────── * Companies

Company 0/1 ─── Group

Do not allow a Company to belong to multiple Groups unless the architecture is explicitly redesigned later.

---

10. GROUP MANAGEMENT

Super Admin can:

- Create Group
- Edit Group
- Deactivate Group
- Assign Group Admin
- Remove Group Admin
- Add Company
- Remove Company
- View Group analytics
- Investigate Group

Moving a Company

Example:

Company A
Group X

to:

Company A
Group Y

must:

1. require appropriate permission
2. update "group_id"
3. generate an audit event
4. preserve historical records
5. immediately change Group-level visibility

Changing:

group_id = NULL

makes the Company independent.

---

11. COMPANY MANAGEMENT

Super Admin can:

- Create Company
- Edit Company
- Deactivate Company
- Assign Company Admin
- Remove Company Admin
- Assign Company to Group
- Remove Company from Group
- Investigate Company

Company Admin can manage only permitted Company-level resources.

---

12. PRODUCT ANALYTICS

Integrate PostHog or an equivalent analytics provider through an internal analytics abstraction.

Do not tightly couple the NEXUS application to PostHog.

Create:

analyticsService

with PostHog as the current provider.

This makes it possible to replace the analytics provider later.

---

13. PRODUCT EVENTS

Track meaningful events.

Authentication

user_signed_in
user_signed_out
login_failed
user_invited
user_activated

Work

task_created
task_assigned
task_updated
task_completed
task_reopened
task_overdue
task_comment_added

Goals

goal_created
goal_updated
goal_completed
goal_decomposed

People

person_created
person_updated
person_deactivated
role_changed
permission_changed

Knowledge

document_uploaded
document_viewed
knowledge_searched

AI

ai_request
ai_request_completed
ai_request_failed
ai_feedback

Automation

automation_created
automation_executed
automation_failed

Communications

notification_sent
notification_failed
announcement_created

Do not track every button click simply because it is possible.

Track events that answer meaningful product or operational questions.

---

14. EVENT ATTRIBUTION

Where applicable, events should contain:

event_name
user_id
company_id
group_id nullable
department_id nullable
team_id nullable
feature
timestamp
platform
app_version
session_id
metadata

Example grouped Company:

company_id = company_001
group_id = group_001

Independent Company:

company_id = company_002
group_id = null

The system must never invent Group attribution.

---

15. HIERARCHICAL ANALYTICS

The same underlying analytics system must support different scopes.

Analytics Engine
│
├── PLATFORM
│   └── Super Admin
│
├── GROUP
│   └── Group Admin
│
└── COMPANY
    └── Company Admin

Super Admin

Can aggregate:

All Groups
+
All Group Companies
+
Independent Companies

Group Admin

Aggregates:

Their Group
+
Only Companies explicitly in that Group

Company Admin

Aggregates:

Their Company only

---

16. FEATURE ADOPTION

Measure usage of major NEXUS modules:

Dashboard
Work
Network
People
Goals
Knowledge
Analytics
AI Analyst
Comms & Ops
Automation

Metrics:

- unique users
- events
- usage frequency
- usage trend
- percentage of active users

Scope these metrics appropriately.

---

17. USER ANALYTICS

Display:

User
Role
Company
Group
Last Active
Sessions
Tasks
Goals
AI Requests
Feature Usage

Super Admin can investigate users across NEXUS.

Group Admin can investigate permitted users within their Group.

Company Admin can investigate permitted users within their Company.

---

18. ORGANIZATIONAL ANALYTICS

Calculate where existing data supports it.

Tasks

- created
- completed
- overdue
- completion rate
- on-time completion
- average completion time

Goals

- active
- completed
- completion rate
- progress

Automation

- executions
- successes
- failures
- success rate

Do not redesign existing NEXUS operational systems just to produce analytics.

---

19. AI OBSERVABILITY

Create:

ai_usage

Minimum:

id
user_id
company_id
group_id nullable
provider
model
feature
input_tokens
output_tokens
latency_ms
success
estimated_cost
created_at

Create:

aiUsageService

All AI providers should report usage through this service.

Track:

- requests
- successful requests
- failed requests
- tokens
- latency
- estimated cost
- provider
- model
- feature

---

20. AI COST DASHBOARD

Super Admin

Platform AI Requests
Platform AI Cost

Cost by Group
Cost by Company
Cost by User
Cost by Feature
Cost by Model

Group Admin

Group AI Requests
Group AI Cost

Company A
Company B
Company C

Company Admin

Company AI Requests
Company AI Cost

Cost by Feature
Cost by User

Label values as Estimated Cost unless actual billing data is available.

---

21. SYSTEM OBSERVABILITY

Track:

API

- requests
- latency
- errors
- status codes
- request IDs

Database

- failed queries
- slow queries
- connection failures
- transaction failures

AI

- provider failures
- latency
- rate limits
- failed requests

Email

- sent
- failed
- retries

n8n

- workflow executions
- successes
- failures
- retries

Notifications

- sent
- failed

Webhooks

- delivered
- failed
- retries

---

22. SYSTEM HEALTH

Super Admin should see:

API              HEALTHY
DATABASE         HEALTHY
AI               HEALTHY
EMAIL            HEALTHY
N8N              HEALTHY
NOTIFICATIONS    HEALTHY
WEBHOOKS         HEALTHY

Each service may show:

- status
- latency
- last successful operation
- recent failures

Do not expose sensitive infrastructure information to Company/Group Admins.

---

23. AUDIT LOG

Create a persistent audit system separate from PostHog.

Minimum:

id
actor_user_id
company_id nullable
group_id nullable
action
resource_type
resource_id
previous_value
new_value
metadata
ip_address
user_agent
created_at

Track:

user_created
user_deactivated
role_changed
permission_changed
group_created
group_updated
company_created
company_updated
company_group_changed
admin_action
integration_changed
security_event
data_exported

Audit records must be protected from ordinary user modification/deletion.

---

24. SUPER ADMIN AUDIT INVESTIGATION

Super Admin should be able to filter audit events by:

Date
Actor
Group
Company
Action
Resource

Example:

29 Aug 2026 — 11:42

Actor:
Admin User

Action:
Company assigned to Group

Company:
Company A

Previous Group:
None

New Group:
Group X

---

25. SUPER ADMIN PLATFORM VIEW

Create a dedicated platform overview:

NEXUS SUPER ADMIN

Organizations
──────────────────
Groups                    14
Companies                127
Independent Companies     18
Users                   8,421

Activity
──────────────────
Active Today            5,392
Tasks Today             1,482
AI Requests             8,421
API Requests           91,204

Health
──────────────────
API                     Healthy
Database                Healthy
AI                      Healthy
Email                   Healthy
n8n                     Healthy

Security
──────────────────
Recent Events
Failed Auth
Permission Changes

---

26. SUPER ADMIN INVESTIGATION UI

Provide an obvious:

🔎 Investigate

entry point.

Super Admin can search:

Groups
Companies
Users

Then drill down.

Example

Search: ABION
        ↓
ABION GROUP
        ↓
ABION TECHNOLOGIES
        ↓
MARK
        ↓
Activity

Maintain a visible breadcrumb:

NEXUS
/ ABION GROUP
/ ABION TECHNOLOGIES
/ MARK

This prevents confusion about the current scope.

---

27. COMPANY ADMIN UI

Company Admin should have:

COMPANY

Overview
People
Work
Goals
Knowledge
Analytics
Automation
Activity
Settings

Only show permitted sections.

---

28. GROUP ADMIN UI

Group Admin should have:

GROUP

Overview
Companies
People
Operations
Goals
Analytics
Activity

The Companies view must list only companies assigned to that Group.

---

29. SUPER ADMIN UI

Super Admin should have:

NEXUS

Overview
Groups
Companies
Users

Analytics
Operations
AI & Costs

System Health
Audit & Security

Settings

---

30. SECURITY / DATA ISOLATION

This is non-negotiable.

A user must never gain access merely by changing:

/company/:id
/group/:id
/user/:id

Every API request must validate:

authenticated user
+
permission
+
resource
+
organizational scope

Test direct unauthorized API access.

Do not rely on UI restrictions.

---

31. ANALYTICS PRIVACY

Do not send unnecessary sensitive data to PostHog.

Never send:

- passwords
- tokens
- API keys
- secrets
- payment information
- unnecessary personal data
- entire documents
- unnecessary task contents
- private AI conversations by default

Prefer IDs and metadata.

---

32. PERFORMANCE

Analytics must never block normal application operations.

If PostHog fails:

NEXUS CONTINUES WORKING

If analytics fails while creating a task:

TASK CREATION MUST STILL SUCCEED

If AI cost tracking fails:

AI REQUEST MUST NOT AUTOMATICALLY FAIL

Use asynchronous/non-blocking tracking where appropriate.

---

33. COST ARCHITECTURE

Track estimated operational costs where possible.

Categories:

AI
Email
Storage
Analytics
Infrastructure

Use:

estimated_cost

where actual provider billing is unavailable.

Do not present estimated infrastructure allocation as actual billing.

---

34. DATABASE / ARCHITECTURE PRINCIPLES

Follow NEXUS's production architecture:

React
   ↓
API
   ↓
Services
   ↓
Database / Providers

Suggested services:

authorizationService
organizationService
analyticsService
auditLogService
aiUsageService
systemMetricsService

Provider-specific implementations should remain replaceable.

The frontend must not contain the authoritative authorization logic.

---

35. POSTHOG ROLE

PostHog is:

PRODUCT ANALYTICS

It is NOT:

NEXUS DATABASE

It should not become the source of truth for:

- users
- companies
- Groups
- tasks
- goals
- permissions
- audit history
- financial records

PostHog can provide behavioral analytics.

PostgreSQL remains authoritative for NEXUS operational data.

---

36. INVESTIGATION VS OPERATION

Super Admin investigation should be read-only by default.

Separate:

INVESTIGATE

from:

MODIFY

and from:

IMPERSONATE

This distinction should exist at the permission level.

---

37. TESTING

Tests must cover:

Organizational isolation

- Group Admin sees their Group.
- Group Admin sees only its Companies.
- Group Admin cannot see another Group.
- Group Admin cannot see independent Companies.
- Company Admin sees only their Company.
- Independent Companies work with "group_id = null".
- Super Admin sees everything.

Analytics

- Correct user attribution.
- Correct Company attribution.
- Correct Group attribution.
- Null Group attribution for independent Companies.
- No analytics failure breaks core operations.

Authorization

Test direct API access attempts.

Example:

Company A Admin
→ attempts Company B endpoint
→ 403

Group A Admin
→ attempts Group B endpoint
→ 403

Group A Admin
→ attempts independent Company endpoint
→ 403

Audit

Verify critical administrative actions generate audit records.

AI

Verify:

- token usage
- cost calculation
- provider
- model
- Company attribution
- optional Group attribution

---

38. IMPLEMENTATION ORDER

Do not build everything simultaneously.

PHASE 1 — Architecture & Data Model

Inspect the existing codebase first.

Do not assume the current schema.

Identify:

- current users
- current roles
- current Company model
- current RBAC
- current database structure
- current authentication
- existing analytics
- existing admin functionality

Then implement the minimum schema changes required.

---

PHASE 2 — Organizational Structure

Implement:

- Groups
- Companies
- nullable "group_id"
- Group/Company relationships
- Group management
- Company management

Verify independent Companies work correctly.

---

PHASE 3 — Authorization

Implement:

- Super Admin scope
- Group Admin scope
- Company Admin scope
- resource/action permissions
- server-side enforcement

Test isolation before building dashboards.

---

PHASE 4 — Core Services

Implement:

organizationService
authorizationService
analyticsService
auditLogService
aiUsageService
systemMetricsService

---

PHASE 5 — Observability

Implement:

- PostHog
- product events
- backend logging
- AI usage
- AI costs
- audit logging
- system health

---

PHASE 6 — Dashboards

Build:

1. Super Admin
2. Group Admin
3. Company Admin

Use the same underlying services with different scopes.

---

PHASE 7 — Investigation

Implement:

- global search
- Group drill-down
- Company drill-down
- User drill-down
- breadcrumbs
- activity views
- analytics views
- audit views

Investigation is read-only by default.

---

PHASE 8 — Testing & Hardening

Run:

- unit tests
- integration tests
- authorization tests
- analytics tests
- regression tests
- security tests

Verify existing NEXUS functionality remains intact.

---

39. P0 — REQUIRED

The first production implementation must include:

Organization

- Groups
- Companies
- Optional Group membership
- Independent Companies

Authorization

- Super Admin
- Group Admin
- Company Admin
- scoped permissions
- server-side enforcement

Administration

- Group management
- Company management
- Admin assignment

Analytics

- PostHog
- core events
- hierarchical attribution

Observability

- backend errors
- system health
- integration health

AI

- usage tracking
- token tracking
- estimated cost

Security

- audit log
- administrative event tracking

UI

- Super Admin dashboard
- Group dashboard
- Company dashboard
- Super Admin investigation/drill-down

---

40. P1 — AFTER P0 IS STABLE

Add:

- advanced funnels
- retention
- cohorts
- feature adoption analysis
- company comparisons
- Group comparisons
- advanced cost allocation
- custom reports
- exports
- advanced system analytics

---

41. P2 — FUTURE

Do not build these now unless explicitly requested:

- organizational health scoring
- predictive analytics
- benchmarking
- anomaly detection
- customer profitability analytics
- full billing analytics
- data warehouse
- advanced BI
- sophisticated impersonation system
- cross-company intelligence

---

42. DEFINITION OF DONE

The feature is complete when:

Organizational model

- A Company can exist independently.
- A Company can belong to one Group.
- Groups contain only explicitly assigned Companies.
- Moving Companies between Groups works correctly.
- Removing a Company from a Group makes it independent.

Administration

- Super Admin controls the platform.
- Group Admin controls their Group.
- Company Admin controls their Company.

Security

- Server-side authorization is enforced.
- Cross-Company access is blocked.
- Cross-Group access is blocked.
- Independent Companies cannot be accessed by Group Admins.
- Direct API manipulation cannot bypass scope.

Investigation

- Super Admin can search Groups, Companies and Users.
- Super Admin can drill from Group → Company → User.
- Investigation is read-only by default.
- Breadcrumbs clearly indicate current scope.
- Investigation actions are auditable where appropriate.

Analytics

- Product events are captured.
- Events have correct organizational attribution.
- Group attribution is nullable.
- Feature adoption is measurable.
- Operational metrics are available.

AI

- AI usage is tracked.
- Token usage is tracked.
- Estimated cost is calculated.
- Cost can be aggregated by Company and Group.

System

- API health is visible.
- Database health is visible.
- Integration failures are observable.
- Analytics failures cannot break NEXUS.

Security

- Audit history exists.
- Critical administrative actions are recorded.
- Sensitive data is not unnecessarily sent to analytics providers.

Quality

- Tests cover organization isolation.
- Tests cover authorization.
- Tests cover analytics attribution.
- Tests cover audit logging.
- Existing NEXUS functionality continues to work.

---

43. AGENT EXECUTION RULE

Before modifying code:

1. Inspect the existing repository.
2. Map the existing architecture.
3. Map the current database schema.
4. Map the current RBAC/authentication.
5. Identify conflicts with this specification.
6. Produce a short implementation plan.
7. Then implement.

Do not blindly rewrite existing NEXUS architecture.

Do not duplicate codebases for individual Companies.

Do not create separate analytics implementations for each Company.

Do not introduce unnecessary dependencies.

Do not implement P1/P2 features while P0 remains unstable.

After completing P0:

STOP and report:

- files changed
- database migrations
- new services
- new endpoints
- new permissions
- analytics events
- tests run
- unresolved issues
- screenshots/UI status
- anything requiring architectural approval

Only proceed to P1 after approval.

CORE ARCHITECTURAL PRINCIPLE

NEXUS should operate as:

                 NEXUS
                   │
          ┌────────┴────────┐
          │                 │
       GROUPS          INDEPENDENT
          │              COMPANIES
          │
      COMPANIES
          │
    ┌─────┴─────┐
DEPARTMENTS    TEAMS
          │
        USERS

while administration operates as:

                 SUPER ADMIN
                     │
              ┌──────┴──────┐
              │             │
         GROUP ADMIN    COMPANY ADMIN
              │             │
         GROUP SCOPE    COMPANY SCOPE

and analytics operates as:

              ANALYTICS ENGINE
                     │
       ┌─────────────┼─────────────┐
       ↓             ↓             ↓
    PLATFORM       GROUP        COMPANY
       ↓             ↓             ↓
 Super Admin     Group Admin   Company Admin

One NEXUS. One underlying architecture. One source of truth. Multiple scopes of visibility and control.
