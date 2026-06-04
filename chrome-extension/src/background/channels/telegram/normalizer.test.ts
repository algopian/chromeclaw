import { normalizeTelegramUpdate } from '../telegram/normalizer';
import { describe, expect, it } from 'vitest';
import type { TgUpdate } from '../telegram/types';

describe('normalizeTelegramUpdate', () => {
  it('converts text DM to NormalizedUpdate with message and offset', () => {
    const update: TgUpdate = {
      update_id: 1,
      message: {
        message_id: 42,
        chat: { id: 123, type: 'private' },
        from: { id: 456, is_bot: false, first_name: 'Alice', username: 'alice' },
        text: 'hello',
        date: 1700000000,
      },
    };
    const result = normalizeTelegramUpdate(update);
    expect(result).toEqual({
      message: {
        channelMessageId: '42',
        channelChatId: '123',
        senderId: '456',
        senderName: 'Alice',
        senderUsername: 'alice',
        body: 'hello',
        timestamp: 1700000000000,
        chatType: 'direct',
        replyToId: undefined,
      },
      offset: 1,
    });
  });

  it('skips updates without message', () => {
    const update: TgUpdate = { update_id: 2 };
    expect(normalizeTelegramUpdate(update)).toBeNull();
  });

  it('skips non-text messages (Phase 1)', () => {
    const update: TgUpdate = {
      update_id: 3,
      message: {
        message_id: 10,
        chat: { id: 123, type: 'private' },
        from: { id: 456, is_bot: false, first_name: 'Alice' },
        date: 1700000000,
      },
    };
    expect(normalizeTelegramUpdate(update)).toBeNull();
  });

  it('skips messages without from field', () => {
    const update: TgUpdate = {
      update_id: 4,
      message: {
        message_id: 11,
        chat: { id: 123, type: 'private' },
        text: 'hello',
        date: 1700000000,
      },
    };
    expect(normalizeTelegramUpdate(update)).toBeNull();
  });

  it('maps group chat type correctly', () => {
    const update: TgUpdate = {
      update_id: 5,
      message: {
        message_id: 12,
        chat: { id: -100123, type: 'supergroup', title: 'My Group' },
        from: { id: 456, is_bot: false, first_name: 'Alice' },
        text: 'hello group',
        date: 1700000000,
      },
    };
    const result = normalizeTelegramUpdate(update);
    expect(result?.message.chatType).toBe('group');
  });

  it('handles reply_to_message', () => {
    const update: TgUpdate = {
      update_id: 6,
      message: {
        message_id: 13,
        chat: { id: 123, type: 'private' },
        from: { id: 456, is_bot: false, first_name: 'Alice' },
        text: 'reply text',
        date: 1700000000,
        reply_to_message: {
          message_id: 10,
          chat: { id: 123, type: 'private' },
          date: 1699999000,
        },
      },
    };
    const result = normalizeTelegramUpdate(update);
    expect(result?.message.replyToId).toBe('10');
  });

  it('joins first_name and last_name for senderName', () => {
    const update: TgUpdate = {
      update_id: 7,
      message: {
        message_id: 14,
        chat: { id: 123, type: 'private' },
        from: { id: 456, is_bot: false, first_name: 'Alice', last_name: 'Smith' },
        text: 'hello',
        date: 1700000000,
      },
    };
    const result = normalizeTelegramUpdate(update);
    expect(result?.message.senderName).toBe('Alice Smith');
  });

  it('converts date from seconds to milliseconds', () => {
    const update: TgUpdate = {
      update_id: 8,
      message: {
        message_id: 15,
        chat: { id: 123, type: 'private' },
        from: { id: 456, is_bot: false, first_name: 'Alice' },
        text: 'hello',
        date: 1700000000,
      },
    };
    const result = normalizeTelegramUpdate(update);
    expect(result?.message.timestamp).toBe(1700000000000);
  });

  it('includes update_id as offset', () => {
    const update: TgUpdate = {
      update_id: 42,
      message: {
        message_id: 99,
        chat: { id: 123, type: 'private' },
        from: { id: 456, is_bot: false, first_name: 'Alice' },
        text: 'hello',
        date: 1700000000,
      },
    };
    const result = normalizeTelegramUpdate(update);
    expect(result?.offset).toBe(42);
  });

  describe('audio media detection', () => {
    const base = {
      message_id: 1,
      chat: { id: 123, type: 'private' as const },
      from: { id: 456, is_bot: false, first_name: 'Alice' },
      date: 1700000000,
    };

    it('detects voice notes, falling back to audio/ogg mime', () => {
      const result = normalizeTelegramUpdate({
        update_id: 1,
        message: { ...base, voice: { file_id: 'v1', file_unique_id: 'u', duration: 3 } },
      });
      expect(result?.message.mediaFileId).toBe('v1');
      expect(result?.message.mediaMimeType).toBe('audio/ogg');
    });

    it('detects audio files with their mime type', () => {
      const result = normalizeTelegramUpdate({
        update_id: 1,
        message: {
          ...base,
          audio: { file_id: 'a1', file_unique_id: 'u', duration: 3, mime_type: 'audio/mpeg' },
        },
      });
      expect(result?.message.mediaFileId).toBe('a1');
      expect(result?.message.mediaMimeType).toBe('audio/mpeg');
    });

    it('detects round video notes', () => {
      const result = normalizeTelegramUpdate({
        update_id: 1,
        message: {
          ...base,
          video_note: { file_id: 'vn1', file_unique_id: 'u', duration: 3, length: 240 },
        },
      });
      expect(result?.message.mediaFileId).toBe('vn1');
      expect(result?.message.mediaMimeType).toBe('video/mp4');
    });

    it('detects audio documents', () => {
      const result = normalizeTelegramUpdate({
        update_id: 1,
        message: {
          ...base,
          document: { file_id: 'd1', file_unique_id: 'u', mime_type: 'audio/wav' },
        },
      });
      expect(result?.message.mediaFileId).toBe('d1');
      expect(result?.message.mediaMimeType).toBe('audio/wav');
    });

    it('ignores non-audio documents', () => {
      const result = normalizeTelegramUpdate({
        update_id: 1,
        message: {
          ...base,
          document: { file_id: 'd1', file_unique_id: 'u', mime_type: 'application/pdf' },
        },
      });
      expect(result).toBeNull();
    });

    it('prefers voice over other media when multiple present', () => {
      const result = normalizeTelegramUpdate({
        update_id: 1,
        message: {
          ...base,
          voice: { file_id: 'v1', file_unique_id: 'u', duration: 3 },
          audio: { file_id: 'a1', file_unique_id: 'u', duration: 3, mime_type: 'audio/mpeg' },
        },
      });
      expect(result?.message.mediaFileId).toBe('v1');
    });
  });
});
