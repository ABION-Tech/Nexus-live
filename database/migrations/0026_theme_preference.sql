-- Session 50 — light/dark theme toggle. PRD §14 Design System gestures
-- at this ("the MVP's existing data-theme dark/light approach is a good
-- starting point") but nothing implemented it before this migration —
-- no theme column, no toggle UI, nothing.
--
-- Stored on `users` (not a separate preferences table) — this is the
-- only per-user preference this codebase has right now, and a
-- one-column addition to an existing row doesn't earn a new table the
-- way a growing set of preferences eventually would (same "abstract
-- repeated things, not hypothetical future things" reasoning
-- companyArchiveCache.ts's own header comment argues from, applied to
-- schema this time rather than to an IndexedDB wrapper).
--
-- Default 'dark' matches this app's actual default rendering today
-- (tokens.css's :root block IS the dark palette, unconditionally, until
-- this session's [data-theme='light'] override exists) — a fresh row
-- with no explicit preference should render exactly what every existing
-- user already sees, not silently flip anyone into a palette that
-- didn't exist yesterday.
alter table users
  add column theme_preference text not null default 'dark'
    check (theme_preference in ('light', 'dark'));
