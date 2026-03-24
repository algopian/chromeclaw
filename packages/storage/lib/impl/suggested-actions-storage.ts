import { createStorage, StorageEnum } from '../base/index.js';

interface SuggestedAction {
  id: string;
  label: string;
  prompt: string;
}

const localeActions: Record<string, SuggestedAction[]> = {
  en: [
    { id: '1', label: 'Help me summarize this page', prompt: 'Summarize the active tab in browser for me' },
    { id: '2', label: "What's trending in AI?", prompt: 'What are the latest AI trends?' },
    { id: '3', label: "What's the weather in San Francisco?", prompt: 'What is the weather in San Francisco?' },
    { id: '4', label: 'Help me plan a trip to Hawaii', prompt: 'Plan a 5-day trip to Hawaii for me' },
  ],
  zh_CN: [
    { id: '1', label: '帮我总结这个页面', prompt: '帮我总结浏览器当前标签页的内容' },
    { id: '2', label: 'AI最新动态是什么？', prompt: '最新的AI发展趋势是什么？' },
    { id: '3', label: '北京今天天气怎么样？', prompt: '北京今天天气怎么样？' },
    { id: '4', label: '帮我规划三亚旅行', prompt: '帮我规划一个三亚5日游行程' },
  ],
  zh_TW: [
    { id: '1', label: '幫我摘要這個頁面', prompt: '幫我摘要瀏覽器目前分頁的內容' },
    { id: '2', label: 'AI最新趨勢是什麼？', prompt: '最新的AI發展趨勢是什麼？' },
    { id: '3', label: '台北今天天氣如何？', prompt: '台北今天天氣如何？' },
    { id: '4', label: '幫我規劃墾丁旅行', prompt: '幫我規劃一個墾丁5日遊行程' },
  ],
  ja: [
    { id: '1', label: 'このページを要約して', prompt: 'ブラウザの現在のタブの内容を要約してください' },
    { id: '2', label: 'AIの最新トレンドは？', prompt: '最新のAIトレンドは何ですか？' },
    { id: '3', label: '東京の天気はどう？', prompt: '東京の今日の天気は？' },
    { id: '4', label: '京都旅行を計画して', prompt: '京都への5日間の旅行プランを立ててください' },
  ],
  es: [
    { id: '1', label: 'Resúmeme esta página', prompt: 'Resume la pestaña activa del navegador para mí' },
    { id: '2', label: '¿Qué hay de nuevo en IA?', prompt: '¿Cuáles son las últimas tendencias en IA?' },
    { id: '3', label: '¿Cómo está el clima en Madrid?', prompt: '¿Cómo está el clima en Madrid?' },
    { id: '4', label: 'Ayúdame a planear un viaje a Barcelona', prompt: 'Planifica un viaje de 5 días a Barcelona para mí' },
  ],
  de: [
    { id: '1', label: 'Fasse diese Seite zusammen', prompt: 'Fasse den aktiven Browser-Tab für mich zusammen' },
    { id: '2', label: 'Was gibt es Neues bei KI?', prompt: 'Was sind die neuesten KI-Trends?' },
    { id: '3', label: 'Wie ist das Wetter in Berlin?', prompt: 'Wie ist das Wetter in Berlin?' },
    { id: '4', label: 'Hilf mir eine Reise nach München zu planen', prompt: 'Plane eine 5-tägige Reise nach München für mich' },
  ],
  fr: [
    { id: '1', label: 'Résume-moi cette page', prompt: "Résume l'onglet actif du navigateur pour moi" },
    { id: '2', label: "Quoi de neuf en IA ?", prompt: "Quelles sont les dernières tendances en IA ?" },
    { id: '3', label: 'Quel temps fait-il à Paris ?', prompt: 'Quel temps fait-il à Paris ?' },
    { id: '4', label: 'Aide-moi à planifier un voyage à Nice', prompt: 'Planifie un voyage de 5 jours à Nice pour moi' },
  ],
  nl: [
    { id: '1', label: 'Vat deze pagina samen', prompt: 'Vat het actieve browsertabblad voor mij samen' },
    { id: '2', label: 'Wat is nieuw in AI?', prompt: 'Wat zijn de nieuwste AI-trends?' },
    { id: '3', label: 'Hoe is het weer in Amsterdam?', prompt: 'Hoe is het weer in Amsterdam?' },
    { id: '4', label: 'Help me een reis naar Barcelona plannen', prompt: 'Plan een 5-daagse reis naar Barcelona voor mij' },
  ],
  ru: [
    { id: '1', label: 'Помоги мне обобщить эту страницу', prompt: 'Сделай краткое изложение активной вкладки браузера для меня' },
    { id: '2', label: 'Что нового в мире ИИ?', prompt: 'Какие последние тренды в сфере ИИ?' },
    { id: '3', label: 'Какая погода в Москве?', prompt: 'Какая сейчас погода в Москве?' },
    { id: '4', label: 'Помоги спланировать поездку в Петербург', prompt: 'Спланируй 5-дневную поездку в Санкт-Петербург для меня' },
  ],
  pt: [
    { id: '1', label: 'Me ajude a resumir esta página', prompt: 'Resuma a aba ativa do navegador para mim' },
    { id: '2', label: 'O que há de novo em IA?', prompt: 'Quais são as últimas tendências em IA?' },
    { id: '3', label: 'Como está o clima em Lisboa?', prompt: 'Como está o clima em Lisboa?' },
    { id: '4', label: 'Me ajude a planejar uma viagem ao Rio', prompt: 'Planeje uma viagem de 5 dias ao Rio de Janeiro para mim' },
  ],
};

const getDefaultSuggestedActions = (locale?: string): SuggestedAction[] => {
  if (locale && localeActions[locale]) return localeActions[locale];
  // Try base language (e.g. 'zh_CN' → 'zh')
  if (locale) {
    const base = locale.split(/[_-]/)[0];
    if (localeActions[base]) return localeActions[base];
  }
  return localeActions['en'];
};

/** Default IDs used by locale defaults — used to detect uncustomized actions */
const DEFAULT_ACTION_IDS = new Set(['1', '2', '3', '4']);

const isDefaultActions = (actions: SuggestedAction[]): boolean => {
  if (actions.length !== 4) return false;
  return actions.every(a => DEFAULT_ACTION_IDS.has(a.id));
};

// Keep English defaults as the storage initial value (backwards compatible)
const defaultSuggestedActions = localeActions['en'];

const suggestedActionsStorage = createStorage<SuggestedAction[]>(
  'suggested-actions',
  defaultSuggestedActions,
  {
    storageEnum: StorageEnum.Local,
    liveUpdate: true,
  },
);

export type { SuggestedAction };
export { suggestedActionsStorage, defaultSuggestedActions, getDefaultSuggestedActions, isDefaultActions };
