import enMessages from '../locales/en/messages.json' with { type: 'json' };
import type { MessageKeyType, I18nValueType } from './types.js';

type LocaleCode = 'auto' | 'en' | 'zh_CN' | 'zh_TW' | 'ja' | 'es' | 'de' | 'fr' | 'nl' | 'ru' | 'pt';

type MessagesMap = Record<string, I18nValueType>;

const LOCALE_LABELS: Record<Exclude<LocaleCode, 'auto'>, string> = {
  en: 'English',
  zh_CN: '\u7B80\u4F53\u4E2D\u6587',
  zh_TW: '\u7E41\u9AD4\u4E2D\u6587',
  ja: '\u65E5\u672C\u8A9E',
  es: 'Espa\u00F1ol',
  de: 'Deutsch',
  fr: 'Fran\u00E7ais',
  nl: 'Nederlands',
  ru: '\u0420\u0443\u0441\u0441\u043A\u0438\u0439',
  pt: 'Portugu\u00EAs',
};

const LOCALE_OPTIONS: { value: LocaleCode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'en', label: 'English' },
  { value: 'zh_CN', label: '\u7B80\u4F53\u4E2D\u6587' },
  { value: 'zh_TW', label: '\u7E41\u9AD4\u4E2D\u6587' },
  { value: 'ja', label: '\u65E5\u672C\u8A9E' },
  { value: 'es', label: 'Espa\u00F1ol' },
  { value: 'de', label: 'Deutsch' },
  { value: 'fr', label: 'Fran\u00E7ais' },
  { value: 'nl', label: 'Nederlands' },
  { value: 'ru', label: '\u0420\u0443\u0441\u0441\u043A\u0438\u0439' },
  { value: 'pt', label: 'Portugu\u00EAs' },
];

// Lazy-load locale files via dynamic import
const localeLoaders: Record<string, () => Promise<MessagesMap>> = {
  en: () => Promise.resolve(enMessages as unknown as MessagesMap),
  zh_CN: () => import('../locales/zh_CN/messages.json', { with: { type: 'json' } }).then(m => m.default as unknown as MessagesMap),
  zh_TW: () => import('../locales/zh_TW/messages.json', { with: { type: 'json' } }).then(m => m.default as unknown as MessagesMap),
  ja: () => import('../locales/ja/messages.json', { with: { type: 'json' } }).then(m => m.default as unknown as MessagesMap),
  es: () => import('../locales/es/messages.json', { with: { type: 'json' } }).then(m => m.default as unknown as MessagesMap),
  de: () => import('../locales/de/messages.json', { with: { type: 'json' } }).then(m => m.default as unknown as MessagesMap),
  fr: () => import('../locales/fr/messages.json', { with: { type: 'json' } }).then(m => m.default as unknown as MessagesMap),
  nl: () => import('../locales/nl/messages.json', { with: { type: 'json' } }).then(m => m.default as unknown as MessagesMap),
  ru: () => import('../locales/ru/messages.json', { with: { type: 'json' } }).then(m => m.default as unknown as MessagesMap),
  pt: () => import('../locales/pt/messages.json', { with: { type: 'json' } }).then(m => m.default as unknown as MessagesMap),
};

// Singleton state
let currentLocale: string = 'en';
let currentMessages: MessagesMap = enMessages as unknown as MessagesMap;
let pendingLocaleSeq = 0;
const listeners = new Set<() => void>();

const resolveAutoLocale = (): string => {
  const navLang = navigator.language.replace('-', '_');
  // Exact match
  if (localeLoaders[navLang]) return navLang;
  // Base language
  const base = navLang.split('_')[0];
  if (localeLoaders[base]) return base;
  // Chinese fallback
  if (base === 'zh') return 'zh_CN';
  return 'en';
};

const setLocale = async (locale: LocaleCode): Promise<void> => {
  const seq = ++pendingLocaleSeq;
  const resolved = locale === 'auto' ? resolveAutoLocale() : locale;

  if (resolved === currentLocale) return;

  const loader = localeLoaders[resolved];
  if (loader) {
    try {
      const messages = await loader();
      if (seq !== pendingLocaleSeq) return; // stale — a newer setLocale call superseded this one
      currentMessages = messages;
      currentLocale = resolved;
    } catch {
      if (seq !== pendingLocaleSeq) return;
      currentMessages = enMessages as unknown as MessagesMap;
      currentLocale = 'en';
    }
  } else {
    currentMessages = enMessages as unknown as MessagesMap;
    currentLocale = 'en';
  }

  for (const fn of listeners) fn();
};

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

const translateMessage = (message: string, entry: I18nValueType, substitutions?: string | string[]): string => {
  let result = message;

  // Handle chrome i18n style placeholders
  if (entry.placeholders) {
    for (const [key, { content }] of Object.entries(entry.placeholders)) {
      if (content) {
        result = result.replace(new RegExp(`\\$${key}\\$`, 'gi'), content);
      }
    }
  }

  if (!substitutions) {
    return result;
  } else if (Array.isArray(substitutions)) {
    return substitutions.reduce((acc, cur, idx) => acc.replaceAll(`$${idx + 1}`, cur), result);
  }

  return result.replaceAll('$1', substitutions);
};

const t = (key: MessageKeyType, substitutions?: string | string[]): string => {
  const entry = currentMessages[key] ?? (enMessages as unknown as MessagesMap)[key];
  if (!entry) return key;

  const translated = translateMessage(entry.message, entry, substitutions);
  // Remove any unreplaced $digit placeholders
  return translated.replace(/\$\d+/g, '');
};

const getLocale = (): string => currentLocale;

const initLocale = async (locale: LocaleCode): Promise<void> => {
  await setLocale(locale);
};

export { t, setLocale, subscribe, getLocale, initLocale, LOCALE_OPTIONS, LOCALE_LABELS };
export type { LocaleCode };
