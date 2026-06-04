// ──────────────────────────────────────────────
// Telegram Bot API Types (subset for Phase 1)
// ──────────────────────────────────────────────

interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TgVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

interface TgAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

interface TgVideoNote {
  file_id: string;
  file_unique_id: string;
  duration: number;
  length: number;
  file_size?: number;
}

interface TgDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  voice?: TgVoice;
  audio?: TgAudio;
  video_note?: TgVideoNote;
  document?: TgDocument;
  reply_to_message?: TgMessage;
}

interface TgGetFileResponse {
  ok: boolean;
  result?: TgFile;
  description?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

interface TgGetMeResponse {
  ok: boolean;
  result?: TgUser;
  description?: string;
}

interface TgGetUpdatesResponse {
  ok: boolean;
  result?: TgUpdate[];
  description?: string;
  parameters?: { retry_after?: number };
}

interface TgSendMessageResponse {
  ok: boolean;
  result?: TgMessage;
  description?: string;
  parameters?: { retry_after?: number };
}

export type {
  TgUser,
  TgChat,
  TgVoice,
  TgAudio,
  TgVideoNote,
  TgDocument,
  TgFile,
  TgMessage,
  TgUpdate,
  TgGetMeResponse,
  TgGetUpdatesResponse,
  TgGetFileResponse,
  TgSendMessageResponse,
};
