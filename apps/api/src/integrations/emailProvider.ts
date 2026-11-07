// Email provider — PRD §10.3 EmailService, Provider layer (PRD §6: UI →
// Service → Provider → External API), same tier as webPushProvider.ts /
// objectStorageProvider.ts.
//
// NEXUS_LAUNCH_CHECKLIST.md P0 #2: "there is no EmailService anywhere in
// the codebase — grepped for it, nothing." This is that missing piece.
//
// Scope decision for this pass: Resend only, called via plain `fetch`
// against Resend's HTTP API — no `resend` SDK dependency added for a
// single POST call, same "don't add a dependency for one code path"
// posture guestService.ts's own header comment already takes for scrypt
// vs. bcrypt. PRD §10.3 / §5 also call for a Gmail fallback behind the
// same multi-account-rotation logic the MVP had — that's real, but it's
// a second provider implementation's worth of scope (OAuth2 for Gmail
// API sending, or SMTP credentials, plus the Resend rotation-pool table
// (Priority/Daily_Limit/Used_Today) from PRD §10.3) on top of "does any
// email go out at all today." Not built here; `EmailProvider` below is
// the seam it plugs into later without any call site changing — same
// shape as AIProvider's swappable-behind-one-interface pattern in
// aiProvider.ts. Tracked as a follow-up, not silently dropped.
//
// Mirrors aiProvider.ts's stub-fallback shape: when RESEND_API_KEY isn't
// set (local dev, or before the org/host has it configured), sending
// degrades to a logged no-op instead of a hard failure — a missing email
// provider must never be the reason an invite or guest-credential
// creation request itself fails.

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSendResult {
  sent: boolean;
  /** Present when a real provider accepted the send (Resend's message
   * id) — absent for the stub, and absent on failure. */
  providerMessageId?: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<EmailSendResult>;
}

const RESEND_API_URL = 'https://api.resend.com/emails';

function fromAddress(): string {
  // No dedicated env var introduced for this alone — EMAIL_FROM piggybacks
  // on the same "one var per concern, sensible default" posture VAPID_SUBJECT
  // takes in webPushProvider.ts. Resend requires a verified sending domain
  // in production; the placeholder below is only ever reached in a dev/test
  // environment where RESEND_API_KEY is unset anyway (StubEmailProvider),
  // or if an operator hasn't set EMAIL_FROM yet — Resend's own API will
  // reject an unverified sender at send time rather than NEXUS silently
  // mis-sending.
  return process.env.EMAIL_FROM || 'NEXUS <onboarding@resend.dev>';
}

/** Real send path. One HTTP call, no SDK — Resend's API is a single
 * `POST /emails` with a bearer token, which `fetch` covers without
 * pulling in a client library for it. */
export class ResendEmailProvider implements EmailProvider {
  constructor(private readonly apiKey: string) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddress(),
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    });

    if (!res.ok) {
      // Same "surface it, don't swallow it" posture as sendWebPush's
      // non-404/410 branch — the caller (emailService.ts) decides whether
      // a failed send should block the request or just be logged, this
      // layer's job is only to report what actually happened.
      const body = await res.text().catch(() => '');
      throw new Error(`Resend send failed (${res.status}): ${body.slice(0, 300)}`);
    }

    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { sent: true, providerMessageId: data.id };
  }
}

// No network call, no API key required — same role as aiProvider.ts's
// StubAIProvider. Logs at info level so a dev environment (or a
// production host that genuinely hasn't set RESEND_API_KEY yet) still
// shows *that* an email would have gone out and to whom, without an
// actual send.
export class StubEmailProvider implements EmailProvider {
  async send(message: EmailMessage): Promise<EmailSendResult> {
    // Deliberate console usage: this is a stand-in for a real send, and
    // callers don't have a logger instance to hand down into this layer.
    console.log(`[emailProvider:stub] would send to ${message.to}: ${message.subject}`);
    return { sent: false };
  }
}

let cachedProvider: EmailProvider | undefined;

/** Lazily selects Resend vs. the stub based on RESEND_API_KEY, cached for
 * the process lifetime — same read-once-at-first-use shape as
 * webPushProvider.ts's `ensureConfigured`, except this one can't throw
 * (a missing key is a valid, expected state here, not a misconfiguration
 * to fail loudly on) since email sending is always best-effort from the
 * caller's point of view (see emailService.ts). */
export function getEmailProvider(): EmailProvider {
  if (!cachedProvider) {
    const apiKey = process.env.RESEND_API_KEY;
    cachedProvider = apiKey ? new ResendEmailProvider(apiKey) : new StubEmailProvider();
  }
  return cachedProvider;
}

/** Test-only escape hatch, same pattern other providers in this
 * directory don't currently need (they're mocked at the module level in
 * tests instead) but this one benefits from since getEmailProvider()
 * caches — lets emailService.test.ts inject a fake without relying on
 * module-cache reset ordering. */
export function __setEmailProviderForTests(provider: EmailProvider | undefined): void {
  cachedProvider = provider;
}
