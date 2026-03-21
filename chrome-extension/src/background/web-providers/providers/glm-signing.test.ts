/**
 * Tests for glm-signing.ts — MD5 and GLM sign generation.
 */
import { describe, it, expect } from 'vitest';
import { md5, generateGlmSign } from './glm-signing';

describe('md5', () => {
  it('computes correct hash for empty string', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('computes correct hash for "hello"', () => {
    expect(md5('hello')).toBe('5d41402abc4b2a76b9719d911017c592');
  });

  it('computes correct hash for a signing-like input', () => {
    const result = md5('1234567890-abcdef-secret');
    expect(result).toHaveLength(32);
    expect(result).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('generateGlmSign', () => {
  it('returns timestamp, nonce, and 32-char hex sign', () => {
    const { timestamp, nonce, sign } = generateGlmSign();
    expect(timestamp).toBeTruthy();
    expect(nonce).toHaveLength(32);
    expect(sign).toMatch(/^[0-9a-f]{32}$/);
  });
});
