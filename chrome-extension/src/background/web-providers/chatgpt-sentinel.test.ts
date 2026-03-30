/**
 * Tests for ChatGPT Sentinel antibot challenge resolution logic.
 *
 * The sentinel code lives inside content-fetch-main.ts (MAIN world), but the
 * proof-token resolution pattern is non-trivial and warrants explicit coverage:
 * - bm may be an enforcer with getEnforcementToken() (older API)
 * - bm may be a PoW solver object {answers, maxAttempts, requirementsSeed, sid}
 *   which should be passed directly to fX() for header building
 * - bm may be undefined/null
 *
 * These tests validate the resolution logic in isolation.
 */
import { describe, it, expect, vi } from 'vitest';

// ── Helpers ─────────────────────────────────────

/**
 * Resolve proof token from the sentinel module's bm export.
 * Mirrors the logic in content-fetch-main.ts handleChatGPT() Step 4.
 */
const resolveProofToken = async (
  bm: unknown,
  chatReqs: Record<string, unknown>,
): Promise<unknown> => {
  if (!bm || typeof bm !== 'object') return null;

  const bmObj = bm as Record<string, unknown>;

  // Pattern 1: enforcer with getEnforcementToken()
  if (typeof bmObj.getEnforcementToken === 'function') {
    return Promise.race([
      (bmObj.getEnforcementToken as (reqs: unknown) => Promise<unknown>)(chatReqs),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Proof token timed out after 15s')), 15_000),
      ),
    ]);
  }

  // Pattern 2: PoW solver object — pass directly to fX()
  if (bmObj.answers !== undefined) {
    return bm;
  }

  return null;
};

/**
 * Simulate the sentinel warmup + challenge flow.
 * Returns { headers, error } matching the pattern in content-fetch-main.ts.
 */
