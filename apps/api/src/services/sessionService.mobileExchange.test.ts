import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMobileExchangeCode, consumeMobileExchangeCode } from './sessionService.js';

// PRD §16 — covers only the in-memory exchange-code bridge described in
// sessionService.ts's own header comment. createSession/verifySession
// etc. need a live Postgres and are exercised elsewhere; this file is
// deliberately DB-free so it runs in any environment.
describe('mobile OAuth exchange code', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('redeems a freshly minted code for its token', () => {
    const code = createMobileExchangeCode('session-token-abc');
    expect(consumeMobileExchangeCode(code)).toBe('session-token-abc');
  });

  it('cannot be redeemed twice', () => {
    const code = createMobileExchangeCode('session-token-abc');
    consumeMobileExchangeCode(code);
    expect(consumeMobileExchangeCode(code)).toBeNull();
  });

  it('rejects an unknown code', () => {
    expect(consumeMobileExchangeCode('not-a-real-code')).toBeNull();
  });

  it('expires after the TTL window', () => {
    vi.useFakeTimers();
    const code = createMobileExchangeCode('session-token-abc');
    vi.advanceTimersByTime(61_000); // TTL is 60s (MOBILE_EXCHANGE_TTL_MS)
    expect(consumeMobileExchangeCode(code)).toBeNull();
  });

  it('two codes for two different tokens redeem independently', () => {
    const codeA = createMobileExchangeCode('token-a');
    const codeB = createMobileExchangeCode('token-b');
    expect(consumeMobileExchangeCode(codeA)).toBe('token-a');
    expect(consumeMobileExchangeCode(codeB)).toBe('token-b');
  });
});
