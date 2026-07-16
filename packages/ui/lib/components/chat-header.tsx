import { AgentSwitcher } from './agent-switcher';
import { ContextStatusBadge } from './context-status';
import { PlusIcon } from './icons';
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui';
import { useT } from '@extension/i18n';
import { Maximize2Icon, SettingsIcon, UserIcon } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import type { AgentSwitcherAgent } from './agent-switcher';
import type { ChatModel } from '@extension/shared';

type ContextStatus = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  compactionCount: number;
  contextLimit: number;
  lastCompactionMethod?: string;
  lastCompactionTokensSaved?: number;
};

type ChatHeaderProps = {
  chatTitle?: string;
  model?: ChatModel;
  onNewChat: () => void;
  onOpenSidebar?: () => void;
  isFullPage?: boolean;
  contextStatus?: ContextStatus;
  agents?: AgentSwitcherAgent[];
  activeAgentId?: string;
  onAgentChange?: (agentId: string) => void;
  onRenameTitle?: (title: string) => void;
};

const PureChatHeader = ({
  chatTitle,
  model,
  onNewChat,
  onOpenSidebar,
  isFullPage,
  contextStatus,
  agents,
  activeAgentId,
  onAgentChange,
  onRenameTitle,
}: ChatHeaderProps) => {
  const t = useT();
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [isRenaming]);

  const startRename = () => {
    if (!onRenameTitle || !chatTitle) return;
    setRenameValue(chatTitle);
    setIsRenaming(true);
  };

  const commitRename = () => {
    setIsRenaming(false);
    const next = renameValue.trim();
    if (next && next !== chatTitle) onRenameTitle?.(next);
  };
  return (
  <header className="bg-background sticky top-0 z-10 flex items-center gap-2 border-b px-2 py-1.5">
    {onOpenSidebar && (
      <Button
        className="h-8 px-2"
        onClick={onOpenSidebar}
        size="sm"
        title="Toggle sidebar"
        variant="ghost">
        <svg
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24">
          <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Button>
    )}

    {agents && activeAgentId && onAgentChange && agents.length > 1 && (
      <AgentSwitcher activeAgentId={activeAgentId} agents={agents} onAgentChange={onAgentChange} />
    )}

    <Button className="h-8 px-2" onClick={onNewChat} size="sm" variant="outline">
      <PlusIcon />
      <span className="sr-only sm:not-sr-only">{t('session_newSession')}</span>
    </Button>

    {chatTitle &&
      (isRenaming ? (
        <input
          ref={renameInputRef}
          className="bg-background border-input focus:ring-ring min-w-0 flex-1 rounded border px-1.5 py-0.5 text-sm outline-none focus:ring-1"
          onBlur={commitRename}
          onChange={e => setRenameValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitRename();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setRenameValue('');
              setIsRenaming(false);
            }
          }}
          type="text"
          value={renameValue}
        />
      ) : (
        <span
          className="min-w-0 flex-1 truncate text-sm font-medium"
          onDoubleClick={startRename}>
          {chatTitle}
        </span>
      ))}

    {model && (
      <Badge className="hidden shrink-0 sm:flex" variant="secondary">
        {model.name}
      </Badge>
    )}

    {contextStatus && contextStatus.totalTokens > 0 && (
      <ContextStatusBadge
        compactionCount={contextStatus.compactionCount}
        contextLimit={contextStatus.contextLimit}
        inputTokens={contextStatus.inputTokens}
        lastCompactionMethod={contextStatus.lastCompactionMethod}
        lastCompactionTokensSaved={contextStatus.lastCompactionTokensSaved}
        outputTokens={contextStatus.outputTokens}
        totalTokens={contextStatus.totalTokens}
      />
    )}

    <div className="ml-auto flex items-center gap-1">
      {!isFullPage && (
        <Button
          className="h-8 w-8 p-0"
          onClick={() => {
            chrome.tabs.create({ url: chrome.runtime.getURL('full-page-chat/index.html') });
            window.close();
          }}
          size="sm"
          title="Open in full page"
          variant="ghost">
          <Maximize2Icon className="size-4" />
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className="h-8 w-8 rounded-full p-0"
            data-testid="user-menu-button"
            size="sm"
            variant="ghost">
            <UserIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onClick={() => chrome.runtime.openOptionsPage()}>
            <SettingsIcon className="mr-2 size-4" />
            {t('settings_title')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </header>
  );
};

const ChatHeader = memo(PureChatHeader);

export { ChatHeader };
export type { ChatHeaderProps };