const resolveSentinel = async (sentinelModule: Record<string, unknown>) => {
  let sentinelHeaders: Record<string, string> = {};
  let sentinelError = '';

  try {
    if (typeof sentinelModule.bk !== 'function' || typeof sentinelModule.fX !== 'function') {
      sentinelError = 'Sentinel asset missing bk/fX exports';
      return { sentinelHeaders, sentinelError };
    }

    const chatReqs = (await (sentinelModule.bk as () => Promise<unknown>)()) as Record<
      string,
      unknown
    >;
    const turnstile = chatReqs?.turnstile as Record<string, unknown> | undefined;
    const turnstileKey = turnstile?.bx ?? turnstile?.dx;

    if (!turnstileKey) {
      sentinelError = 'Sentinel chat-requirements response missing turnstile key';
      return { sentinelHeaders, sentinelError };
    }

    let turnstileToken: unknown = null;
    try {
      if (typeof sentinelModule.bi === 'function') {
        turnstileToken = await (sentinelModule.bi as (key: unknown) => Promise<unknown>)(
          turnstileKey,
        );
      }
    } catch {
      /* continue without */
    }

    let arkoseToken: unknown = null;
    try {
      const bl = sentinelModule.bl as Record<string, unknown> | undefined;
      if (typeof bl?.getEnforcementToken === 'function') {
        arkoseToken = await (bl.getEnforcementToken as (reqs: unknown) => Promise<unknown>)(
          chatReqs,
        );
      }
    } catch {
      /* continue without */
    }

    let proofToken: unknown = null;
    try {
      proofToken = await resolveProofToken(sentinelModule.bm, chatReqs);
    } catch {
      /* continue without */
    }

    const extraHeaders = await (
      sentinelModule.fX as (...args: unknown[]) => Promise<unknown>
    )(chatReqs, arkoseToken, turnstileToken, proofToken, null);

    if (typeof extraHeaders === 'object' && extraHeaders !== null) {
      sentinelHeaders = extraHeaders as Record<string, string>;
    }
  } catch (e) {
    sentinelError = `Sentinel challenge failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  return { sentinelHeaders, sentinelError };
};

// ── Tests ────────────────────────────────────────

describe('resolveProofToken', () => {
  it('returns null when bm is undefined', async () => {
    expect(await resolveProofToken(undefined, {})).toBeNull();
  });

  it('returns null when bm is null', async () => {
    expect(await resolveProofToken(null, {})).toBeNull();
  });

  it('returns null when bm is a non-object', async () => {
    expect(await resolveProofToken('string', {})).toBeNull();
    expect(await resolveProofToken(42, {})).toBeNull();
  });

  it('returns null when bm has no known interface', async () => {
    expect(await resolveProofToken({ foo: 'bar' }, {})).toBeNull();
  });

  it('calls getEnforcementToken when available (enforcer pattern)', async () => {
    const mockEnforcer = {
      getEnforcementToken: vi.fn(async () => 'proof-token-value'),
    };
    const chatReqs = { proofofwork: { required: true, seed: '0.123', difficulty: '06340b' } };

    const result = await resolveProofToken(mockEnforcer, chatReqs);

    expect(result).toBe('proof-token-value');
    expect(mockEnforcer.getEnforcementToken).toHaveBeenCalledWith(chatReqs);
  });

  it('returns bm directly when it has answers (PoW solver pattern)', async () => {
    const powSolver = {
      answers: {},
      maxAttempts: 100,
      requirementsSeed: '0.123',
      sid: 'session-id',
    };

    const result = await resolveProofToken(powSolver, {});

    expect(result).toBe(powSolver);
  });

  it('prefers getEnforcementToken over answers when both exist', async () => {
    const hybrid = {
      getEnforcementToken: vi.fn(async () => 'enforcer-result'),
      answers: {},
    };

    const result = await resolveProofToken(hybrid, {});

    expect(result).toBe('enforcer-result');
    expect(hybrid.getEnforcementToken).toHaveBeenCalled();
  });

  it('returns bm with empty answers object', async () => {
    const powSolver = { answers: {} };
    const result = await resolveProofToken(powSolver, {});
    expect(result).toBe(powSolver);
  });

  it('returns bm with populated answers', async () => {
    const powSolver = { answers: { 'hash-1': 42 } };
    const result = await resolveProofToken(powSolver, {});
    expect(result).toBe(powSolver);
  });
});

describe('resolveSentinel', () => {
  const mockChatReqs = {
    persona: 'default',
    token: 'req-token',
    turnstile: { required: true, dx: 'turnstile-key-abc' },
    proofofwork: { required: true, seed: '0.123', difficulty: '06340b' },
  };

  it('returns error when bk is missing', async () => {
    const mod = { fX: vi.fn() };
    const { sentinelHeaders, sentinelError } = await resolveSentinel(mod);
    expect(sentinelError).toContain('missing bk/fX');
    expect(Object.keys(sentinelHeaders)).toHaveLength(0);
  });

  it('returns error when fX is missing', async () => {
    const mod = { bk: vi.fn() };
    const { sentinelHeaders, sentinelError } = await resolveSentinel(mod);
    expect(sentinelError).toContain('missing bk/fX');
  });

  it('returns error when turnstile key is missing', async () => {
    const mod = {
      bk: vi.fn(async () => ({ turnstile: {} })),
      fX: vi.fn(),
    };
    const { sentinelError } = await resolveSentinel(mod);
    expect(sentinelError).toContain('missing turnstile key');
  });

  it('produces headers with all tokens (enforcer bm)', async () => {
    const mod = {
      bk: vi.fn(async () => mockChatReqs),
      bi: vi.fn(async () => 'turnstile-token'),
      bl: { getEnforcementToken: vi.fn(async () => 'arkose-token') },
      bm: { getEnforcementToken: vi.fn(async () => 'proof-token') },
      fX: vi.fn(async (reqs: unknown, arkose: unknown, turnstile: unknown, proof: unknown) => ({
        'OpenAI-Sentinel-Chat-Requirements-Token': 'req-header',
        'OpenAI-Sentinel-Turnstile-Token': turnstile,
        'OpenAI-Sentinel-Proof-Token': proof,
      })),
    };

    const { sentinelHeaders, sentinelError } = await resolveSentinel(mod);

    expect(sentinelError).toBe('');
    expect(sentinelHeaders['OpenAI-Sentinel-Chat-Requirements-Token']).toBe('req-header');
    expect(sentinelHeaders['OpenAI-Sentinel-Turnstile-Token']).toBe('turnstile-token');
    expect(sentinelHeaders['OpenAI-Sentinel-Proof-Token']).toBe('proof-token');
    expect(mod.bm.getEnforcementToken).toHaveBeenCalledWith(mockChatReqs);
  });

  it('produces headers with PoW solver bm (answers pattern)', async () => {
    const powSolver = { answers: {}, maxAttempts: 100, requirementsSeed: '0.5', sid: 'sid-1' };
    const mod = {
      bk: vi.fn(async () => mockChatReqs),
      bi: vi.fn(async () => 'turnstile-token'),
      bm: powSolver,
      fX: vi.fn(async (_reqs: unknown, _arkose: unknown, _turnstile: unknown, proof: unknown) => ({
        'OpenAI-Sentinel-Chat-Requirements-Token': 'req-header',
        'OpenAI-Sentinel-Turnstile-Token': 'turnstile-token',
        'OpenAI-Sentinel-Proof-Token': 'pow-proof-header',
      })),
    };

    const { sentinelHeaders, sentinelError } = await resolveSentinel(mod);

    expect(sentinelError).toBe('');
    expect(sentinelHeaders['OpenAI-Sentinel-Proof-Token']).toBe('pow-proof-header');
    // fX receives the PoW solver object directly
    expect(mod.fX).toHaveBeenCalledWith(
      mockChatReqs,
      null, // arkose (bl not present)
      'turnstile-token',
      powSolver, // proof = bm object itself
      null,
    );
  });

  it('produces headers without proof when bm is absent', async () => {
    const mod = {
      bk: vi.fn(async () => mockChatReqs),
      bi: vi.fn(async () => 'turnstile-token'),
      fX: vi.fn(async () => ({
        'OpenAI-Sentinel-Chat-Requirements-Token': 'req-header',
        'OpenAI-Sentinel-Turnstile-Token': 'turnstile-token',
      })),
    };

    const { sentinelHeaders, sentinelError } = await resolveSentinel(mod);

    expect(sentinelError).toBe('');
    expect(sentinelHeaders['OpenAI-Sentinel-Proof-Token']).toBeUndefined();
    expect(mod.fX).toHaveBeenCalledWith(mockChatReqs, null, 'turnstile-token', null, null);
  });

  it('continues when turnstile solver fails', async () => {
    const mod = {
      bk: vi.fn(async () => mockChatReqs),
      bi: vi.fn(async () => {
        throw new Error('Turnstile failed');
      }),
      fX: vi.fn(async () => ({
        'OpenAI-Sentinel-Chat-Requirements-Token': 'req-header',
      })),
    };

    const { sentinelHeaders, sentinelError } = await resolveSentinel(mod);

    expect(sentinelError).toBe('');
    expect(sentinelHeaders['OpenAI-Sentinel-Chat-Requirements-Token']).toBe('req-header');
    // fX called with null turnstile token
    expect(mod.fX).toHaveBeenCalledWith(mockChatReqs, null, null, null, null);
  });

  it('continues when arkose solver fails', async () => {
    const mod = {
      bk: vi.fn(async () => mockChatReqs),
      bi: vi.fn(async () => 'turnstile-token'),
      bl: {
        getEnforcementToken: vi.fn(async () => {
          throw new Error('Arkose captcha');
        }),
      },
      fX: vi.fn(async () => ({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'req-header' })),
    };

    const { sentinelHeaders, sentinelError } = await resolveSentinel(mod);

    expect(sentinelError).toBe('');
    expect(mod.fX).toHaveBeenCalledWith(mockChatReqs, null, 'turnstile-token', null, null);
  });

  it('continues when proof solver fails', async () => {
    const mod = {
      bk: vi.fn(async () => mockChatReqs),
      bi: vi.fn(async () => 'turnstile-token'),
      bm: {
        getEnforcementToken: vi.fn(async () => {
          throw new Error('PoW failed');
        }),
      },
      fX: vi.fn(async () => ({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'req-header' })),
    };

    const { sentinelHeaders, sentinelError } = await resolveSentinel(mod);

    expect(sentinelError).toBe('');
    expect(mod.fX).toHaveBeenCalledWith(mockChatReqs, null, 'turnstile-token', null, null);
  });

  it('uses turnstile.bx when dx is absent', async () => {
    const chatReqs = {
      turnstile: { required: true, bx: 'bx-key-123' },
      proofofwork: { required: false },
    };
    const mod = {
      bk: vi.fn(async () => chatReqs),
      bi: vi.fn(async (key: unknown) => `solved-${key}`),
      fX: vi.fn(async () => ({ 'OpenAI-Sentinel-Turnstile-Token': 'result' })),
    };

    await resolveSentinel(mod);

    expect(mod.bi).toHaveBeenCalledWith('bx-key-123');
  });

  it('catches fX errors gracefully', async () => {
    const mod = {
      bk: vi.fn(async () => mockChatReqs),
      bi: vi.fn(async () => 'turnstile-token'),
      fX: vi.fn(async () => {
        throw new Error('fX exploded');
      }),
    };

    const { sentinelHeaders, sentinelError } = await resolveSentinel(mod);

    expect(sentinelError).toContain('fX exploded');
    expect(Object.keys(sentinelHeaders)).toHaveLength(0);
  });
});
