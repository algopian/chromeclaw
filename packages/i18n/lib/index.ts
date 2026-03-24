// Runtime translation engine (supports runtime language switching)
export { t, setLocale, subscribe, getLocale, initLocale, LOCALE_OPTIONS, LOCALE_LABELS } from './i18n-runtime.js';
export type { LocaleCode } from './i18n-runtime.js';

// React bindings
export { LocaleProvider, useT, LocaleContext } from './react.js';
export type { TFunction } from './react.js';

// Re-export types
export type { MessageKeyType } from './types.js';
