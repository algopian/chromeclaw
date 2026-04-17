// Unit tests for heartbeat prompt helpers (R20 / 02.27).

import { describe, expect, it } from 'vitest';
import {
  HEARTBEAT_TOKEN,
  isHeartbeatContentEffectivelyEmpty,
  resolveHeartbeatPrompt,
  stripHeartbeatToken,
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
} from './prompt';

describe('isHeartbeatContentEffectivelyEmpty', () => {
  it('treats missing / whitespace-only content as empty', () => {
    expect(isHeartbeatContentEffectivelyEmpty('')).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty('   \n  \n')).toBe(true);
  });

  it('skips markdown headers and empty list markers', () => {
    expect(
      isHeartbeatContentEffectivelyEmpty('# Heading\n\n## Sub\n\n- [ ]\n* '),
    ).toBe(true);
  });

  it('detects real content', () => {
    expect(isHeartbeatContentEffectivelyEmpty('- [ ] do the thing')).toBe(false);
    expect(isHeartbeatContentEffectivelyEmpty('remind me in 5m')).toBe(false);
  });

  it('returns false for null / undefined (LLM decides)', () => {
    expect(isHeartbeatContentEffectivelyEmpty(undefined)).toBe(false);
    expect(isHeartbeatContentEffectivelyEmpty(null)).toBe(false);
  });
});

describe('resolveHeartbeatPrompt', () => {
  it('uses default on empty input', () => {
    expect(resolveHeartbeatPrompt()).toMatch(/HEARTBEAT_OK/);
    expect(resolveHeartbeatPrompt('   ')).toMatch(/HEARTBEAT_OK/);
  });
  it('keeps a custom prompt trimmed', () => {
    expect(resolveHeartbeatPrompt('  custom  ')).toBe('custom');
  });
});

describe('stripHeartbeatToken', () => {
  it('reports shouldSkip for plain ack', () => {
    const r = stripHeartbeatToken(HEARTBEAT_TOKEN);
    expect(r.shouldSkip).toBe(true);
    expect(r.didStrip).toBe(true);
  });

  it('strips HTML-wrapped ack', () => {
    const r = stripHeartbeatToken(`<b>${HEARTBEAT_TOKEN}</b>`);
    expect(r.shouldSkip).toBe(true);
    expect(r.didStrip).toBe(true);
  });

  it('strips markdown-wrapped ack', () => {
    const r = stripHeartbeatToken(`**${HEARTBEAT_TOKEN}**`, { mode: 'heartbeat' });
    expect(r.shouldSkip).toBe(true);
    expect(r.didStrip).toBe(true);
  });

  it('keeps text when token is followed by long content in heartbeat mode', () => {
    const longBody = 'x'.repeat(DEFAULT_HEARTBEAT_ACK_MAX_CHARS + 50);
    const r = stripHeartbeatToken(`${HEARTBEAT_TOKEN}\n${longBody}`, {
      mode: 'heartbeat',
    });
    expect(r.shouldSkip).toBe(false);
    expect(r.text).toContain('x');
    expect(r.didStrip).toBe(true);
  });

  it('skips trailing punctuation after token', () => {
    const r = stripHeartbeatToken(`${HEARTBEAT_TOKEN}!!!`, { mode: 'heartbeat' });
    expect(r.shouldSkip).toBe(true);
  });

  it('returns original text when token absent', () => {
    const r = stripHeartbeatToken('just a normal response');
    expect(r.didStrip).toBe(false);
    expect(r.shouldSkip).toBe(false);
    expect(r.text).toBe('just a normal response');
  });
});
