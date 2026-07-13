import { MessageIcon, TrashIcon, PencilEditIcon } from './icons';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  ScrollArea,
} from './ui';
import { groupChatsByDate } from '../group-chats-by-date';
import { cn } from '../utils';
import {
  listChats,
  deleteChat,
  clearAllChatHistory,
  searchChats,
  lastActiveSessionStorage,
  updateChatTitle,
} from '@extension/storage';
import { useT } from '@extension/i18n';
import { EllipsisVertical, SendIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Chat } from '@extension/shared';

type SessionListProps = {
  agentId?: string;
  currentChatId: string;
  onSelectChat: (chat: Chat) => void;
  onClearAll?: () => void;
  isVisible: boolean;
  showSearch?: boolean;
};

const truncateTitle = (title: string, max = 36): string =>
  title.length > max ? title.slice(0, max) + '...' : title;

const SessionSection = ({
  title,
  chats,
  currentChatId,
  onSelectChat,
  onDeleteChat,
  onRenameChat,
}: {
  title: string;
  chats: Chat[];
  currentChatId: string;
  onSelectChat: (chat: Chat) => void;
  onDeleteChat: (chatId: string) => void;
  onRenameChat: (chatId: string, newTitle: string) => void;
}) => {
  const t = useT();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  const commitRename = (chatId: string, originalTitle: string) => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== originalTitle) {
      onRenameChat(chatId, trimmed);
    }
    setRenamingId(null);
  };

  if (chats.length === 0) return null;

  return (
    <div className="mb-4">
      <h3 className="text-muted-foreground mb-1 px-3 text-xs font-medium uppercase tracking-wide">
        {title}
      </h3>
      {chats.map(chat => {
        const displayTitle = chat.title || t('session_newSession');
        const isRenaming = renamingId === chat.id;

        return (
          <div
            className={cn(
              'hover:bg-muted group flex items-center gap-1 rounded-md px-3 py-1.5 text-sm transition-colors',
              chat.id === currentChatId && 'bg-muted',
            )}
            key={chat.id}>
            {chat.source === 'telegram' && (
              <SendIcon className="h-3.5 w-3.5 shrink-0 text-blue-500" />
            )}
            {isRenaming ? (
              <input
                ref={renameInputRef}
                className="bg-background border-input min-w-0 flex-1 rounded border px-1.5 py-0.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                onBlur={() => commitRename(chat.id, displayTitle)}
                onChange={e => setRenameValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitRename(chat.id, displayTitle);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setRenamingId(null);
                  }
                }}
                type="text"
                value={renameValue}
              />
            ) : (
              <>
                <button
                  className="min-w-0 flex-1 truncate text-left"
                  onClick={() => onSelectChat(chat)}
                  onDoubleClick={() => {
                    setRenameValue(displayTitle);
                    setRenamingId(chat.id);
                  }}
                  type="button">
                  {truncateTitle(displayTitle)}
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      className="text-muted-foreground opacity-50 hover:opacity-100 hover:bg-accent shrink-0 rounded p-0.5 transition-all data-[state=open]:opacity-100"
                      onClick={e => e.stopPropagation()}
                      type="button">
                      <EllipsisVertical size={14} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" sideOffset={4}>
                    <DropdownMenuItem
                      onClick={() => {
                        setRenameValue(displayTitle);
                        setRenamingId(chat.id);
                      }}>
                      <PencilEditIcon size={14} />
                      <span className="ml-2">{t('session_rename')}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => onDeleteChat(chat.id)}>
                      <TrashIcon size={14} />
                      <span className="ml-2">{t('session_delete')}</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
};

const SessionList = ({
  agentId,
  currentChatId,
  onSelectChat,
  onClearAll,
  isVisible,
  showSearch = true,
}: SessionListProps) => {
  const t = useT();
  const [chats, setChats] = useState<Chat[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [showClearAll, setShowClearAll] = useState(false);

  const loadChats = useCallback(async () => {
    const result = searchQuery
      ? await searchChats(searchQuery, agentId)
      : await listChats(100, 0, agentId);
    setChats(result);
  }, [searchQuery, agentId]);

  useEffect(() => {
    if (isVisible) {
      loadChats();
    }
  }, [isVisible, loadChats]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    if (deleteTarget === currentChatId) {
      await lastActiveSessionStorage.set('');
    }
    await deleteChat(deleteTarget);
    setDeleteTarget(null);
    loadChats();
  }, [deleteTarget, currentChatId, loadChats]);

  const handleRename = useCallback(
    async (chatId: string, newTitle: string) => {
      await updateChatTitle(chatId, newTitle);
      loadChats();
    },
    [loadChats],
  );

  const handleClearAll = useCallback(async () => {
    await clearAllChatHistory();
    await lastActiveSessionStorage.set('');
    setShowClearAll(false);
    setChats([]);
    if (onClearAll) onClearAll();
  }, [onClearAll]);

  const grouped = groupChatsByDate(chats);

  return (
    <>
      {/* Search */}
      {showSearch && (
        <div className="border-b px-3 py-2">
          <Input
            onChange={e => setSearchQuery(e.target.value)}
            placeholder={t('session_searchPlaceholder')}
            type="search"
            value={searchQuery}
          />
        </div>
      )}

      {/* Session list */}
      <ScrollArea className="flex-1 [&>[data-radix-scroll-area-viewport]>div]:!block">
        <div className="py-2">
          {chats.length === 0 && (
            <div className="text-muted-foreground flex flex-col items-center gap-2 px-3 py-8 text-center text-sm">
              <MessageIcon size={24} />
              <span>{searchQuery ? t('session_noMatching') : t('session_noSessions')}</span>
            </div>
          )}
          <SessionSection
            chats={grouped.today}
            currentChatId={currentChatId}
            onDeleteChat={setDeleteTarget}
            onRenameChat={handleRename}
            onSelectChat={onSelectChat}
            title={t('session_today')}
          />
          <SessionSection
            chats={grouped.yesterday}
            currentChatId={currentChatId}
            onDeleteChat={setDeleteTarget}
            onRenameChat={handleRename}
            onSelectChat={onSelectChat}
            title={t('session_yesterday')}
          />
          <SessionSection
            chats={grouped.lastWeek}
            currentChatId={currentChatId}
            onDeleteChat={setDeleteTarget}
            onRenameChat={handleRename}
            onSelectChat={onSelectChat}
            title={t('session_last7Days')}
          />
          <SessionSection
            chats={grouped.lastMonth}
            currentChatId={currentChatId}
            onDeleteChat={setDeleteTarget}
            onRenameChat={handleRename}
            onSelectChat={onSelectChat}
            title={t('session_last30Days')}
          />
          <SessionSection
            chats={grouped.older}
            currentChatId={currentChatId}
            onDeleteChat={setDeleteTarget}
            onRenameChat={handleRename}
            onSelectChat={onSelectChat}
            title={t('session_older')}
          />
        </div>
      </ScrollArea>

      {/* Delete confirmation */}
      <AlertDialog onOpenChange={open => !open && setDeleteTarget(null)} open={!!deleteTarget}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('session_deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('session_deleteDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common_cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>{t('common_delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Clear all confirmation */}
      <AlertDialog onOpenChange={setShowClearAll} open={showClearAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('session_deleteAllTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('session_deleteAllDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common_cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleClearAll}>{t('common_deleteAll')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export { SessionList };
export type { SessionListProps };
