#!/usr/bin/env python3
"""
Extracts ABION_NEXUS_Demo_Sheet.xlsx (the real legacy GAS export, not
synthetic data) into database/seed/abion_demo_data.json for
seedAbionDemo.ts to import.

Why a separate script instead of hand-written JSON or a runtime xlsx
parser inside the TS seed script: the source sheet has real,
manually-diagnosed data-quality problems (see each function's docstring
below) that need one-time human judgement calls, not a generic parser
re-discovering them on every run. This script IS that judgement,
written down and re-runnable — matching 0031_legacy_seed_ids.sql's own
reasoning ("the same need will recur every time more of the legacy
sheet gets imported incrementally"). Re-run this if the source sheet is
updated; the decisions below still apply unless the sheet's shape
changes.

Every cleaning decision here was confirmed by reading the actual rows,
not assumed. Decisions made in conversation with the ABION team are
marked DECISION; decisions I judged unambiguous from the data itself
(e.g. dropping a literal re-pasted header row) are marked OBVIOUS.
"""
import json
import datetime
from pathlib import Path
import openpyxl

SRC = Path(__file__).parent / "ABION_NEXUS_Demo_Sheet.xlsx"
OUT = Path(__file__).parent / "abion_demo_data.json"

EXCEL_EPOCH = datetime.datetime(1899, 12, 30)


def excel_date(v):
    """The sheet mixes real datetimes and raw Excel serial floats in the
    same column (e.g. Master Tasks 'Deadline'). Both need handling."""
    if v is None:
        return None
    if isinstance(v, datetime.datetime):
        return v.date().isoformat()
    if isinstance(v, datetime.date):
        return v.isoformat()
    if isinstance(v, (int, float)):
        return (EXCEL_EPOCH + datetime.timedelta(days=v)).date().isoformat()
    return None


def excel_time_hhmm(v):
    """Meetings.Time is a day-fraction float (0.375 = 09:00)."""
    if v is None:
        return None
    if isinstance(v, datetime.time):
        return v.strftime("%H:%M")
    if isinstance(v, (int, float)):
        total_minutes = round(v * 24 * 60)
        return f"{total_minutes // 60:02d}:{total_minutes % 60:02d}"
    return None


def iso(v):
    if v is None:
        return None
    if isinstance(v, datetime.datetime):
        return v.isoformat()
    if isinstance(v, str):
        return v
    return str(v)


def clean_str(v):
    """openpyxl returns numeric cells as Python floats even for whole
    numbers (Members Count, Staff Size, Duration_Mins, ...), which
    str()s to '12.0' — invalid input for any integer-typed target
    column. Whole-number floats are rendered without the decimal;
    everything else round-trips through str() unchanged."""
    if v is None:
        return None
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    s = str(v).strip()
    return s if s else None


def non_empty_rows(ws):
    rows = list(ws.iter_rows(values_only=True))
    header = rows[0]
    data = [r for r in rows[1:] if any(c is not None and str(c).strip() != "" for c in r)]
    return header, [dict(zip(header, r)) for r in data]


PRIORITY_MAP = {
    "urgent": "urgent", "critical": "urgent",
    "high": "high",
    "medium": "medium",
    "low": "low",
}

STATUS_MAP = {
    "not started": "not_started",
    "in progress": "in_progress",
    "blocked": "blocked",
    "done": "done", "completed": "done",
}


def norm_priority(v):
    """DECISION (this session): 'Critical' (not in the new urgent/high/
    medium/low vocabulary) maps to 'urgent' — it's the same
    highest-tier concept under a different label the legacy sheet used
    inconsistently across its own history."""
    if not v:
        return "medium"
    return PRIORITY_MAP.get(str(v).strip().lower(), "medium")


def norm_status(v):
    if not v:
        return "not_started"
    return STATUS_MAP.get(str(v).strip().lower(), "not_started")


def extract_team_members(wb):
    _, rows = non_empty_rows(wb["9. Team Members"])
    out = []
    for r in rows:
        out.append({
            "name": clean_str(r["Name"]),
            "email": clean_str(r["Email"]),
            "role_title": clean_str(r["Role"]),
            "department": clean_str(r["Department"]),
            "eod_days": clean_str(r["EOD_Days"]),
            "notes": clean_str(r["Notes"]),
            "trusted_master_tasks": r.get("Trusted_MasterTasks") == "Y",
            "trusted_cos": r.get("Trusted_COS") == "Y",
            "trusted_partnerships": r.get("Trusted_Partnerships") == "Y",
            "trusted_new_button": r.get("Trusted_NewButton") == "Y",
            "status": clean_str(r["Status"]) or "Active",
        })
    return out


