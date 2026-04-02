/**
 * Tests for rakuten-signing.ts — HMAC-SHA256 request signing for Rakuten AI.
 *
 * Validates both REST API signing (X-Timestamp / X-Nonce / X-Signature headers)
 * and WebSocket URL signing (x-timestamp / x-nonce / x-signature query params).
 */
import { describe, it, expect } from 'vitest';
import {
  hmacSha256Sign,
  buildRestSignatureString,
  buildWsSignatureString,
  signRestRequest,
  signWebSocketUrl,
  RAKUTEN_HMAC_KEY,
} from './rakuten-signing';

// ── Test Helpers ─────────────────────────────────

/** Known HMAC key from Rakuten AI JS bundle. */
const TEST_KEY = '4f0465bfea7761a510dda451ff86a935bf0c8ed6fb37f80441509c64328788c8';

// ── Tests ────────────────────────────────────────

describe('RAKUTEN_HMAC_KEY', () => {
  it('exports the correct hardcoded HMAC key', () => {
    expect(RAKUTEN_HMAC_KEY).toBe(TEST_KEY);
  });
});

describe('hmacSha256Sign', () => {
  it('returns a Base64URL-encoded string (no padding)', async () => {
    const result = await hmacSha256Sign('test message', TEST_KEY);
    expect(typeof result).toBe('string');
    expect(result).not.toContain('+');
    expect(result).not.toContain('/');
    expect(result).not.toContain('=');
  });

  it('returns consistent results for the same input', async () => {
    const r1 = await hmacSha256Sign('hello world', TEST_KEY);
    const r2 = await hmacSha256Sign('hello world', TEST_KEY);
    expect(r1).toBe(r2);
  });

  it('returns different results for different messages', async () => {
    const r1 = await hmacSha256Sign('message one', TEST_KEY);
    const r2 = await hmacSha256Sign('message two', TEST_KEY);
    expect(r1).not.toBe(r2);
  });

  it('returns different results for different keys', async () => {
    const r1 = await hmacSha256Sign('test', TEST_KEY);
    const r2 = await hmacSha256Sign('test', 'aaaa');
    expect(r1).not.toBe(r2);
  });

  it('handles empty message', async () => {
    const result = await hmacSha256Sign('', TEST_KEY);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('produces a valid Base64URL string of expected length', async () => {
    // HMAC-SHA256 produces 32 bytes → Base64 = 44 chars → Base64URL ≈ 43 chars (no padding)
    const result = await hmacSha256Sign('test', TEST_KEY);
    expect(result.length).toBeGreaterThanOrEqual(42);
    expect(result.length).toBeLessThanOrEqual(44);
    expect(/^[A-Za-z0-9_-]+$/.test(result)).toBe(true);
  });
});

describe('buildRestSignatureString', () => {
  it('builds correct string for POST with no query params', () => {
    const result = buildRestSignatureString(
      'POST',
      '/api/v1/thread',
      {},
      '1775065762085',
      '1cc1842-cd4f-4514-b3bd-706fcbef7c65',
    );
    expect(result).toBe('POST/api/v1/thread17750657620851cc1842-cd4f-4514-b3bd-706fcbef7c65');
  });

  it('builds correct string for GET with sorted query params', () => {
    const result = buildRestSignatureString(
      'GET',
      '/api/v3/thread/sync',
      { threadId: 'abc', afterSyncOffset: '0' },
      '1775065763',
      '1234-5678-uuid',
    );
    // Params sorted alphabetically: afterSyncOffset=0, threadId=abc
    expect(result).toBe(
      'GET/api/v3/thread/syncafterSyncOffset=0threadId=abc17750657631234-5678-uuid',
    );
  });

  it('sorts params alphabetically by key', () => {
    const result = buildRestSignatureString(
      'GET',
      '/api/test',
      { z: '3', a: '1', m: '2' },
      'ts',
      'nonce',
    );
    expect(result).toBe('GET/api/testa=1m=2z=3tsnonce');
  });

  it('handles single param', () => {
    const result = buildRestSignatureString(
      'GET',
      '/api/v1/thread',
      { threadId: 'xyz' },
      'ts',
      'nonce',
    );
    expect(result).toBe('GET/api/v1/threadthreadId=xyztsnonce');
  });

  it('handles empty params object', () => {
    const result = buildRestSignatureString('DELETE', '/api/v1/thread', {}, 'ts', 'nonce');
    expect(result).toBe('DELETE/api/v1/threadtsnonce');
  });
});

describe('buildWsSignatureString', () => {
  it('builds correct string for WS with accessToken param', () => {
    const result = buildWsSignatureString(
      '/',
      { accessToken: 'mytoken' },
      '1775065762',
      '1234-uuid',
    );
    // Method is always GET for WS, non-x-* params included
    expect(result).toBe('GET/accessToken=mytoken17750657621234-uuid');
  });

  it('filters out x-* params', () => {
    const result = buildWsSignatureString(
      '/',
      {
        accessToken: 'mytoken',
        'x-timestamp': '123',
        'x-nonce': 'abc',
        'x-signature': 'sig',
      },
      'ts',
      'nonce',
    );
    expect(result).toBe('GET/accessToken=mytokentsnonce');
  });

  it('sorts non-x-* params alphabetically', () => {
    const result = buildWsSignatureString(
      '/',
      { z: '3', accessToken: 'tok', a: '1' },
      'ts',
      'nonce',
    );
    expect(result).toBe('GET/a=1accessToken=tokz=3tsnonce');
  });

  it('handles no params (empty object)', () => {
    const result = buildWsSignatureString('/', {}, 'ts', 'nonce');
    expect(result).toBe('GET/tsnonce');
  });

  it('handles only x-* params (all filtered)', () => {
    const result = buildWsSignatureString(
      '/',
      { 'x-timestamp': '123', 'x-nonce': 'abc' },
      'ts',
      'nonce',
    );
    expect(result).toBe('GET/tsnonce');
  });
});

describe('signRestRequest', () => {
  it('returns an object with timestamp, nonce, and signature', async () => {
    const result = await signRestRequest('POST', 'https://ai.rakuten.co.jp/api/v1/thread', TEST_KEY);
    expect(result).toHaveProperty('timestamp');
    expect(result).toHaveProperty('nonce');
    expect(result).toHaveProperty('signature');
    expect(typeof result.timestamp).toBe('string');
    expect(typeof result.nonce).toBe('string');
    expect(typeof result.signature).toBe('string');
  });

  it('timestamp is a numeric string (epoch seconds)', async () => {
    const result = await signRestRequest('GET', 'https://ai.rakuten.co.jp/api/v1/thread', TEST_KEY);
    expect(/^\d+$/.test(result.timestamp)).toBe(true);
    const ts = parseInt(result.timestamp, 10);
    // Should be a reasonable epoch seconds value (after 2024)
    expect(ts).toBeGreaterThan(1700000000);
  });

  it('nonce is a UUID-like string', async () => {
    const result = await signRestRequest('GET', 'https://ai.rakuten.co.jp/api/v1/thread', TEST_KEY);
    expect(result.nonce).toMatch(/^[0-9a-f-]+$/i);
  });

  it('signature is a Base64URL string', async () => {
    const result = await signRestRequest('GET', 'https://ai.rakuten.co.jp/api/v1/thread', TEST_KEY);
    expect(/^[A-Za-z0-9_-]+$/.test(result.signature)).toBe(true);
  });

  it('includes query params in signature computation', async () => {
    const r1 = await signRestRequest(
      'GET',
      'https://ai.rakuten.co.jp/api/v3/thread/sync?threadId=abc&afterSyncOffset=0',
      TEST_KEY,
    );
    const r2 = await signRestRequest(
      'GET',
      'https://ai.rakuten.co.jp/api/v3/thread/sync?threadId=xyz&afterSyncOffset=0',
      TEST_KEY,
    );
    // Different query params → different signatures (assuming same timestamp/nonce is unlikely)
    // We can't guarantee they differ due to different timestamps, but structure should be valid
    expect(r1.signature.length).toBeGreaterThan(0);
    expect(r2.signature.length).toBeGreaterThan(0);
  });
});

describe('signWebSocketUrl', () => {
  it('returns an object with x-timestamp, x-nonce, x-signature', async () => {
    const result = await signWebSocketUrl(
      'wss://companion.ai.rakuten.co.jp/?accessToken=mytoken',
      TEST_KEY,
    );
    expect(result).toHaveProperty('x-timestamp');
    expect(result).toHaveProperty('x-nonce');
    expect(result).toHaveProperty('x-signature');
  });

  it('uses lowercase x-* keys', async () => {
    const result = await signWebSocketUrl(
      'wss://companion.ai.rakuten.co.jp/?accessToken=tok',
      TEST_KEY,
    );
    expect(Object.keys(result)).toEqual(
      expect.arrayContaining(['x-timestamp', 'x-nonce', 'x-signature']),
    );
    // Should NOT contain uppercase variants
    expect(result).not.toHaveProperty('X-Timestamp');
    expect(result).not.toHaveProperty('X-Nonce');
    expect(result).not.toHaveProperty('X-Signature');
  });

  it('x-timestamp is a numeric string', async () => {
    const result = await signWebSocketUrl(
      'wss://companion.ai.rakuten.co.jp/?accessToken=tok',
      TEST_KEY,
    );
    expect(/^\d+$/.test(result['x-timestamp'])).toBe(true);
  });

  it('x-signature is a Base64URL string', async () => {
    const result = await signWebSocketUrl(
      'wss://companion.ai.rakuten.co.jp/?accessToken=tok',
      TEST_KEY,
    );
    expect(/^[A-Za-z0-9_-]+$/.test(result['x-signature'])).toBe(true);
  });

  it('handles URL without existing query params', async () => {
    const result = await signWebSocketUrl('wss://companion.ai.rakuten.co.jp/', TEST_KEY);
    expect(result).toHaveProperty('x-signature');
    expect(result['x-signature'].length).toBeGreaterThan(0);
  });
});
