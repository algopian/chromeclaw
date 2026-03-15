import {
  LOG_LEVELS,
  formatLogEntry,
  formatLogsForExport,
  formatTimestamp,
} from '@extension/shared';
import { useT } from '@extension/i18n';
import { logConfigStorage } from '@extension/storage';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@extension/ui';
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  PlayIcon,
  SquareIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  Trash2Icon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { LogCategory, LogConfig, LogEntry, LogLevel } from '@extension/shared';

const LOG_CATEGORIES: LogCategory[] = ['tool', 'stream', 'slash-cmd', 'auth', 'storage', 'general'];

const MAX_UI_ENTRIES = 1000;

const LEVEL_COLORS: Record<LogLevel, string> = {
  trace: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  debug: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  info: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  warn: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300',
  error: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
};

const LogViewer = () => {
  const t = useT();
  const [config, setConfig] = useState<LogConfig | null>(null);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [dropped, setDropped] = useState(0);
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all');
  const [categoryFilter, setCategoryFilter] = useState<LogCategory | 'all'>('all');
  const [search, setSearch] = useState('');
  const [live, setLive] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load config
  useEffect(() => {
    logConfigStorage.get().then(setConfig);
  }, []);

  // Fetch logs on mount
  useEffect(() => {
    chrome.runtime
      .sendMessage({ type: 'GET_LOGS' })
      .then((resp: Record<string, unknown>) => {
        if (resp && Array.isArray(resp.entries)) {
          setEntries(resp.entries as LogEntry[]);
          setDropped((resp.dropped as number) ?? 0);
        }
      })
      .catch(() => {});
  }, []);

  // Live mode
  useEffect(() => {
    if (!live) {
      if (portRef.current) {
        portRef.current.disconnect();
        portRef.current = null;
      }
      return;
    }

    const port = chrome.runtime.connect({ name: 'log-stream' });
    portRef.current = port;

    port.onMessage.addListener((msg: Record<string, unknown>) => {
      if (msg.type === 'LOG_ENTRY' && msg.entry) {
        setEntries(prev => {
          const next = [...prev, msg.entry as LogEntry];
          return next.length > MAX_UI_ENTRIES ? next.slice(next.length - MAX_UI_ENTRIES) : next;
        });
      }
    });

    return () => {
      port.disconnect();
      portRef.current = null;
    };
  }, [live]);

  useEffect(() => () => clearTimeout(copyTimeoutRef.current), []);

  // Auto-scroll in live mode
  useEffect(() => {
    if (live && scrollRef.current) {
      const viewport = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]');
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight;
      }
    }
  }, [entries, live]);

  const handleToggleEnabled = useCallback(
    (enabled: boolean) => {
      if (!config) return;
      const next = { ...config, enabled };
      setConfig(next);
      logConfigStorage.set(next);
    },
    [config],
  );

  const handleLevelChange = useCallback(
    (level: LogLevel) => {
      if (!config) return;
      const next = { ...config, level };
      setConfig(next);
      logConfigStorage.set(next);
    },
    [config],
  );

  const handleRefresh = useCallback(() => {
    chrome.runtime
      .sendMessage({ type: 'GET_LOGS' })
      .then((resp: Record<string, unknown>) => {
        if (resp && Array.isArray(resp.entries)) {
          setEntries(resp.entries as LogEntry[]);
          setDropped((resp.dropped as number) ?? 0);
        }
      })
      .catch(() => {});
  }, []);

  const handleClear = useCallback(() => {
    chrome.runtime
      .sendMessage({ type: 'CLEAR_LOGS' })
      .then(() => {
        setEntries([]);
        setDropped(0);
      })
      .catch(() => {});
  }, []);

  const toggleExpanded = useCallback((id: number) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const searchLower = search.toLowerCase();
  const filteredEntries = useMemo(
    () =>
      entries.filter(e => {
        if (levelFilter !== 'all' && e.level !== levelFilter) return false;
        if (categoryFilter !== 'all' && e.category !== categoryFilter) return false;
        if (searchLower && !e.message.toLowerCase().includes(searchLower)) return false;
        return true;
      }),
    [entries, levelFilter, categoryFilter, searchLower],
  );

  const handleExport = useCallback(
    (format: 'text' | 'json') => {
      const content = formatLogsForExport(filteredEntries, format);
      const mimeType = format === 'json' ? 'application/json' : 'text/plain';
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `chromeclaw-logs-${Date.now()}.${format === 'json' ? 'json' : 'txt'}`;
      a.click();
      URL.revokeObjectURL(url);
    },
    [filteredEntries],
  );

  const handleCopyEntry = useCallback((entry: LogEntry) => {
    const text = formatLogEntry(entry);
    navigator.clipboard.writeText(text);
    setCopiedId(entry.id);
    clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopiedId(null), 1500);
  }, []);

  const handleCopyAll = useCallback(() => {
    const text = formatLogsForExport(filteredEntries, 'text');
    navigator.clipboard.writeText(text);
    toast.success(t('log_copiedCount', String(filteredEntries.length)));
  }, [filteredEntries]);

  if (!config) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ScrollTextIcon className="size-5" />
          {t('log_title')}
        </CardTitle>
        <CardDescription>
          {t('log_description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Enable toggle + capture level */}
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <input
              checked={config.enabled}
              className="accent-primary size-4"
              id="log-enabled"
              onChange={e => handleToggleEnabled(e.target.checked)}
              type="checkbox"
            />
            <Label htmlFor="log-enabled" className="text-sm font-medium">
              {t('log_enableLogging')}
            </Label>
          </div>

          <div className="flex items-center gap-2">
            <Label className="text-muted-foreground text-xs">{t('log_minLevel')}</Label>
            <Select value={config.level} onValueChange={v => handleLevelChange(v as LogLevel)}>
              <SelectTrigger className="h-8 w-[100px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOG_LEVELS.map(l => (
                  <SelectItem key={l} value={l}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-2">
          <Select value={levelFilter} onValueChange={v => setLevelFilter(v as LogLevel | 'all')}>
            <SelectTrigger className="h-8 w-[100px]">
              <SelectValue placeholder="Level" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('log_allLevels')}</SelectItem>
              {LOG_LEVELS.map(l => (
                <SelectItem key={l} value={l}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={categoryFilter}
            onValueChange={v => setCategoryFilter(v as LogCategory | 'all')}>
            <SelectTrigger className="h-8 w-[110px]">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('log_allCategories')}</SelectItem>
              {LOG_CATEGORIES.map(c => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Input
            className="h-8 flex-1"
            onChange={e => setSearch(e.target.value)}
            placeholder={t('log_searchPlaceholder')}
            value={search}
          />

          <Button
            className="h-8 gap-1"
            onClick={() => setLive(prev => !prev)}
            size="sm"
            variant={live ? 'default' : 'outline'}>
            {live ? <SquareIcon className="size-3" /> : <PlayIcon className="size-3" />}
            {live ? t('log_stop') : t('log_live')}
          </Button>

          <Button className="h-8 gap-1" onClick={handleRefresh} size="sm" variant="outline">
            <RefreshCwIcon className="size-3" />
          </Button>

          <Button className="h-8 gap-1" onClick={handleClear} size="sm" variant="outline">
            <Trash2Icon className="size-3" />
            {t('log_clear')}
          </Button>
        </div>

        {/* Log entries */}
        <ScrollArea className="h-[400px] rounded-md border" ref={scrollRef}>
          <div className="p-2 font-mono text-xs">
            {filteredEntries.length === 0 ? (
              <div className="text-muted-foreground flex h-[360px] items-center justify-center">
                {entries.length === 0 ? t('log_noEntries') : t('log_noMatch')}
              </div>
            ) : (
              filteredEntries.map(entry => (
                <div
                  key={entry.id}
                  className="hover:bg-muted/50 group border-b border-transparent py-1 last:border-b-0">
                  <div className="flex w-full items-start gap-1.5">
                    <button
                      className="text-muted-foreground shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                      onClick={e => {
                        e.stopPropagation();
                        handleCopyEntry(entry);
                      }}
                      title={t('log_copyEntry')}
                      type="button">
                      {copiedId === entry.id ? (
                        <CheckIcon className="size-3" />
                      ) : (
                        <CopyIcon className="size-3" />
                      )}
                    </button>
                    <button
                      className="flex min-w-0 flex-1 cursor-pointer items-start gap-1.5 text-left"
                      onClick={
                        entry.data !== undefined ? () => toggleExpanded(entry.id) : undefined
                      }
                      type="button">
                      <span className="text-muted-foreground shrink-0">
                        {formatTimestamp(entry.timestamp)}
                      </span>
                      <Badge
                        className={`shrink-0 px-1.5 py-0 text-[10px] ${LEVEL_COLORS[entry.level]}`}
                        variant="outline">
                        {entry.level.toUpperCase()}
                      </Badge>
                      <Badge className="shrink-0 px-1.5 py-0 text-[10px]" variant="secondary">
                        {entry.category}
                      </Badge>
                      <span className="flex-1 break-all">{entry.message}</span>
                      {entry.data !== undefined && (
                        <span className="text-muted-foreground shrink-0">
                          {expandedIds.has(entry.id) ? '\u25BC' : '\u25B6'}
                        </span>
                      )}
                    </button>
                  </div>
                  {entry.data !== undefined && expandedIds.has(entry.id) && (
                    <pre className="bg-muted mt-1 overflow-auto rounded p-2 text-[10px]">
                      {JSON.stringify(entry.data, null, 2)}
                    </pre>
                  )}
                </div>
              ))
            )}
          </div>
        </ScrollArea>

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Button
              className="h-7 gap-1 text-xs"
              onClick={() => handleExport('text')}
              size="sm"
              variant="outline">
              <DownloadIcon className="size-3" />
              {t('log_exportText')}
            </Button>
            <Button
              className="h-7 gap-1 text-xs"
              onClick={() => handleExport('json')}
              size="sm"
              variant="outline">
              <DownloadIcon className="size-3" />
              {t('log_exportJson')}
            </Button>
            <Button
              className="h-7 gap-1 text-xs"
              onClick={handleCopyAll}
              size="sm"
              variant="outline">
              <CopyIcon className="size-3" />
              {t('log_copyAll')}
            </Button>
          </div>
          <div className="text-muted-foreground text-xs">
            {t('log_entriesCount', String(filteredEntries.length))}
            {dropped > 0 && ` (${t('log_droppedCount', String(dropped))})`}
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export { LogViewer };