def extract_master_tasks(wb):
    """Confirmed real problems in this sheet, each handled explicitly:

    OBVIOUS: one row (ID='ID') is the sheet's own header re-pasted as a
    data row — dropped, not imported as a task.

    DECISION (this session, "richer demo" call): T001-T006 are
    generic/placeholder rows (Daniel/Sarah/Grace/Michael @example.com,
    not real ABION team members) — included anyway per that decision.
    One of them (T005) has a source-file comma-split corruption
    ('"Test login' / 'notifications and reporting"' split across Notes
    and Proof Link) — reassembled into a single Notes string here since
    the split was clearly accidental, not two real values.

    DECISION (this session): row TASK-1787398482381 ('Onboarding:
    Nife') has shifted columns — Assigned_To_Email holds a status
    string, Notes holds an email, Support_Person_Email holds a
    timestamp. Best-effort reconstructed: the email that ended up in
    Notes is moved to Assigned_To_Email (it matches the real Ayo T.
    Joshua record); the stray status/timestamp values are dropped since
    they duplicate or don't belong to this row.

    DECISION (this session): NAS-001 and NAS-002 each appear twice as
    real, distinct tasks (not duplicates of each other) sharing a
    department counter. Second occurrence's legacy id gets a '-b'
    suffix so Depends-On references stay unambiguous.

    Rows '1-...' (three of them) are real converted Master Tasks
    produced by approving two Pending AI Task proposals under
    GOAL-1786436415870 — see extract_goals(). Kept exactly as-is; the
    apparent duplicate between the two '1786823...' rows is itself a
    real historical bug (the approval action created two Master Tasks
    from one approved proposal, ~2ms apart) preserved intentionally as
    real history, not deduplicated away.
    """
    _, rows = non_empty_rows(wb["1. Master Tasks"])
    out = []
    seen_ids = {}
    for r in rows:
        rid = clean_str(r["ID"])
        if rid == "ID":  # OBVIOUS: re-pasted header row
            continue

        legacy_id = rid
        if rid in seen_ids:
            legacy_id = f"{rid}-b"
        seen_ids[rid] = seen_ids.get(rid, 0) + 1

        assigned_to_email = clean_str(r.get("Assigned_To_Email"))
        notes = clean_str(r.get("Notes"))
        proof_link = clean_str(r.get("Proof Link"))
        support_person_email = clean_str(r.get("Support_Person_Email"))

        if rid == "TASK-1787398482381":  # shifted-column reconstruction
            assigned_to_email = "othnielemry@gmail.com"  # was in Notes; matches Ayo's real address
            notes = None  # the value here was actually the email, now moved above
            support_person_email = None  # stray timestamp, no real support person on this row

        if rid == "T005":  # comma-split corruption reassembly
            notes = "Test login, notifications and reporting"
            proof_link = None

        out.append({
            "legacy_id": legacy_id,
            "title": clean_str(r["Task Description"]),
            "priority": norm_priority(r.get("Priority")),
            "status": norm_status(r.get("Status")),
            "assigned_to_name": clean_str(r.get("Assigned To")),
            "assigned_to_email": assigned_to_email,
            "support_person_name": clean_str(r.get("Support Person")),
            "support_person_email": support_person_email,
            "business_dept": clean_str(r.get("Business / Dept")),
            "start_date": excel_date(r.get("Start Date")),
            "deadline": excel_date(r.get("Deadline")),
            "notes": notes,
            "proof_link": proof_link,
            "depends_on_legacy_id": clean_str(r.get("Depends On")),
            "supervisor_name": clean_str(r.get("Supervisor")),
        })
    return out


