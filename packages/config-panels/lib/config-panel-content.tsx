import type { ConfigTabId } from './tab-groups';
import { Settings } from './settings';
import { ModelConfig } from './model-config';
import { ToolConfig } from './tool-config';
import { EmbeddingConfigPanel } from './embedding-config';
import { SpeechToTextConfig } from './speech-to-text-config';
import { TextToSpeechConfig } from './text-to-speech-config';
import { SuggestedActionsConfig } from './suggested-actions-config';
import { SkillConfig } from './skill-config';
import { AgentsConfig } from './agents-config';
import { CronConfig } from './cron-config';
import { SessionManager } from './session-manager';
import { UsageDashboard } from './usage-dashboard';
import { LogViewer } from './log-viewer';
import { TelegramConfig } from './telegram-config';
import { WhatsAppConfig } from './whatsapp-config';

const ConfigPanelContent = ({ activeTab, onOpenSession }: { activeTab: ConfigTabId; onOpenSession?: (chatId: string) => void }) => (
  <>
    {activeTab === 'general' && <Settings />}
    {activeTab === 'model' && <ModelConfig />}
    {activeTab === 'tool' && (
      <>
        <ToolConfig />
        <EmbeddingConfigPanel />
        <SpeechToTextConfig />
        <TextToSpeechConfig />
      </>
    )}
    {activeTab === 'actions' && <SuggestedActionsConfig />}
    {activeTab === 'skills' && <SkillConfig />}
    {activeTab === 'agents' && <AgentsConfig />}
    {activeTab === 'channels' && (
      <>
        <TelegramConfig />
        <WhatsAppConfig />
      </>
    )}
    {activeTab === 'cron' && <CronConfig />}
    {activeTab === 'sessions' && <SessionManager onOpenSession={onOpenSession} />}
    {activeTab === 'usage' && <UsageDashboard />}
    {activeTab === 'logs' && <LogViewer />}
  </>
);

export { ConfigPanelContent };
