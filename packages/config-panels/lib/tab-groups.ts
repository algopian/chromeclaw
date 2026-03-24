import { t } from '@extension/i18n';
import {
  SettingsIcon,
  BrainCircuitIcon,
  WrenchIcon,
  LightbulbIcon,
  ZapIcon,
  BarChart3Icon,
  ScrollTextIcon,
  SendIcon,
  ClockIcon,
  BotIcon,
  MessagesSquareIcon,
  MessageCircleIcon,
} from 'lucide-react';

type ConfigTabId =
  | 'general'
  | 'model'
  | 'tool'
  | 'actions'
  | 'skills'
  | 'agents'
  | 'channels'
  | 'cron'
  | 'sessions'
  | 'usage'
  | 'logs'
  | 'community';

type ConfigTabGroup = {
  label: string;
  tabs: { id: ConfigTabId; label: string; icon: React.ComponentType<{ className?: string }> }[];
};

const getConfigTabGroups = (): ConfigTabGroup[] => [
  {
    label: t('tabGroup_control'),
    tabs: [
      { id: 'channels', label: t('tab_channels'), icon: SendIcon },
      { id: 'cron', label: t('tab_cronJobs'), icon: ClockIcon },
      { id: 'sessions', label: t('tab_sessions'), icon: MessagesSquareIcon },
      { id: 'usage', label: t('tab_usage'), icon: BarChart3Icon },
    ],
  },
  {
    label: t('tabGroup_agent'),
    tabs: [
      { id: 'agents', label: t('tab_agents'), icon: BotIcon },
      { id: 'tool', label: t('tab_tools'), icon: WrenchIcon },
      { id: 'skills', label: t('tab_skills'), icon: ZapIcon },
    ],
  },
  {
    label: t('tabGroup_settings'),
    tabs: [
      { id: 'general', label: t('tab_general'), icon: SettingsIcon },
      { id: 'model', label: t('tab_models'), icon: BrainCircuitIcon },
      { id: 'actions', label: t('tab_actions'), icon: LightbulbIcon },
      { id: 'logs', label: t('tab_logs'), icon: ScrollTextIcon },
      { id: 'community', label: t('tab_community'), icon: MessageCircleIcon },
    ],
  },
];

// Keep backward compat — static CONFIG_TAB_GROUPS calls t() at access time
const CONFIG_TAB_GROUPS = new Proxy([] as ConfigTabGroup[], {
  get(_target, prop, receiver) {
    return Reflect.get(getConfigTabGroups(), prop, receiver);
  },
  has(_target, prop) {
    return Reflect.has(getConfigTabGroups(), prop);
  },
  ownKeys() {
    return Reflect.ownKeys(getConfigTabGroups());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Reflect.getOwnPropertyDescriptor(getConfigTabGroups(), prop);
  },
});

export { CONFIG_TAB_GROUPS, getConfigTabGroups };
export type { ConfigTabId, ConfigTabGroup };