def extract_goals_and_pending(wb):
    """Goal_ID / TaskIDs / Depends_On_Index are real cross-references —
    resolved by string match here, not guessed. Two Pending AI Tasks
    under GOAL-1786436415870 were historically approved and converted
    into real Master Tasks (rows '1-1786436599043', '1-1786823899429',
    '1-1786823902084' — the second proposal produced two Master Tasks
    due to a real approval-flow bug, kept as real history)."""
    _, goal_rows = non_empty_rows(wb["19. Goals"])
    _, pat_rows = non_empty_rows(wb["16. Pending AI Tasks"])

    goals = []
    for g in goal_rows:
        goal_id = clean_str(g["ID"])
        pending = [p for p in pat_rows if clean_str(p.get("Goal_ID")) == goal_id]
        pending.sort(key=lambda p: clean_str(p["ID"]))  # stable order matching Depends_On_Index
        proposed = []
        for p in pending:
            proposed.append({
                "legacy_id": clean_str(p["ID"]),
                "title": clean_str(p["Task Description"]),
                "priority": norm_priority(p.get("Priority")),
                "suggested_assignee_name": clean_str(p.get("Matched Assignee") or p.get("Suggested Assignee")),
                "status": clean_str(p.get("Status")) or "Pending",
                "depends_on_index": int(p["Depends_On_Index"]) if p.get("Depends_On_Index") is not None else None,
                "reviewed_by_name": clean_str(p.get("Reviewed_By")),
                "reviewed_at": iso(p.get("Reviewed_At")),
                "created_at": iso(p.get("Created_At")),
            })
        goals.append({
            "legacy_id": goal_id,
            "title": clean_str(g["Description"]),
            "created_by_name": clean_str(g["CreatedBy"]),
            "created_at": iso(g.get("CreatedAt")),
            "status": clean_str(g.get("Status")) or "Active",
            "task_ids": [t.strip() for t in (g.get("TaskIDs") or "").split(",") if t.strip()],
            "reasoning_by_task": None,  # per-goal Reasoning is on the goal row, not per-task — see below
            "notes": clean_str(g.get("Notes")),
            "reasoning": clean_str(g.get("Reasoning")),
            "proposed_tasks": proposed,
        })
    return goals


def extract_simple(wb, sheet, mapping, extra=None):
    """Generic column-rename + date-normalize extractor for the
    straightforward sheets (no cross-reference resolution needed)."""
    _, rows = non_empty_rows(wb[sheet])
    out = []
    for r in rows:
        item = {}
        for src_col, (dst_key, kind) in mapping.items():
            v = r.get(src_col)
            if kind == "date":
                v = excel_date(v)
            elif kind == "iso":
                v = iso(v)
            elif kind == "bool_y":
                v = v == "Y" or v == "Yes" or v is True
            elif kind == "bool_true":
                v = str(v).strip().upper() == "TRUE" or v is True
            else:
                v = clean_str(v)
            item[dst_key] = v
        if extra:
            extra(item, r)
        out.append(item)
    return out


