import type { ChannelInboundMessage } from '../types';
import type { TgUpdate } from './types';

/** Normalized result including the channel-specific offset for dedup */
interface NormalizedUpdate {
  message: ChannelInboundMessage;
  offset: number;
}

/** Convert a Telegram update to a channel-agnostic inbound message, or null if not applicable */
const normalizeTelegramUpdate = (update: TgUpdate): NormalizedUpdate | null => {
  const msg = update.message;
  if (!msg) return null;

  // Must have a sender
  if (!msg.from) return null;

  // Resolve audio-bearing media: voice notes, audio files, round video notes,
  // and audio documents (e.g. forwarded .ogg/.mp3 sent as a file). Pick the first
  // present source. Telegram only guarantees a mime_type on some of these, so fall
  // back to audio/ogg for voice notes (always Opus/OGG) where it may be omitted.
  const audioMedia: { file_id: string; mime_type?: string; fallbackMime?: string } | null = msg.voice
    ? { file_id: msg.voice.file_id, mime_type: msg.voice.mime_type, fallbackMime: 'audio/ogg' }
    : msg.audio
      ? { file_id: msg.audio.file_id, mime_type: msg.audio.mime_type }
      : msg.video_note
        ? { file_id: msg.video_note.file_id, mime_type: 'video/mp4' }
        : msg.document && msg.document.mime_type?.startsWith('audio/')
          ? { file_id: msg.document.file_id, mime_type: msg.document.mime_type }
          : null;

  // Support text messages and audio media
  const hasText = !!msg.text;
  const hasAudioMedia = !!audioMedia;
  if (!hasText && !hasAudioMedia) return null;

  return {
    message: {
      channelMessageId: String(msg.message_id),
      channelChatId: String(msg.chat.id),
      senderId: String(msg.from.id),
      senderName: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || undefined,
      senderUsername: msg.from.username,
      body: msg.text ?? '',
      timestamp: msg.date * 1000,
      chatType: msg.chat.type === 'private' ? 'direct' : 'group',
      replyToId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
      ...(audioMedia
        ? {
            mediaFileId: audioMedia.file_id,
            mediaMimeType: audioMedia.mime_type ?? audioMedia.fallbackMime ?? 'application/octet-stream',
          }
        : {}),
    },
    offset: update.update_id,
  };
};

export { normalizeTelegramUpdate };
export type { NormalizedUpdate };
