# NEXUS security review

_Session 60, 15 November 2026 (correction register item C-18). What was
checked, how, and what's left. Re-run before launch and after any change
to sign-in, permissions or the database roles._

## Summary

| Area | Result |
|---|---|
| Company isolation | **Pass.** 48 of 55 tables enforce row-level security (enabled, forced, with a policy). The other 7 are account-level by design. The app's role is not a superuser and can't bypass RLS. Checked on every push by CI (`db.integration.test.ts`). |
| Privileged database functions | **Pass after fix.** 29 `SECURITY DEFINER` functions. One could not read its table (0043, the automation outage); fixed, and CI now checks every one of them. |
| Sign-in | **Pass.** Google OAuth or password (scrypt, random salt per password, minimum 10 characters). Same answer and timing for a wrong password and an unknown email. Rate-limited per address: 10 a minute for sign-in, 5 per 10 minutes for reset links. |
| Sessions | **Pass after fix.** Opaque token in an httpOnly, Secure cookie; only a hash is stored. Expires after 60 minutes (`SESSION_TTL_MINUTES`). Log-out revokes it. **Fixed:** a password reset now signs out every other session. |
| Dev login | **Pass.** Needs `DEV_LOGIN=true` and a non-production `NODE_ENV`; production answers 404 (checked live). The variable is now blank in production. |
| Personal keys | **Pass.** Shown once, stored as a SHA-256 hash, acting as one person only, revocable. They can't reach the rest of the API or manage keys. Import scope only when chosen. |
| Payments (code) | **Pass after fix.** Paystack signature check (HMAC-SHA512). **Fixed:** a retried webhook was applied again every time; events are now claimed once (0045). Not testable end to end until Paystack keys exist. |
| Secrets at rest | **Pass after fix.** AI provider keys are now encrypted (AES-256-GCM, key only in Railway). Personal keys and session tokens were already hashed. |
| HTTP headers | **Pass.** Production sends HSTS, a strict CSP, `X-Frame-Options: SAMEORIGIN`, `nosniff` and `no-referrer` (checked live). CORS allows only the app's own origins. |
| Dependencies | **Pass (no high or critical).** `npm audit --omit=dev`: 13 → 4, all moderate. |
| Backups | **Fail: no backup has ever been taken.** Needs the five GitHub secrets (register C-02); then a restore test. |

## Fixed in this pass

1. 0043: privileged function missing a grant (every scheduled job failed).
2. 0045: Paystack retries re-applied (grace pushed back; a cancelled plan could be re-activated).
3. Password reset left other sessions signed in.
4. AI provider keys stored in plain text.
5. Fastify 5.12.1 → 5.12.8 and fast-uri 4.1.3 → 4.2.3 (high-severity advisories).
6. `xlsx` (high, no upstream fix) is now a development-only dependency. Only the one-off demo seed imports it; the server never does. It's still copied into the API image (the build copies all installed packages), so a later clean-up could drop it from the runtime stage.
7. PATCH `/tasks/:id` accepted any field in the body, including the dependency sweep's internal `preBlockStatus`. It now takes only editable fields.

## Still open

| Item | Risk | Suggested |
|---|---|---|
| No backups | High: data loss can't be undone | Owner sets the secrets (C-02); I run a restore test |
| Public Postgres TCP proxy | Medium: the database is reachable from the internet (password-protected) | Remove before paying customers |
| Sign-in throttle is per address, not per account | Medium: a slow, distributed password guess isn't stopped | Add a per-account lockout after repeated failures |
| React Router 6 (moderate advisory: open redirect via backslash links) | Low: every link in the app is internal | Upgrade to 7 after launch, with testing |
| `uuid` via Google client libraries (moderate) | Low: affects a call pattern NEXUS doesn't use | Follow upstream |
| Meeting-ingest secret stored in plain text | Low: it's matched by exact value, so it can't be randomly encrypted | Store a hash instead (next change to that webhook) |
| No error monitoring | Medium: failures are only in logs | Owner decision (C-16) |
| No external penetration test | — | Before or soon after launch |

## How to re-check

- `npm audit --omit=dev`
- CI's **database** job (real Postgres, as the app's own role): isolation, forced RLS, privileged-function grants, billing claim, task history, recurring rules.
- Live headers: `curl -sI https://app.nexusabion.com/api/v1/auth/methods`
- `GET /api/v1/auth/dev-login/users` must be 404 in production.