def main():
    wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)

    data = {
        "team_members": extract_team_members(wb),
        "master_tasks": extract_master_tasks(wb),
        "goals": extract_goals_and_pending(wb),

        "network_cos": extract_simple(wb, "2. COS", {
            "State": ("state", "str"), "Admin Name": ("admin_name", "str"),
            "Admin Phone": ("admin_phone", "str"), "Admin Email": ("admin_email", "str"),
            "WhatsApp Group Created": ("whatsapp_group_created", "bool_y"),
            "Members Count": ("members_count", "str"),
            "Status": ("status", "str"), "Last Report Date": ("last_report_date", "date"),
            "Notes": ("notes", "str"),
        }),

        "partnerships": extract_simple(wb, "3. Partnerships", {
            "Assigned To": ("assigned_to_name", "str"), "Organisation": ("organisation", "str"),
            "Contact Name": ("contact_name", "str"), "Contact Email": ("contact_email", "str"),
            "Category": ("category", "str"), "Current Status": ("current_status", "str"),
            "Last Contact Date": ("last_contact_date", "date"),
            "Follow-Up Date": ("follow_up_date", "date"), "Document Status": ("document_status", "str"),
            "Remarks": ("remarks", "str"),
        }, extra=lambda item, r: item.update({
            # DECISION: legacy free-text status values normalized to the
            # target check-constraint vocabulary (not_started/
            # in_discussion/negotiating/cold/active/declined) and
            # (not_started/draft_sent/under_review/signed/na).
            "current_status": {
                "active": "active", "cold": "cold", "in progress": "negotiating",
                "in discussion": "in_discussion",
            }.get((item["current_status"] or "").lower(), "not_started"),
            "document_status": {
                "draft sent": "draft_sent", "under review": "under_review",
                "application submitted": "under_review", "none": "not_started",
            }.get((item["document_status"] or "").lower(), "not_started"),
        })),

        "org_contacts": extract_simple(wb, "4. Org Database", {
            "Visitor Name": ("visitor_name", "str"), "Position": ("position", "str"),
            "Company/Org": ("company_org", "str"), "Email": ("email", "str"),
            "Phone": ("phone", "str"), "State": ("state", "str"),
            "Staff Size": ("staff_size", "str"), "Date Visited": ("date_visited", "date"),
            "Contact Owner": ("contact_owner_name", "str"), "Letter Status": ("letter_status", "str"),
            "Onboarding Status": ("onboarding_status", "str"), "Follow-Up Date": ("follow_up_date", "date"),
            "Notes": ("notes", "str"),
        }, extra=lambda item, r: item.update({
            "letter_status": {"sent": "sent", "acknowledged": "acknowledged"}.get(
                (item["letter_status"] or "").lower(), "not_sent"),
            # target check constraint is (pending/in_progress/active/
            # declined) — legacy 'Not Started' has no exact match;
            # DECISION: maps to 'pending' (nothing has begun yet, same
            # real-world state as the legacy 'Not Started' label).
            "onboarding_status": {
                "in progress": "in_progress", "active": "active", "declined": "declined",
            }.get((item["onboarding_status"] or "").lower(), "pending"),
        })),

        "eod_logs": extract_simple(wb, "5. KPI Log", {
            "Date": ("date", "date"), "Team Member": ("user_name", "str"),
            "What I Completed (with proof)": ("completed", "str"),
            "What I Moved Forward": ("moved_forward", "str"),
            "Blockers": ("blockers", "str"), "Tomorrow's Plan": ("tomorrow_plan", "str"),
        }, extra=lambda item, r: item.update({
            "summary": " | ".join(filter(None, [
                f"Completed: {item.pop('completed')}" if item.get("completed") else None,
                f"Moved forward: {item.pop('moved_forward')}" if item.get("moved_forward") else None,
                f"Blockers: {item.pop('blockers')}" if item.get("blockers") else None,
                f"Tomorrow: {item.pop('tomorrow_plan')}" if item.get("tomorrow_plan") else None,
            ])),
        })),

        # DECISION: `marketing_content` has no caption/topic or notes
        # column at all (content_type/platform/due_date/status/
        # post_link/owner_user_id only) — the real Topic/Caption text
        # (each item's actual content) and Notes have nowhere to go in
        # this schema. Kept in this JSON for reference; not written to
        # any DB column by the importer. Flagged as a schema gap in the
        # seed script's run summary, not silently dropped.
        # 0034_abion_demo_seed_gaps.sql added marketing_content.caption
        # — the actual post text/copy is now persisted, not dropped.
        # Notes still has nowhere to go (no notes column on this
        # table) — genuinely not persisted, unlike caption.
        "marketing": extract_simple(wb, "6. Marketing", {
            "Content Type": ("content_type", "str"), "Topic / Caption": ("caption", "str"),
            "Platform": ("platform", "str"), "Assigned To": ("assigned_to_name", "str"),
            "Due Date": ("due_date", "date"), "Status": ("status", "str"),
            "Post Link": ("post_link", "str"), "Notes": ("notes_not_persisted", "str"),
        }),

        # 0034_abion_demo_seed_gaps.sql added agenda/invitee_user_ids/
        # external_emails as real columns on `meetings` — no folding
        # into `notes` needed anymore. Kept agenda/team_invitees/
        # external_emails as their own fields below; the importer maps
        # team_invitees (a comma list of the same Name strings every
        # other sheet uses) to real user ids itself.
        "meetings": extract_simple(wb, "7. Meetings", {
            "Meeting_ID": ("legacy_id", "str"), "Title": ("title", "str"),
            "Date": ("date", "date"), "Duration_Mins": ("duration_mins", "str"),
            "Location_Type": ("location_type_raw", "str"), "Zoom_Link": ("zoom_link", "str"),
            "Agenda": ("agenda", "str"), "Team_Invitees": ("team_invitees", "str"),
            "External_Emails": ("external_emails", "str"), "Organiser": ("organiser_name", "str"),
            "Created_At": ("created_at", "iso"),
        }, extra=lambda item, r: item.update({
            "time": excel_time_hhmm(r.get("Time")),
            "location_type": {"zoom": "zoom", "google meet": "google_meet"}.get(
                (item["location_type_raw"] or "").lower(), "physical"),
        })),

        "automation_controls": extract_simple(wb, "8. Automation Controls", {
            "Key": ("key", "str"), "Enabled": ("enabled", "bool_true"),
            "ToggledBy": ("toggled_by_name", "str"),
        }),

        "automation_log": extract_simple(wb, "13. Automation Log", {
            "Timestamp": ("timestamp", "iso"), "Key": ("control_key", "str"),
            "Enabled": ("new_value", "bool_true"), "ToggledBy": ("changed_by_name", "str"),
        }),

        "knowledge_base": extract_simple(wb, "23. Knowledge Base", {
            "Title": ("title", "str"), "Content": ("content", "str"),
            "Category": ("category", "str"), "UpdatedBy": ("updated_by_name", "str"),
        }),

        "notifications": extract_simple(wb, "18. Notifications", {
            "Recipient": ("recipient_name", "str"), "Type": ("type", "str"),
            "Title": ("title", "str"), "Body": ("body", "str"),
            "TaskID": ("task_legacy_id", "str"), "CreatedAt": ("created_at", "iso"),
            "Read": ("read", "str"),
        }, extra=lambda item, r: item.update({"read": r.get("Read") is True})),

        "task_checklists": extract_simple(wb, "17. Task Checklists", {
            "Task ID": ("task_legacy_id", "str"), "Description": ("item_text", "str"),
            "Done": ("is_done", "str"), "Created_At": ("created_at", "iso"),
            "Created_By": ("created_by_name", "str"),
        }, extra=lambda item, r: item.update({"is_done": r.get("Done") == "Y"})),

        "chat_messages": extract_simple(wb, "10. Chat Messages", {
            "Channel": ("channel", "str"), "TaskID": ("task_legacy_id", "str"),
            "Author": ("author_name", "str"), "Message": ("body", "str"),
            "Timestamp": ("created_at", "iso"),
        }, extra=lambda item, r: item.update({
            # Legacy 'team'/'task' map directly; anything else (e.g. a
            # bare task legacy id used as its own channel name in
            # Chat Read State) is handled at the read-state extractor
            # below, not here.
            "channel": "task" if item["channel"] not in ("team", "ai") else item["channel"],
        })),

        "chat_read_state": extract_simple(wb, "12. Chat Read State", {
            "Name": ("user_name", "str"), "Channel": ("channel_raw", "str"),
            "LastReadTimestamp": ("last_read_at", "iso"),
        }, extra=lambda item, r: item.update({
            # DECISION: legacy Channel is either the literal 'team' or a
            # task's legacy ID used directly as the channel name — this
            # sheet has no separate 'ai' channel usage. Split here so
            # the importer can resolve task_legacy_id -> task_id.
            "channel": "team" if item["channel_raw"] == "team" else "task",
            "task_legacy_id": None if item["channel_raw"] == "team" else item["channel_raw"],
        })),

        "leave_requests": extract_simple(wb, "21. Leave Requests", {
            "Name": ("user_name", "str"), "StartDate": ("start_date", "date"),
            "EndDate": ("end_date", "date"), "Reason": ("reason", "str"),
            "Status": ("status", "str"), "ApprovedBy": ("approved_by_name", "str"),
            "DecidedAt": ("decided_at", "iso"),
        }, extra=lambda item, r: item.update({"status": (item["status"] or "pending").lower()})),

        "permission_log": extract_simple(wb, "15. Permission Log", {
            "Timestamp": ("changed_at", "iso"), "GrantedBy": ("changed_by_name", "str"),
            "GrantedTo": ("target_name", "str"), "Tab": ("resource", "str"),
        }, extra=lambda item, r: item.update({"action": "update", "granted": True})),

        "activity_log": extract_simple(wb, "14. Auto Activity", {
            "Timestamp": ("changed_at", "iso"), "Team Member": ("actor_name", "str"),
            "Task ID": ("task_legacy_id", "str"), "Field": ("field", "str"),
            "Old Value": ("old_value", "str"), "New Value": ("new_value", "str"),
        }),

        "email_accounts": extract_simple(wb, "10. Resend Accounts", {
            "Priority": ("priority", "str"), "From_Email": ("email_address", "str"),
            "Daily_Limit": ("daily_limit", "str"), "Used_Today": ("used_today", "str"),
            "Last_Reset_Date": ("last_reset_date", "date"), "Enabled": ("enabled", "bool_true"),
        }),

        # Not in "9. Team Members" at all — a genuinely separate roster
        # (PRD §3: interns are "tracked in the Interns sheet", distinct
        # from the Team Members list). The importer creates real user
        # rows (role='intern') for whichever names appear here.
        "interns": extract_simple(wb, "10. Interns", {
            "Date": ("date", "date"), "Intern Name": ("intern_name", "str"),
            "Task / Activity": ("activity", "str"), "Status": ("status", "str"),
            "Proof Link": ("proof_link", "str"), "Supervisor Notes": ("supervisor_notes", "str"),
        }),

        # DECISION (this session): 'Push Subscriptions' rows are
        # literal '[registered at runtime]' placeholders, not real
        # subscription keys — not imported.
    }

    OUT.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    print(f"Wrote {OUT} — " + ", ".join(f"{k}={len(v)}" for k, v in data.items()))


if __name__ == "__main__":
    main()
