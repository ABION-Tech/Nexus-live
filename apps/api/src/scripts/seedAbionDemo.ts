// The real ABION demo seed — this is what 0031_legacy_seed_ids.sql's
// header comment refers to as database/seed/ABION_DEMO_SEED.sql, which
// was referenced but never actually written. It's a TS script rather
// than a .sql file: the source data needs name→UUID resolution
// (assignees, supervisors), legacy-ID→UUID resolution (task
// dependencies, goal↔pending-task links), and goal-decomposition
// dependency-index handling that goalService.ts's own createGoal()
// already implements correctly — reimplementing that logic in raw SQL
// would just be a second, divergent copy of it. Same reasoning
// seedDev.ts's own header gives for using real service functions
// instead of raw inserts.
//
// Reads database/seed/abion_demo_data.json, produced by running
// `python3 database/seed/extract_abion_demo.py` against the real
// legacy sheet (database/seed/ABION_NEXUS_Demo_Sheet.xlsx). That
// extraction script — not this one — is where every data-quality
// judgement call about the source sheet is made and documented (a
// re-pasted header row dropped, one row's shifted columns
// reconstructed, two duplicate legacy IDs suffixed, placeholder test
// rows kept per an explicit decision). This script trusts that JSON is
// already clean and just needs to land it in Postgres correctly.
//
// Single org ("ABION Industries", company-type) — this is real
// production data for one real team, not the multi-org fictional
// roster seedDev.ts builds for local development testing.
//
// Assumes a fresh DB, same as seedDev.ts. Run:
//   npm run migrate -w apps/api
//   npm run seed:abion-demo -w apps/api
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, withOrgContext } from "../db.js";
import type { PoolClient } from "pg";
import { createTask, type CreateTaskInput } from "../services/taskService.js";
import { createGoal } from "../services/goalService.js";
import { grantPermission } from "../services/permissionService.js";
import type { TaskPriority, TaskStatus } from "@nexus/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, "../../../../database/seed/abion_demo_data.json");

interface AbionData {
  team_members: Array<{
    name: string;
    email: string;
    role_title: string;
    department: string | null;
    notes: string | null;
    trusted_master_tasks: boolean;
    trusted_cos: boolean;
    trusted_partnerships: boolean;
    trusted_new_button: boolean;
  }>;
  master_tasks: Array<{
    legacy_id: string;
    title: string;
    priority: TaskPriority;
    status: TaskStatus;
    assigned_to_name: string | null;
    assigned_to_email: string | null;
    support_person_name: string | null;
    business_dept: string | null;
    start_date: string | null;
    deadline: string | null;
    notes: string | null;
    depends_on_legacy_id: string | null;
    supervisor_name: string | null;
  }>;
  goals: Array<{
    legacy_id: string;
    title: string;
    created_by_name: string;
    created_at: string | null;
    status: string;
    task_ids: string[];
    notes: string | null;
    reasoning: string | null;
    proposed_tasks: Array<{
      legacy_id: string;
      title: string;
      priority: TaskPriority;
      suggested_assignee_name: string | null;
      status: string;
      depends_on_index: number | null;
      reviewed_by_name: string | null;
      reviewed_at: string | null;
      created_at: string | null;
    }>;
  }>;
  network_cos: Array<Record<string, unknown>>;
  partnerships: Array<Record<string, unknown>>;
  org_contacts: Array<Record<string, unknown>>;
  eod_logs: Array<{ date: string; user_name: string; summary: string }>;
  marketing: Array<Record<string, unknown>>;
  meetings: Array<Record<string, unknown>>;
  automation_controls: Array<{ key: string; enabled: boolean; toggled_by_name: string }>;
  automation_log: Array<{ timestamp: string; control_key: string; new_value: boolean; changed_by_name: string }>;
  knowledge_base: Array<{ title: string; content: string; category: string | null; updated_by_name: string }>;
  notifications: Array<{
    recipient_name: string;
    type: string;
    title: string;
    body: string;
    task_legacy_id: string | null;
    created_at: string;
    read: boolean;
  }>;
  task_checklists: Array<{ task_legacy_id: string; item_text: string; is_done: boolean; created_at: string }>;
  chat_messages: Array<{ channel: string; task_legacy_id: string | null; author_name: string | null; body: string; created_at: string }>;
  chat_read_state: Array<{ user_name: string; channel: string; task_legacy_id: string | null; last_read_at: string }>;
  leave_requests: Array<{
    user_name: string;
    start_date: string;
    end_date: string;
    reason: string | null;
    status: string;
    approved_by_name: string | null;
    decided_at: string | null;
  }>;
  permission_log: Array<{ changed_at: string; changed_by_name: string; target_name: string; resource: string; action: string; granted: boolean }>;
  activity_log: Array<{ changed_at: string; actor_name: string; task_legacy_id: string; field: string; old_value: string | null; new_value: string | null }>;
  email_accounts: Array<{ priority: string; email_address: string; daily_limit: string; used_today: string; last_reset_date: string; enabled: boolean }>;
  interns: Array<{
    date: string;
    intern_name: string;
    activity: string;
    status: string;
    proof_link: string | null;
    supervisor_notes: string | null;
  }>;
}

