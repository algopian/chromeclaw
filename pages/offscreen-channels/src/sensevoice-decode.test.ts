import { stripSenseVoiceTokens } from './sensevoice-decode';
import { describe, expect, it } from 'vitest';

describe('stripSenseVoiceTokens', () => {
  it('strips a leading language tag', () => {
    expect(stripSenseVoiceTokens('<|en|>hello world')).toBe('hello world');
  });

  it('strips language, emotion, event and itn tags together', () => {
    const raw = '<|zh|><|NEUTRAL|><|Speech|><|woitn|>你好';
    expect(stripSenseVoiceTokens(raw)).toBe('你好');
  });

  it('converts the SentencePiece word-boundary marker to spaces', () => {
    expect(stripSenseVoiceTokens('\u2581hello\u2581world')).toBe('hello world');
  });

  it('collapses whitespace introduced by tag removal', () => {
    expect(stripSenseVoiceTokens('<|en|> hello   <|HAPPY|>  world ')).toBe('hello world');
  });

  it('returns an empty string when the input is only tags', () => {
    expect(stripSenseVoiceTokens('<|en|><|nospeech|>')).toBe('');
  });

  it('leaves plain text untouched', () => {
    expect(stripSenseVoiceTokens('just text')).toBe('just text');
  });
});