function loadData(): AbionData {
  return JSON.parse(readFileSync(DATA_PATH, "utf-8"));
}

// ---------------------------------------------------------------------
// Name resolution — every non-Master-Tasks sheet in the legacy export
// references people by their exact Team Members.Name string (Assigned
// To, Team Member, Recipient, Author, GrantedTo, ...). Built once,
// after team members are inserted, and reused everywhere.
// ---------------------------------------------------------------------
type UserMap = Map<string, string>; // name -> user_id

function resolveUser(map: UserMap, name: string | null | undefined): string | undefined {
  if (!name) return undefined;
  return map.get(name.trim());
}

// Leaders per real title, not guessed: PRD §3's leader-role gate is
// "Founder / designated COO-level." Only Ayo (Group CEO) and Femi
// (Deputy COO) carry that title in the real roster — the other 15,
// including several with "Director"/"Lead" titles, are Trusted_*-gated
// team members instead, same as the legacy sheet's own two-tier model
// (PRD §3's audit notes). Flagged in the run summary at the end, not
// buried — this is a real judgement call, not a fact read off the data.
const LEADER_NAMES = new Set(["Ayo T. Joshua", "Femi Balogun"]);

async function main() {
  const data = loadData();

  const org = await (async () => {
    const { rows } = await pool.query<{ id: string; name: string }>(
      `select id, name from create_organization_row($1, $2, $3)`,
      ["ABION Industries", "company", null]
    );
    const row = rows[0];
    if (!row) throw new Error("create_organization_row returned no row");
    return row;
  })();

  // --- Team Members → users + org_memberships + Trusted_* grants ----
  const userMap: UserMap = new Map();
  let ayoId = "";

  await withOrgContext(org.id, async (client) => {
    for (const tm of data.team_members) {
      const isLeader = LEADER_NAMES.has(tm.name);
      const { rows } = await client.query<{ id: string }>(
        `insert into users (name, email, home_org_id) values ($1, $2, $3) returning id`,
        [tm.name, tm.email, org.id]
      );
      const userId = rows[0]!.id;
      await client.query(
        `insert into org_memberships (user_id, org_id, role, title, is_home) values ($1, $2, $3, $4, true)`,
        [userId, org.id, isLeader ? "leader" : "team_member", tm.role_title]
      );
      userMap.set(tm.name, userId);
      if (tm.name === "Ayo T. Joshua") ayoId = userId;
    }
  });
  await pool.query(`insert into platform_admins (user_id) values ($1)`, [ayoId]);

  // Trusted_* flags → resource+action grants (PRD §13.3). Mapping is
  // this session's own interpretation, since the PRD names the four
  // legacy flags but never defines their target resource/action pairs
  // 1:1 — flagged in the run summary, not asserted as verbatim spec.
  for (const tm of data.team_members) {
    const userId = userMap.get(tm.name)!;
    if (LEADER_NAMES.has(tm.name)) continue; // leaders bypass hasPermission entirely
    if (tm.trusted_master_tasks) await grantPermission(org.id, ayoId, userId, "tasks", "update");
    if (tm.trusted_cos) await grantPermission(org.id, ayoId, userId, "network.cos", "read");
    if (tm.trusted_partnerships) await grantPermission(org.id, ayoId, userId, "network.partnerships", "read");
    if (tm.trusted_new_button) await grantPermission(org.id, ayoId, userId, "tasks", "create");
  }

  // --- Interns: a genuinely separate roster from Team Members (see
  // extract_abion_demo.py's comment on this sheet) — create a real
  // user row (role='intern') for each name that doesn't already exist. ---
  await withOrgContext(org.id, async (client) => {
    const seenInternNames = new Set<string>();
    for (const i of data.interns) {
      if (userMap.has(i.intern_name) || seenInternNames.has(i.intern_name)) continue;
      seenInternNames.add(i.intern_name);
      const placeholderEmail = `${i.intern_name.toLowerCase().replace(/[^a-z]+/g, ".")}@intern.abion.ng`;
      const { rows } = await client.query<{ id: string }>(
        `insert into users (name, email, home_org_id) values ($1, $2, $3) returning id`,
        [i.intern_name, placeholderEmail, org.id]
      );
      const userId = rows[0]!.id;
      await client.query(
        `insert into org_memberships (user_id, org_id, role, title, is_home) values ($1, $2, 'intern', 'Intern', true)`,
        [userId, org.id]
      );
      userMap.set(i.intern_name, userId);
    }
  });

  // --- Master Tasks (two-pass: parents before children via array
  // order — verified during extraction that every Depends-On chain in
  // the source is a forward reference to an earlier row) -------------
  const taskIdByLegacy = new Map<string, string>();
  const pendingIdByLegacy = new Map<string, string>(); // pending_ai_tasks legacy_id -> real uuid, filled in during Goals import below

  for (const t of data.master_tasks) {
    const input: CreateTaskInput = {
      title: t.title,
      description: t.notes ?? undefined,
      status: t.status,
      priority: t.priority,
      startDate: t.start_date ?? undefined, // 0034_abion_demo_seed_gaps.sql
      business: t.business_dept ?? undefined,
      deadline: t.deadline ?? undefined,
      assignedToUserId: resolveUser(userMap, t.assigned_to_name),
      supportUserId: resolveUser(userMap, t.support_person_name),
      supervisorUserId: resolveUser(userMap, t.supervisor_name),
      dependsOnTaskId: t.depends_on_legacy_id ? taskIdByLegacy.get(t.depends_on_legacy_id) : undefined,
    };
    const task = await createTask(org.id, input, ayoId);
    taskIdByLegacy.set(t.legacy_id, task.id);
    await withOrgContext(org.id, (client) =>
      client.query(`update tasks set legacy_sheet_id = $1 where id = $2`, [t.legacy_id, task.id])
    );
  }

  // --- Goals + Pending AI Tasks (real Review Queue history) ----------
  for (const g of data.goals) {
    const createdByUserId = resolveUser(userMap, g.created_by_name) ?? ayoId;
    const { goal, pendingTasks } = await createGoal(org.id, {
      title: g.title,
      createdByUserId,
      proposedTasks: g.proposed_tasks.map((p) => ({
        title: p.title,
        reasoning: g.reasoning ?? undefined,
        dependsOnIndex: p.depends_on_index ?? undefined,
      })),
    });

    await withOrgContext(org.id, async (client) => {
      // Historical fidelity: createGoal() stamps now() — overwrite with
      // the real legacy timestamp so Analytics/Task Trends reflect
      // when this actually happened, not when this seed ran.
      if (g.created_at) {
        await client.query(`update goals set created_at = $1, legacy_sheet_id = $2 where id = $3`, [
          g.created_at,
          g.legacy_id,
          goal.id,
        ]);
      } else {
        await client.query(`update goals set legacy_sheet_id = $1 where id = $2`, [g.legacy_id, goal.id]);
      }
      if (g.status.toLowerCase() === "archived") {
        await client.query(`update goals set status = 'archived' where id = $1`, [goal.id]);
      } else if (g.status.toLowerCase() === "drafting") {
        // 0034_abion_demo_seed_gaps.sql — 6 of the 9 real goals were
        // still 'Drafting' (no reviewed proposals at all) in the
        // legacy sheet; createGoal() always defaults new rows to
        // 'active', so this corrects that for the historical import
        // specifically, not for goals created through the real app.
        await client.query(`update goals set status = 'drafting' where id = $1`, [goal.id]);
      }

      for (let i = 0; i < g.proposed_tasks.length; i++) {
        const src = g.proposed_tasks[i]!;
        const inserted = pendingTasks[i]!;
        pendingIdByLegacy.set(src.legacy_id, inserted.id);

        // 0034_abion_demo_seed_gaps.sql — reviewed_by/reviewed_at now
        // exist; only the 2 historically-approved items under
        // GOAL-1786436415870 have real reviewer data (Reviewed_By on
        // the sheet), everything else stays null (never reviewed).
        const wasApproved = src.status.toLowerCase() === "approved";
        await client.query(
          `update pending_ai_tasks set
             status = $1,
             created_at = coalesce($2, created_at),
             reviewed_by = $3,
             reviewed_at = $4
           where id = $5`,
          [
            wasApproved ? "approved" : "pending",
            src.created_at,
            wasApproved ? resolveUser(userMap, src.reviewed_by_name) ?? null : null,
            wasApproved ? src.reviewed_at : null,
            inserted.id,
          ]
        );
      }
    });
  }

  // Link the real Master Tasks that were historically produced by
  // approving a Pending AI Task back to their source proposal —
  // tasks.source_pending_task_id, matching the real GOAL-1786436415870
  // → PAT-...-36ac/q87n → 1-... conversion history from the sheet.
  await withOrgContext(org.id, async (client) => {
    const links: Array<[string, string]> = [
      ["1-1786436599043", "PAT-1786436467645-0-36ac"],
      ["1-1786823899429", "PAT-1786436467912-1-q87n"],
      ["1-1786823902084", "PAT-1786436467912-1-q87n"], // the real double-conversion bug — same source, two tasks
    ];
    for (const [taskLegacyId, pendingLegacyId] of links) {
      const taskId = taskIdByLegacy.get(taskLegacyId);
      const pendingId = pendingIdByLegacy.get(pendingLegacyId);
      if (taskId && pendingId) {
        await client.query(`update tasks set source_pending_task_id = $1 where id = $2`, [pendingId, taskId]);
      }
    }
  });

  // --- Everything else: direct inserts inside withOrgContext, same as
  // seedDev.ts's own operational-data section. No business logic
  // beyond name/legacy-id resolution needed for any of these. --------
  await withOrgContext(org.id, async (client) => {
    for (const c of data.network_cos as any[]) {
      await client.query(
        `insert into network_cos (org_id, state, admin_name, admin_phone, admin_email, whatsapp_group_created, members_count, status, last_report_date, notes)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [org.id, c.state, c.admin_name, c.admin_phone, c.admin_email, c.whatsapp_group_created ?? false, c.members_count, (c.status || "not_started").toLowerCase().replace(" ", "_"), c.last_report_date, c.notes]
      );
    }

    for (const p of data.partnerships as any[]) {
      await client.query(
        `insert into partnerships (org_id, assigned_to_user_id, organisation, contact_name, contact_email, category, current_status, last_contact_date, follow_up_date, document_status, remarks)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [org.id, resolveUser(userMap, p.assigned_to_name), p.organisation, p.contact_name, p.contact_email, p.category, p.current_status, p.last_contact_date, p.follow_up_date, p.document_status, p.remarks]
      );
    }

    for (const o of data.org_contacts as any[]) {
      await client.query(
        `insert into org_contacts (org_id, contact_owner_user_id, visitor_name, "position", company_org, email, phone, state, staff_size, date_visited, letter_status, onboarding_status, follow_up_date, notes)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [org.id, resolveUser(userMap, o.contact_owner_name), o.visitor_name, o.position, o.company_org, o.email, o.phone, o.state, o.staff_size, o.date_visited, o.letter_status, o.onboarding_status, o.follow_up_date, o.notes]
      );
    }

    for (const e of data.eod_logs) {
      const userId = resolveUser(userMap, e.user_name);
      if (!userId) continue;
      await client.query(
        `insert into eod_logs (org_id, user_id, filed_by_user_id, date, summary)
         values ($1,$2,$2,$3,$4) on conflict (org_id, user_id, date) do nothing`,
        [org.id, userId, e.date, e.summary || "(no summary)"]
      );
    }

    // 0034_abion_demo_seed_gaps.sql — marketing_content.caption now
    // exists; the actual post text/copy is no longer dropped.
    for (const m of data.marketing as any[]) {
      await client.query(
        `insert into marketing_content (org_id, content_type, platform, caption, owner_user_id, due_date, status, post_link)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          org.id,
          m.content_type,
          m.platform,
          m.caption,
          resolveUser(userMap, m.assigned_to_name),
          m.due_date,
          (["planned", "in_progress", "posted", "skipped"].includes((m.status || "").toLowerCase().replace(" ", "_"))
            ? (m.status || "").toLowerCase().replace(" ", "_")
            : m.status === "Done"
              ? "posted"
              : m.status === "Not Started"
                ? "planned"
                : "planned"),
          m.post_link,
        ]
      );
    }

    // 0034_abion_demo_seed_gaps.sql — meetings.agenda/invitee_user_ids/
    // external_emails now exist as real columns; no more folding
    // everything into `notes`. Team_Invitees is a comma-separated list
    // of the same Name strings every other sheet uses — resolved the
    // same way, unresolved names (not real users) silently dropped
    // from the array rather than failing the whole insert.
    for (const mt of data.meetings as any[]) {
      const startTime = mt.time ? `${mt.date}T${mt.time}:00+01:00` : `${mt.date}T09:00:00+01:00`;
      const durationMins = Number(mt.duration_mins) || 60;
      const endTime = new Date(new Date(startTime).getTime() + durationMins * 60_000).toISOString();
      const inviteeIds = String(mt.team_invitees ?? "")
        .split(",")
        .map((n: string) => resolveUser(userMap, n.trim()))
        .filter((id: string | undefined): id is string => Boolean(id));
      await client.query(
        `insert into meetings (org_id, title, location_type, location_detail, start_time, end_time, organizer_user_id, agenda, invitee_user_ids, external_emails, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          org.id,
          mt.title,
          mt.location_type,
          mt.zoom_link,
          startTime,
          endTime,
          resolveUser(userMap, mt.organiser_name),
          mt.agenda,
          inviteeIds,
          mt.external_emails,
          mt.created_at,
        ]
      );
    }

    for (const a of data.automation_controls) {
      await client.query(
        `insert into automation_controls (org_id, key, enabled, updated_by_user_id) values ($1,$2,$3,$4)
         on conflict (org_id, key) do update set enabled = excluded.enabled`,
        [org.id, a.key, a.enabled, resolveUser(userMap, a.toggled_by_name)]
      );
    }

    for (const a of data.automation_log) {
      await client.query(
        `insert into automation_log (org_id, control_key, new_value, changed_by_user_id, changed_at) values ($1,$2,$3,$4,$5)`,
        [org.id, a.control_key, a.new_value, resolveUser(userMap, a.changed_by_name), a.timestamp]
      );
    }

    for (const k of data.knowledge_base) {
      await client.query(
        `insert into knowledge_entries (org_id, title, content, category, updated_by_user_id) values ($1,$2,$3,$4,$5)`,
        [org.id, k.title, k.content, k.category, resolveUser(userMap, k.updated_by_name) ?? ayoId]
      );
    }

    for (const n of data.notifications) {
      const userId = resolveUser(userMap, n.recipient_name);
      if (!userId) continue; // e.g. "NEXUS Automation" — a system actor, not a real user row
      await client.query(
        `insert into notifications (org_id, user_id, task_id, type, channel, title, body, read_at, created_at)
         values ($1,$2,$3,$4,'in_app',$5,$6,$7,$8)`,
        [
          org.id,
          userId,
          n.task_legacy_id ? taskIdByLegacy.get(n.task_legacy_id) ?? null : null,
          n.type,
          n.title,
          n.body,
          n.read ? n.created_at : null,
          n.created_at,
        ]
      );
    }

    for (const c of data.task_checklists) {
      const taskId = taskIdByLegacy.get(c.task_legacy_id);
      if (!taskId) continue; // TASK-1787398457038 has no matching Master Tasks row in the sheet — orphaned in the source itself
      await client.query(
        `insert into task_checklists (org_id, task_id, item_text, is_done, created_at) values ($1,$2,$3,$4,$5)`,
        [org.id, taskId, c.item_text, c.is_done, c.created_at]
      );
    }

    for (const m of data.chat_messages) {
      const taskId = m.task_legacy_id ? taskIdByLegacy.get(m.task_legacy_id) ?? null : null;
      if (m.channel === "task" && !taskId) continue; // task-channel message whose task isn't in this import
      await client.query(
        `insert into chat_messages (org_id, channel, task_id, author_user_id, body, created_at) values ($1,$2,$3,$4,$5,$6)`,
        [org.id, m.channel, taskId, resolveUser(userMap, m.author_name) ?? null, m.body, m.created_at]
      );
    }

    for (const r of data.chat_read_state) {
      const userId = resolveUser(userMap, r.user_name);
      if (!userId) continue;
      const taskId = r.task_legacy_id ? taskIdByLegacy.get(r.task_legacy_id) ?? null : null;
      if (r.channel === "task" && !taskId) continue;
      await client.query(
        `insert into chat_read_state (org_id, user_id, channel, task_id, last_read_at) values ($1,$2,$3,$4,$5)
         on conflict (org_id, user_id, channel, task_id) do update set last_read_at = excluded.last_read_at`,
        [org.id, userId, r.channel, taskId, r.last_read_at]
      );
    }

    for (const l of data.leave_requests) {
      const userId = resolveUser(userMap, l.user_name);
      if (!userId) continue;
      await client.query(
        `insert into leave_requests (org_id, user_id, start_date, end_date, reason, status, approved_by_user_id, decided_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [org.id, userId, l.start_date, l.end_date, l.reason, l.status, resolveUser(userMap, l.approved_by_name), l.decided_at]
      );
    }

    for (const p of data.permission_log) {
      const targetId = resolveUser(userMap, p.target_name);
      if (!targetId) continue;
      await client.query(
        `insert into permission_log (org_id, target_user_id, resource, action, granted, changed_by_user_id, changed_at)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [org.id, targetId, p.resource, p.action, p.granted, resolveUser(userMap, p.changed_by_name), p.changed_at]
      );
    }

    for (const a of data.activity_log) {
      const taskId = taskIdByLegacy.get(a.task_legacy_id);
      if (!taskId) continue;
      await client.query(
        `insert into activity_log (org_id, actor_user_id, resource_type, resource_id, field, old_value, new_value, changed_at)
         values ($1,$2,'tasks',$3,$4,$5,$6,$7)`,
        [org.id, resolveUser(userMap, a.actor_name), taskId, a.field, a.old_value, a.new_value, a.changed_at]
      );
    }

    for (const e of data.email_accounts) {
      await client.query(
        `insert into email_accounts (org_id, provider, email_address, priority, daily_limit, used_today, last_reset_date, enabled)
         values ($1,'resend',$2,$3,$4,$5,$6,$7)`,
        [org.id, e.email_address, e.priority, e.daily_limit, e.used_today, e.last_reset_date, e.enabled]
      );
    }

    // Interns table (0034_abion_demo_seed_gaps.sql). No structured
    // supervisor column exists in the source sheet — Supervisor Notes
    // is free text that sometimes names people inline ("Shared with
    // Shina and Israel...") but isn't a reliable field to parse a
    // supervisor_user_id out of; left null rather than guessed.
    for (const i of data.interns) {
      const userId = resolveUser(userMap, i.intern_name);
      if (!userId) continue;
      await client.query(
        `insert into interns (org_id, user_id, date, activity, status, proof_link) values ($1,$2,$3,$4,$5,$6)
         on conflict (org_id, user_id, date) do nothing`,
        [
          org.id,
          userId,
          i.date,
          `${i.activity}${i.supervisor_notes ? ` — Supervisor note: ${i.supervisor_notes}` : ""}`,
          i.status.toLowerCase() === "done" ? "done" : "in_progress",
          i.proof_link,
        ]
      );
    }
  });

  // --- Task Trends: read directly from the source xlsx at runtime —
  // 1,020 uniform numeric rows, safe to parse mechanically (unlike the
  // narrative sheets above, which needed the one-time manual cleaning
  // extract_abion_demo.py documents). Requires the `xlsx` package. ---
  const XLSX = (await import("xlsx")).default;
  const wbPath = join(__dirname, "../../../../database/seed/ABION_NEXUS_Demo_Sheet.xlsx");
  const wb = XLSX.readFile(wbPath, { cellDates: true });
  const trendsSheet = wb.Sheets["22. Task Trends"];
  if (!trendsSheet) throw new Error('Sheet "22. Task Trends" not found in ABION_NEXUS_Demo_Sheet.xlsx');
  const trendsRows: Array<{ Date: Date; Person: string; OpenTasks?: number; DoneToday?: number; OverdueTasks?: number }> =
    XLSX.utils.sheet_to_json(trendsSheet, { defval: null });

  await withOrgContext(org.id, async (client) => {
    let imported = 0;
    for (const row of trendsRows) {
      if (!row.Date || !row.Person) continue;
      const userId = resolveUser(userMap, row.Person);
      if (!userId) continue;
      const dateStr = new Date(row.Date).toISOString().slice(0, 10);
      await client.query(
        `insert into task_trends (org_id, date, user_id, open_tasks, done_today, overdue, at_risk)
         values ($1,$2,$3,$4,$5,$6,0)`,
        [org.id, dateStr, userId, row.OpenTasks ?? 0, row.DoneToday ?? 0, row.OverdueTasks ?? 0]
      );
      imported++;
    }
    console.log(`Task Trends: imported ${imported}/${trendsRows.length} rows`);
  });

  console.log(
    JSON.stringify(
      {
        orgId: org.id,
        platformAdmin: { userId: ayoId, name: "Ayo T. Joshua" },
        counts: {
          teamMembers: data.team_members.length,
          masterTasks: data.master_tasks.length,
          goals: data.goals.length,
          pendingAiTasks: data.goals.reduce((n, g) => n + g.proposed_tasks.length, 0),
        },
        knownGaps: [
          "meetings now has a real service/route (routes/meetings.ts, services/meetingService.ts + meetingRecordingService.ts, 0035_meeting_recordings.sql) — this seed script's own insert below still goes direct-to-SQL rather than through the new createMeeting() service function; left as-is since re-pointing a seed script at a service layer is a mechanical follow-up, not a gap in the feature itself.",
          "Push Subscriptions sheet rows are runtime placeholders ('[registered at runtime]'), not real keys — not imported.",
          "Trusted_* -> resource/action grant mapping (tasks.update / network.cos.read / network.partnerships.read / tasks.create) is this session's interpretation, not a verbatim PRD mapping — there's no schema fix for this one, just a documented judgement call.",
          "Interns have no structured supervisor field in the source sheet (Supervisor Notes is free text that sometimes names people inline) — interns.supervisor_user_id is left null for all rows rather than guessed from prose.",
        ],
      },
      null,
      2
    )
  );
}

main()
  .then(() => {
    console.log("\nABION demo seed complete.");
    return pool.end();
  })
  .catch((err) => {
    console.error("Seed failed:", err);
    return pool.end().finally(() => process.exit(1));
  });
