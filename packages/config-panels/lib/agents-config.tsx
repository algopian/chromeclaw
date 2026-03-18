import {
  extractPdfText,
  toolRegistryMeta,
} from '@extension/shared';
import { t, useT } from '@extension/i18n';
import {
  listSkillFiles,
  listWorkspaceFiles,
  updateWorkspaceFile,
  deleteWorkspaceFile,
  createWorkspaceFile,
  deleteMemoryChunksByFileId,
  listAgents,
  createAgent,
  getAgent,
  updateAgent,
  deleteAgent,
  seedPredefinedWorkspaceFiles,
  copyGlobalSkillsToAgent,
  activeAgentStorage,
  toolConfigStorage,
} from '@extension/storage';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Label,
  MarkdownEditor,
  ScrollArea,
  Separator,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  TreeNode,
  buildFileTree,
  cn,
} from '@extension/ui';
import {
  BrainIcon,
  CalendarClockIcon,
  CalendarIcon,
  CloudIcon,
  CodeIcon,
  DownloadIcon,
  EllipsisVertical,
  EyeIcon,
  FileTextIcon,
  FilePlusIcon,
  FolderPlusIcon,
  HardDriveDownloadIcon,
  HardDriveIcon,
  LinkIcon,
  MailIcon,
  MessagesSquareIcon,
  MonitorIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  SaveIcon,
  SearchIcon,
  TelescopeIcon,
  TextCursorInputIcon,
  TrashIcon,
  UploadIcon,
  UsersIcon,
  WrenchIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { nanoid } from 'nanoid';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import { toast } from 'sonner';
import type {
  DbWorkspaceFile,
  AgentConfig,
  ToolConfig as ToolConfigData,
} from '@extension/storage';
import type { FileTreeNode } from '@extension/ui';
import { ConfirmDialog, emptyConfirm } from './confirm-dialog.js';
import type { ConfirmDialogState } from './confirm-dialog.js';
import { SkillConfig } from './skill-config.js';

const MAX_CONTENT_LENGTH = 20_000;

// ── Inline dialogs ──────

type PromptDialogState = {
  open: boolean;
  title: string;
  defaultValue: string;
  onSubmit: (value: string) => void;
};

const emptyPrompt: PromptDialogState = {
  open: false,
  title: '',
  defaultValue: '',
  onSubmit: () => {},
};

const PromptDialog = ({ state, onClose }: { state: PromptDialogState; onClose: () => void }) => {
  const [value, setValue] = useState(state.defaultValue);

  useEffect(() => {
    setValue(state.defaultValue);
  }, [state.defaultValue, state.open]);

  return (
    <Dialog open={state.open} onOpenChange={open => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{state.title}</DialogTitle>
          <DialogDescription className="sr-only">{state.title}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && value.trim()) {
              state.onSubmit(value.trim());
              onClose();
            }
          }}
        />
        <DialogFooter>
          <Button onClick={onClose} variant="outline">
            {t('common_cancel')}
          </Button>
          <Button
            disabled={!value.trim()}
            onClick={() => {
              state.onSubmit(value.trim());
              onClose();
            }}>
            {t('common_ok')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ── Helpers ──────────────────────────────────────────

const formatFileSize = (content: string): string => {
  const bytes = new TextEncoder().encode(content).byteLength;
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
};

const formatTimeAgo = (timestamp: number): string => {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return t('agents_justNow');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('agents_minutesAgo', String(minutes));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('agents_hoursAgo', String(hours));
  const days = Math.floor(hours / 24);
  if (days < 30) return t('agents_daysAgo', String(days));
  const months = Math.floor(days / 30);
  return t('agents_monthsAgo', String(months));
};

const parseIdentityField = (content: string, field: string): string => {
  const regex = new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+)`, 'i');
  const match = content.match(regex);
  if (!match) return t('agents_notSet');
  const value = match[1].trim();
  // Treat template placeholders as not set
  if (value.startsWith('_') && value.endsWith('_')) return t('agents_notSet');
  if (value.startsWith('_(') && value.endsWith(')_')) return t('agents_notSet');
  return value;
};

const truncateTitle = (title: string, max = 18): string =>
  title.length > max ? title.slice(0, max) + '...' : title;

// ── Sub-components ───────────────────────────────────

type AgentInfo = {
  id: string;
  name: string;
  emoji: string;
  isDefault: boolean;
};

const AgentCard = ({
  agent,
  selected,
  onSelect,
  onDelete,
}: {
  agent: AgentInfo;
  selected: boolean;
  onSelect: () => void;
  onDelete?: () => void;
}) => (
  <div
    className={cn(
      'group flex w-full items-center gap-2 rounded-lg border px-2 py-2 text-left transition-colors',
      selected ? 'border-primary bg-primary/5' : 'hover:bg-muted border-transparent',
    )}>
    <button className="flex min-w-0 flex-1 items-center gap-2" onClick={onSelect} type="button">
      <div className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-full text-base">
        {agent.emoji || '\u{1F916}'}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{truncateTitle(agent.name)}</div>
        <div className="text-muted-foreground truncate text-xs">{agent.id}</div>
      </div>
    </button>
    {agent.isDefault && (
      <Badge className="shrink-0 text-[10px]" variant="secondary">
        DEFAULT
      </Badge>
    )}
    {onDelete && (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="text-muted-foreground hover:bg-accent shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
            onClick={e => e.stopPropagation()}
            type="button">
            <EllipsisVertical size={14} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4}>
          <DropdownMenuItem onClick={onDelete}>
            <TrashIcon className="size-3.5" />
            <span className="ml-2">{t('common_delete')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )}
  </div>
);

const AgentListPanel = ({
  agents,
  selectedId,
  onSelect,
  onDelete,
  onCreate,
}: {
  agents: AgentInfo[];
  selectedId: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
}) => (
  <div className="flex w-60 shrink-0 flex-col border-r">
    <div className="flex items-center justify-between border-b px-4 py-3">
      <h3 className="text-sm font-medium">{t('agents_title')}</h3>
      <Button onClick={onCreate} size="sm" title={t('agents_newAgent')} variant="ghost">
        <PlusIcon className="size-4" />
      </Button>
    </div>
    <ScrollArea className="flex-1">
      <div className="space-y-1 p-2">
        {agents.map(agent => (
          <AgentCard
            agent={agent}
            key={agent.id}
            onDelete={!agent.isDefault ? () => onDelete(agent.id) : undefined}
            onSelect={() => onSelect(agent.id)}
            selected={agent.id === selectedId}
          />
        ))}
      </div>
    </ScrollArea>
  </div>
);

const AgentDetailHeader = ({
  agent,
  onNameChange,
  onEmojiChange,
}: {
  agent: AgentInfo;
  onNameChange: (name: string) => void;
  onEmojiChange: (emoji: string) => void;
}) => {
  const [editingName, setEditingName] = useState(false);
  const [editingEmoji, setEditingEmoji] = useState(false);
  const [nameValue, setNameValue] = useState(agent.name);
  const [emojiValue, setEmojiValue] = useState(agent.emoji);

  useEffect(() => {
    setNameValue(agent.name);
    setEmojiValue(agent.emoji);
  }, [agent.id, agent.name, agent.emoji]);

  return (
    <div className="flex items-center gap-4 border-b px-6 py-4">
      {editingEmoji ? (
        <Input
          autoFocus
          className="size-14 text-center text-2xl"
          onBlur={() => {
            setEditingEmoji(false);
            if (emojiValue !== agent.emoji) onEmojiChange(emojiValue);
          }}
          onChange={e => setEmojiValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              setEditingEmoji(false);
              if (emojiValue !== agent.emoji) onEmojiChange(emojiValue);
            }
          }}
          value={emojiValue}
        />
      ) : (
        <button
          className="bg-muted flex size-14 shrink-0 items-center justify-center rounded-full text-2xl hover:opacity-80"
          onClick={() => setEditingEmoji(true)}
          title="Click to edit emoji"
          type="button">
          {agent.emoji || '\u{1F916}'}
        </button>
      )}
      <div className="min-w-0 flex-1">
        {editingName ? (
          <Input
            autoFocus
            className="text-lg font-semibold"
            onBlur={() => {
              setEditingName(false);
              if (nameValue.trim() && nameValue !== agent.name) onNameChange(nameValue.trim());
            }}
            onChange={e => setNameValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                setEditingName(false);
                if (nameValue.trim() && nameValue !== agent.name) onNameChange(nameValue.trim());
              }
            }}
            value={nameValue}
          />
        ) : (
          <button
            className="text-left text-lg font-semibold hover:underline"
            onClick={() => setEditingName(true)}
            title="Click to edit name"
            type="button">
            {agent.name}
          </button>
        )}
        <p className="text-muted-foreground text-sm">{agent.id}</p>
      </div>
      {agent.isDefault && (
        <Badge className="ml-auto" variant="secondary">
          DEFAULT
        </Badge>
      )}
    </div>
  );
};

type OverviewField = { label: string; value: string };

const AgentOverview = ({ identityContent }: { identityContent: string }) => {
  const t = useT();
  const fields: OverviewField[] = useMemo(
    () => [
      { label: 'Name', value: parseIdentityField(identityContent, 'Name') },
      { label: 'Emoji', value: parseIdentityField(identityContent, 'Emoji') },
      { label: 'Creature', value: parseIdentityField(identityContent, 'Creature') },
      { label: 'Vibe', value: parseIdentityField(identityContent, 'Vibe') },
    ],
    [identityContent],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{t('agents_identity')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          {fields.map(f => (
            <div key={f.label}>
              <div className="text-muted-foreground text-xs font-medium">{f.label}</div>
              <div
                className={cn(
                  'text-sm',
                  f.value === t('agents_notSet') && 'text-muted-foreground italic',
                )}>
                {f.value}
              </div>
            </div>
          ))}
        </div>
        <p className="text-muted-foreground mt-4 text-xs">
          {t('agents_identityHint')}
        </p>
      </CardContent>
    </Card>
  );
};

const FileEditorDialog = ({
  file,
  onSave,
  onClose,
}: {
  file: DbWorkspaceFile;
  onSave: (content: string) => void;
  onClose: () => void;
}) => {
  const [content, setContent] = useState(file.content);
  const [isDirty, setIsDirty] = useState(false);
  const [mode, setMode] = useState<'view' | 'raw' | 'split'>('raw');

  useEffect(() => {
    setContent(file.content);
    setIsDirty(false);
  }, [file.id, file.content]);

  const charCount = content.length;

  return (
    <>
      <MarkdownEditor
        content={content}
        onChange={newContent => {
          setContent(newContent);
          setIsDirty(true);
        }}
        mode={mode}
        onModeChange={setMode}
        className="min-h-[350px]"
      />

      {/* Footer */}
      <div className="flex items-center justify-between pt-2">
        <span className="text-muted-foreground text-xs">{charCount.toLocaleString()} chars</span>
        <div className="flex gap-2">
          <Button onClick={onClose} size="sm" variant="outline">
            {t('common_cancel')}
          </Button>
          <Button
            disabled={!isDirty}
            onClick={() => {
              onSave(content);
              onClose();
            }}
            size="sm">
            <SaveIcon className="mr-1 size-3.5" />
            {t('common_save')}
          </Button>
        </div>
      </div>
    </>
  );
};

type SubTab = 'overview' | 'files' | 'tools' | 'skills';

const AgentFilesTab = ({
  files,
  agentId,
  onReload,
}: {
  files: DbWorkspaceFile[];
  agentId: string;
  onReload: () => void;
}) => {
  const t = useT();
  const [editorFile, setEditorFile] = useState<DbWorkspaceFile | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [selectedNode, setSelectedNode] = useState<FileTreeNode | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>(emptyConfirm);
  const [promptDialog, setPromptDialog] = useState<PromptDialogState>(emptyPrompt);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const tree = useMemo(() => buildFileTree(files), [files]);

  // Derived toolbar state
  const selectedFile = selectedNode?.type === 'file' ? selectedNode.file : null;
  const folderHasPredefined =
    selectedNode?.type === 'folder' &&
    files.some(f => f.predefined && f.name.startsWith(selectedNode.path + '/'));
  const canDelete =
    !!selectedNode &&
    (selectedNode.type === 'file' ? !selectedFile?.predefined : !folderHasPredefined);
  const canRename = canDelete;
  const canEdit = selectedNode?.type === 'file';
  const canDownload = selectedNode?.type === 'file';
  const canDownloadFolder = selectedNode?.type === 'folder';

  // Keep editor file in sync with file list updates; clear if deleted
  useEffect(() => {
    setEditorFile(prev => {
      if (!prev) return prev;
      return files.find(f => f.id === prev.id) ?? null;
    });
  }, [files]);

  // Keep selectedNode in sync with file list updates
  useEffect(() => {
    setSelectedNode(prev => {
      if (prev?.type !== 'file') return prev;
      const updated = files.find(f => f.id === prev.file.id);
      if (!updated) return null;
      if (updated !== prev.file) return { ...prev, file: updated };
      return prev;
    });
  }, [files]);

  // Reset when agent changes
  useEffect(() => {
    setEditorFile(null);
    setSelectedNode(null);
    setExpandedFolders(new Set());
  }, [agentId]);

  const handleToggleFolder = useCallback((path: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleSelectNode = useCallback((node: FileTreeNode) => {
    setSelectedNode(node);
  }, []);

  const handleToggle = useCallback(
    async (file: DbWorkspaceFile) => {
      await updateWorkspaceFile(file.id, { enabled: !file.enabled });
      onReload();
    },
    [onReload],
  );

  const doDeleteFile = useCallback(
    async (file: DbWorkspaceFile) => {
      if (file.name === 'MEMORY.md' || file.name.startsWith('memory/')) {
        await deleteMemoryChunksByFileId(file.id);
      }
      await deleteWorkspaceFile(file.id);
      if (editorFile?.id === file.id) {
        setEditorFile(null);
      }
      if (selectedNode?.type === 'file' && selectedNode.file.id === file.id) {
        setSelectedNode(null);
      }
      onReload();
      toast.success(t('agents_fileDeleted'));
    },
    [editorFile, selectedNode, onReload, t],
  );

  const handleDelete = useCallback(
    (file: DbWorkspaceFile) => {
      setConfirmDialog({
        open: true,
        title: t('agents_deleteFile'),
        description: t('agents_deleteFileConfirm', file.name),
        destructive: true,
        onConfirm: () => doDeleteFile(file),
      });
    },
    [doDeleteFile, t],
  );

  // Get the folder path prefix for new files when a folder/file-in-folder is selected
  const getSelectedFolderPrefix = useCallback(() => {
    if (!selectedNode) return '';
    if (selectedNode.type === 'folder') return selectedNode.path + '/';
    // If a file inside a folder is selected, use its parent folder
    const lastSlash = selectedNode.path.lastIndexOf('/');
    return lastSlash >= 0 ? selectedNode.path.slice(0, lastSlash + 1) : '';
  }, [selectedNode]);

  const handleNewFile = useCallback(async () => {
    const prefix = getSelectedFolderPrefix();
    const now = Date.now();
    const file: DbWorkspaceFile = {
      id: nanoid(),
      name: prefix + 'untitled.md',
      content: '',
      enabled: true,
      owner: 'user',
      predefined: false,
      createdAt: now,
      updatedAt: now,
      agentId,
    };
    await createWorkspaceFile(file);
    onReload();
    setEditorFile(file);
  }, [onReload, agentId, getSelectedFolderPrefix]);

  const handleNewFolder = useCallback(() => {
    setPromptDialog({
      open: true,
      title: t('agents_newFolderName'),
      defaultValue: '',
      onSubmit: async (name: string) => {
        const folderName = name.replace(/\//g, '-');
        const prefix = getSelectedFolderPrefix();
        const folderPath = prefix + folderName;
        const now = Date.now();
        const file: DbWorkspaceFile = {
          id: nanoid(),
          name: folderPath + '/untitled.md',
          content: '',
          enabled: true,
          owner: 'user',
          predefined: false,
          createdAt: now,
          updatedAt: now,
          agentId,
        };
        await createWorkspaceFile(file);
        setExpandedFolders(prev => new Set([...prev, folderPath]));
        onReload();
      },
    });
  }, [onReload, agentId, getSelectedFolderPrefix, t]);

  const handleUpload = useCallback(() => {
    uploadInputRef.current?.click();
  }, []);

  const handleUploadFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      // Reset input so the same file can be re-uploaded
      e.target.value = '';

      const text = await file.text();
      if (text.length > MAX_CONTENT_LENGTH) {
        toast.error(`File exceeds ${MAX_CONTENT_LENGTH.toLocaleString()} character limit`);
        return;
      }

      const prefix = getSelectedFolderPrefix();
      const fileName = prefix + file.name;

      // Check for name collision
      if (files.some(f => f.name === fileName)) {
        toast.error(`A file named "${fileName}" already exists`);
        return;
      }

      const now = Date.now();
      const wsFile: DbWorkspaceFile = {
        id: nanoid(),
        name: fileName,
        content: text,
        enabled: true,
        owner: 'user',
        predefined: false,
        createdAt: now,
        updatedAt: now,
        agentId,
      };
      await createWorkspaceFile(wsFile);
      onReload();
      toast.success(t('agents_fileUploaded'));
    },
    [onReload, agentId, files, getSelectedFolderPrefix, t],
  );

  const handleRename = useCallback(() => {
    if (!selectedNode || !canRename) return;

    if (selectedNode.type === 'file') {
      const file = selectedNode.file;
      const currentName = file.name.split('/').pop() ?? file.name;
      setPromptDialog({
        open: true,
        title: t('agents_renameFile'),
        defaultValue: currentName,
        onSubmit: async (newName: string) => {
          if (newName === currentName) return;
          const prefix =
            file.name.lastIndexOf('/') >= 0
              ? file.name.slice(0, file.name.lastIndexOf('/') + 1)
              : '';
          const fullNewName = prefix + newName;
          if (files.some(f => f.id !== file.id && f.name === fullNewName)) {
            toast.error(`A file named "${fullNewName}" already exists`);
            return;
          }
          await updateWorkspaceFile(file.id, { name: fullNewName });
          setSelectedNode(null);
          onReload();
          toast.success(t('agents_fileRenamed'));
        },
      });
    } else {
      const oldPrefix = selectedNode.path + '/';
      const childFiles = files.filter(f => f.name?.startsWith(oldPrefix));

      if (childFiles.some(f => f.predefined)) {
        toast.error(t('agents_cannotRenamePredefined'));
        return;
      }

      setPromptDialog({
        open: true,
        title: t('agents_renameFolder'),
        defaultValue: selectedNode.name,
        onSubmit: async (newFolderName: string) => {
          if (newFolderName === selectedNode.name) return;
          const sanitized = newFolderName.replace(/\//g, '-');
          const parentPrefix =
            selectedNode.path.lastIndexOf('/') >= 0
              ? selectedNode.path.slice(0, selectedNode.path.lastIndexOf('/') + 1)
              : '';
          const newPrefix = parentPrefix + sanitized + '/';
          await Promise.all(
            childFiles.map(f =>
              updateWorkspaceFile(f.id, { name: newPrefix + f.name.slice(oldPrefix.length) }),
            ),
          );
          setSelectedNode(null);
          onReload();
          toast.success(t('agents_folderRenamed'));
        },
      });
    }
  }, [selectedNode, canRename, files, onReload, t]);

  const handleToolbarDelete = useCallback(() => {
    if (!selectedNode || !canDelete) return;

    if (selectedNode.type === 'file') {
      handleDelete(selectedNode.file);
    } else {
      const prefix = selectedNode.path + '/';
      const childFiles = files.filter(f => f.name?.startsWith(prefix));

      if (childFiles.some(f => f.predefined)) {
        toast.error(t('agents_cannotDeletePredefined'));
        return;
      }

      setConfirmDialog({
        open: true,
        title: t('agents_deleteFolder'),
        description: t('agents_deleteFolderConfirm', [selectedNode.name, String(childFiles.length)]),
        destructive: true,
        onConfirm: async () => {
          await Promise.all(
            childFiles.map(async f => {
              if (f.name === 'MEMORY.md' || f.name.startsWith('memory/')) {
                await deleteMemoryChunksByFileId(f.id);
              }
              await deleteWorkspaceFile(f.id);
            }),
          );
          setSelectedNode(null);
          onReload();
          toast.success(t('agents_folderDeleted'));
        },
      });
    }
  }, [selectedNode, canDelete, files, handleDelete, onReload, t]);

  const handleToolbarEdit = useCallback(() => {
    if (selectedNode?.type === 'file') {
      setEditorFile(selectedNode.file);
    }
  }, [selectedNode]);

  const handleDownload = useCallback(() => {
    if (selectedNode?.type !== 'file') return;
    const file = selectedNode.file;
    const blob = new Blob([file.content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name.split('/').pop() ?? file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [selectedNode]);

  const handleDownloadFolder = useCallback(async () => {
    if (selectedNode?.type !== 'folder') return;
    const prefix = selectedNode.path + '/';
    const folderFiles = files.filter(f => f.name?.startsWith(prefix));
    if (folderFiles.length === 0) {
      toast.error(t('agents_folderEmpty'));
      return;
    }

    try {
      const zip = new JSZip();
      for (const f of folderFiles) {
        const relativePath = f.name.slice(prefix.length);
        zip.file(relativePath, f.content);
      }

      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${selectedNode.name}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(
        `Failed to download folder: ${err instanceof Error ? err.message : 'Unknown error'}`,
      );
    }
  }, [selectedNode, files]);

  const handleUploadFiles = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      e.target.value = '';

      let count = 0;
      for (const file of Array.from(files)) {
        try {
          let content: string;
          let fileName: string;

          if (file.name.toLowerCase().endsWith('.pdf')) {
            const buffer = await file.arrayBuffer();
            content = await extractPdfText(buffer);
            fileName = file.name.replace(/\.pdf$/i, '.md');
          } else {
            content = await file.text();
            fileName = file.name;
          }

          const now = Date.now();
          const wsFile: DbWorkspaceFile = {
            id: nanoid(),
            name: `memory/${fileName}`,
            content,
            enabled: true,
            owner: 'user',
            predefined: false,
            createdAt: now,
            updatedAt: now,
            agentId,
          };
          await createWorkspaceFile(wsFile);
          count++;
        } catch (err) {
          toast.error(
            `Failed to upload ${file.name}: ${err instanceof Error ? err.message : 'Unknown error'}`,
          );
        }
      }

      if (count > 0) {
        onReload();
        toast.success(`Uploaded ${count} file${count !== 1 ? 's' : ''}`);
      }
    },
    [agentId, onReload],
  );

  const handleSave = useCallback(
    async (content: string) => {
      if (!editorFile) return;
      await updateWorkspaceFile(editorFile.id, { content });
      onReload();
      toast.success(t('agents_fileSaved'));
    },
    [editorFile, onReload, t],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <TooltipProvider delayDuration={300}>
        <div className="flex items-center gap-0.5 border-b px-2 py-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button className="size-7" onClick={handleNewFile} size="icon" variant="ghost">
                <FilePlusIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('agents_newFile')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button className="size-7" onClick={handleNewFolder} size="icon" variant="ghost">
                <FolderPlusIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('agents_newFolder')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button className="size-7" onClick={handleUpload} size="icon" variant="ghost">
                <UploadIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('agents_upload')}</TooltipContent>
          </Tooltip>

          <Separator className="mx-1 h-4" orientation="vertical" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                className="size-7"
                disabled={!canEdit}
                onClick={handleToolbarEdit}
                size="icon"
                variant="ghost">
                <PencilIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('agents_edit')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                className="size-7"
                disabled={!canRename}
                onClick={handleRename}
                size="icon"
                variant="ghost">
                <TextCursorInputIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('session_rename')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                className="size-7"
                disabled={!canDownload}
                onClick={handleDownload}
                size="icon"
                variant="ghost">
                <DownloadIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('agents_download')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                className="size-7"
                disabled={!canDownloadFolder}
                onClick={handleDownloadFolder}
                size="icon"
                variant="ghost">
                <HardDriveDownloadIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('agents_downloadFolderZip')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                className="size-7"
                disabled={!canDelete}
                onClick={handleToolbarDelete}
                size="icon"
                variant="ghost">
                <TrashIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('common_delete')}</TooltipContent>
          </Tooltip>

          <Separator className="mx-1 h-4" orientation="vertical" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button className="size-7" onClick={onReload} size="icon" variant="ghost">
                <RotateCcwIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('agents_refresh')}</TooltipContent>
          </Tooltip>

        </div>
      </TooltipProvider>

      <input
        accept=".md,.txt,.markdown"
        className="hidden"
        ref={uploadInputRef}
        onChange={handleUploadFileSelected}
        type="file"
      />

      <ScrollArea className="flex-1">
        <div
          className="py-2"
          onClick={e => {
            if (e.target === e.currentTarget) setSelectedNode(null);
          }}
          role="presentation">
          {tree.map(node => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              expandedFolders={expandedFolders}
              onToggleFolder={handleToggleFolder}
              onEditFile={f => setEditorFile(f)}
              onToggleFile={handleToggle}
              onDeleteFile={handleDelete}
              selectedPath={selectedNode?.path ?? null}
              onSelect={handleSelectNode}
            />
          ))}
        </div>
      </ScrollArea>

      <Dialog
        open={!!editorFile}
        onOpenChange={open => {
          if (!open) setEditorFile(null);
        }}>
        <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{editorFile?.name}</DialogTitle>
            <DialogDescription className="sr-only">Edit {editorFile?.name}</DialogDescription>
          </DialogHeader>
          {editorFile && (
            <FileEditorDialog
              file={editorFile}
              onSave={handleSave}
              onClose={() => setEditorFile(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog state={confirmDialog} onClose={() => setConfirmDialog(emptyConfirm)} />
      <PromptDialog state={promptDialog} onClose={() => setPromptDialog(emptyPrompt)} />
    </div>
  );
};

// ── Agent Tools Tab ──────────────────────────────────

const agentToolIconMap: Record<string, LucideIcon> = {
  CloudIcon,
  SearchIcon,
  LinkIcon,
  FileTextIcon,
  MonitorIcon,
  HardDriveIcon,
  BrainIcon,
  CalendarClockIcon,
  MessagesSquareIcon,
  TelescopeIcon,
  UsersIcon,
  CodeIcon,
  MailIcon,
  CalendarIcon,
  HardDriveDownloadIcon,
};

const GOOGLE_GROUPS = new Set(['gmail', 'calendar', 'drive']);

const AgentToolsTab = ({ agentId, onReload }: { agentId: string; onReload: () => void }) => {
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [globalConfig, setGlobalConfig] = useState<ToolConfigData | null>(null);
  const [loading, setLoading] = useState(true);
  const [isGoogleConnected, setIsGoogleConnected] = useState(false);

  // Check Google connection status on mount (mirrors tool-config.tsx pattern)
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.identity?.getAuthToken) return;
    chrome.identity
      .getAuthToken({ interactive: false })
      .then(result => {
        if (result.token) setIsGoogleConnected(true);
      })
      .catch(() => {});
  }, []);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const [agent, global] = await Promise.all([getAgent(agentId), toolConfigStorage.get()]);
      if (agent) setAgentConfig(agent);
      setGlobalConfig(global);
    } catch (err) {
      console.error('Failed to load tool config', err);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const handleToggle = useCallback(
    async (toolName: string, value: boolean) => {
      if (!agentConfig) return;

      const currentToolConfig = agentConfig.toolConfig ?? {
        enabledTools: {},
        webSearchConfig: {
          provider: 'tavily' as const,
          tavily: { apiKey: '' },
          browser: { engine: 'google' as const },
        },
      };
      const nextToolConfig = {
        ...currentToolConfig,
        enabledTools: { ...currentToolConfig.enabledTools, [toolName]: value },
      };

      await updateAgent(agentId, { toolConfig: nextToolConfig });

      // If this agent is currently active, also update global config so changes take effect immediately
      const activeId = await activeAgentStorage.get();
      if (activeId === agentId && globalConfig) {
        const nextGlobal = {
          ...globalConfig,
          enabledTools: { ...globalConfig.enabledTools, [toolName]: value },
        };
        await toolConfigStorage.set(nextGlobal);
        setGlobalConfig(nextGlobal);
      }

      setAgentConfig(prev =>
        prev ? { ...prev, toolConfig: nextToolConfig, updatedAt: Date.now() } : null,
      );
      onReload();
    },
    [agentConfig, agentId, globalConfig, onReload],
  );

  const handleRemoveCustomTool = useCallback(
    async (toolName: string) => {
      if (!agentConfig) return;
      const customTools = (agentConfig.customTools ?? []).filter(ct => ct.name !== toolName);
      const currentToolConfig = agentConfig.toolConfig ?? {
        enabledTools: {},
        webSearchConfig: {
          provider: 'tavily' as const,
          tavily: { apiKey: '' },
          browser: { engine: 'google' as const },
        },
      };
      const nextEnabledTools = { ...currentToolConfig.enabledTools };
      delete nextEnabledTools[toolName];
      const nextToolConfig = { ...currentToolConfig, enabledTools: nextEnabledTools };

      await updateAgent(agentId, { customTools, toolConfig: nextToolConfig });
      setAgentConfig(prev =>
        prev ? { ...prev, customTools, toolConfig: nextToolConfig, updatedAt: Date.now() } : null,
      );
      toast.success(`Removed custom tool "${toolName}"`);
      onReload();
    },
    [agentConfig, agentId, onReload],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">Loading tools…</p>
      </div>
    );
  }

  if (!agentConfig || !globalConfig) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">Unable to load tool configuration.</p>
      </div>
    );
  }

  const agentEnabledTools = agentConfig.toolConfig?.enabledTools ?? {};

  /** Resolve enabled state: agent override > global config > registry default */
  const isEnabled = (toolName: string, defaultEnabled: boolean): boolean => {
    if (toolName in agentEnabledTools) return agentEnabledTools[toolName];
    if (toolName in globalConfig.enabledTools) return globalConfig.enabledTools[toolName];
    return defaultEnabled;
  };

  const customTools = agentConfig.customTools ?? [];

  return (
    <ScrollArea className="flex-1">
      <div className="space-y-4 p-6">
        {/* Built-in tools */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <WrenchIcon className="size-4" />
              Built-in Tools
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Non-Google tools */}
            {toolRegistryMeta
              .filter(g => !GOOGLE_GROUPS.has(g.groupKey))
              .map((group, idx) => {
                const Icon = agentToolIconMap[group.iconName];
                return (
                  <div key={group.groupKey}>
                    {idx > 0 && <Separator className="mb-4" />}
                    <div className="space-y-3">
                      <div className="flex items-center gap-3">
                        {Icon && <Icon className="text-muted-foreground size-4" />}
                        <span className="text-sm font-medium">{group.label}</span>
                      </div>
                      {group.tools.map(t => {
                        const checkboxId = `agent-tool-${t.name}`;
                        return (
                          <div key={t.name} className="flex items-center justify-between pl-7">
                            <div>
                              <Label className="text-sm" htmlFor={checkboxId}>
                                {t.label}
                              </Label>
                              <p className="text-muted-foreground text-xs">{t.description}</p>
                            </div>
                            <input
                              checked={isEnabled(t.name, t.defaultEnabled)}
                              className="accent-primary size-4"
                              id={checkboxId}
                              onChange={e => handleToggle(t.name, e.target.checked)}
                              type="checkbox"
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

            {/* Google Services */}
            <Separator className="mb-4" />
            <div className="space-y-3">
              <span className="text-sm font-medium">Google Services</span>
              {!isGoogleConnected && (
                <p className="text-muted-foreground text-xs">
                  Connect your Google account in the Tools tab to enable these tools
                </p>
              )}
            </div>
            {toolRegistryMeta
              .filter(g => GOOGLE_GROUPS.has(g.groupKey))
              .map(group => {
                const Icon = agentToolIconMap[group.iconName];
                return (
                  <div key={group.groupKey} className="space-y-3">
                    <div className="flex items-center gap-3 pl-4">
                      {Icon && <Icon className="text-muted-foreground size-4" />}
                      <span className="text-sm font-medium">{group.label}</span>
                    </div>
                    {group.tools.map(t => {
                      const checkboxId = `agent-tool-${t.name}`;
                      return (
                        <div
                          key={t.name}
                          className={`flex items-center justify-between pl-8${!isGoogleConnected ? ' opacity-50' : ''}`}>
                          <div>
                            <Label className="text-sm" htmlFor={checkboxId}>
                              {t.label}
                            </Label>
                            <p className="text-muted-foreground text-xs">{t.description}</p>
                          </div>
                          <input
                            checked={isEnabled(t.name, t.defaultEnabled)}
                            className={`accent-primary size-4${!isGoogleConnected ? ' pointer-events-none' : ''}`}
                            disabled={!isGoogleConnected}
                            id={checkboxId}
                            onChange={e => handleToggle(t.name, e.target.checked)}
                            type="checkbox"
                          />
                        </div>
                      );
                    })}
                  </div>
                );
              })}
          </CardContent>
        </Card>

        {/* Custom tools */}
        {customTools.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <CodeIcon className="size-4" />
                Custom Tools
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {customTools.map(ct => {
                const checkboxId = `agent-custom-tool-${ct.name}`;
                return (
                  <div key={ct.name} className="flex items-center justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Label className="text-sm" htmlFor={checkboxId}>
                          {ct.name}
                        </Label>
                        <Badge className="text-[10px]" variant="outline">
                          {ct.path}
                        </Badge>
                      </div>
                      <p className="text-muted-foreground text-xs">{ct.description}</p>
                      {ct.params.length > 0 && (
                        <p className="text-muted-foreground text-xs">
                          Params: {ct.params.map(p => p.name).join(', ')}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <input
                        checked={isEnabled(ct.name, true)}
                        className="accent-primary size-4"
                        id={checkboxId}
                        onChange={e => handleToggle(ct.name, e.target.checked)}
                        type="checkbox"
                      />
                      <button
                        className="text-muted-foreground hover:text-destructive rounded p-1"
                        onClick={() => handleRemoveCustomTool(ct.name)}
                        title="Remove custom tool"
                        type="button">
                        <TrashIcon className="size-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}
      </div>
    </ScrollArea>
  );
};

// ── Main component ───────────────────────────────────

const AgentsConfig = () => {
  const t = useT();
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState('main');
  const [allFiles, setAllFiles] = useState<DbWorkspaceFile[]>([]);
  const [skillFiles, setSkillFiles] = useState<DbWorkspaceFile[]>([]);
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('overview');
  const [loading, setLoading] = useState(true);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>(emptyConfirm);

  const loadAgents = useCallback(async () => {
    let agentList = await listAgents();
    // Auto-create the default agent if the DB is empty (fresh install / cleared DB)
    if (agentList.length === 0) {
      const now = Date.now();
      await createAgent({
        id: 'main',
        name: 'Main Agent',
        identity: { emoji: '' },
        isDefault: true,
        createdAt: now,
        updatedAt: now,
      });
      await seedPredefinedWorkspaceFiles('main');
      await copyGlobalSkillsToAgent('main');
      agentList = await listAgents();
    }
    setAgents(agentList);
    // Ensure selectedAgentId is valid
    setSelectedAgentId(prev => {
      if (!agentList.find(a => a.id === prev)) {
        const defaultAgent = agentList.find(a => a.isDefault) ?? agentList[0];
        return defaultAgent?.id ?? prev;
      }
      return prev;
    });
  }, []);

  const loadFiles = useCallback(async () => {
    const [files, skills] = await Promise.all([
      listWorkspaceFiles(selectedAgentId),
      listSkillFiles(selectedAgentId),
    ]);
    setAllFiles(files);
    setSkillFiles(skills);
    setLoading(false);
  }, [selectedAgentId]);

  useEffect(() => {
    loadAgents().then(() => loadFiles());
  }, [loadAgents, loadFiles]);

  const selectedAgent = useMemo(
    () => agents.find(a => a.id === selectedAgentId),
    [agents, selectedAgentId],
  );

  // Build agent info from IDENTITY.md
  const identityFile = useMemo(() => allFiles.find(f => f.name === 'IDENTITY.md'), [allFiles]);
  const identityContent = identityFile?.content ?? '';

  const agentInfo: AgentInfo = useMemo(
    () => ({
      id: selectedAgent?.id ?? 'main',
      name: selectedAgent?.name ?? 'Main Agent',
      emoji: selectedAgent?.identity?.emoji ?? '',
      isDefault: selectedAgent?.isDefault ?? true,
    }),
    [selectedAgent],
  );

  const agentInfoList: AgentInfo[] = useMemo(
    () =>
      agents.map(a => ({
        id: a.id,
        name: a.name,
        emoji: a.identity?.emoji ?? '',
        isDefault: a.isDefault,
      })),
    [agents],
  );

  const handleCreateAgent = useCallback(async () => {
    const id = nanoid(8);
    const now = Date.now();
    const newAgent: AgentConfig = {
      id,
      name: 'New Agent',
      identity: { emoji: '' },
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    };
    await createAgent(newAgent);
    await seedPredefinedWorkspaceFiles(id);
    await copyGlobalSkillsToAgent(id);
    setSelectedAgentId(id);
    await loadAgents();
    await loadFiles();
    toast.success(t('agents_agentCreated'));
  }, [loadAgents, loadFiles]);

  const handleDeleteAgent = useCallback(
    (id: string) => {
      setConfirmDialog({
        open: true,
        title: t('agents_deleteAgent'),
        description: t('agents_deleteAgentConfirm'),
        destructive: true,
        onConfirm: async () => {
          try {
            const currentActive = await activeAgentStorage.get();
            if (currentActive === id) {
              await activeAgentStorage.set('main');
            }
            await deleteAgent(id);
            setSelectedAgentId('main');
            await loadAgents();
            toast.success(t('agents_agentDeleted'));
          } catch (err) {
            toast.error(err instanceof Error ? err.message : t('agents_deleteAgentFailed'));
          }
        },
      });
    },
    [loadAgents],
  );

  const handleNameChange = useCallback(
    async (name: string) => {
      await updateAgent(selectedAgentId, { name });
      await loadAgents();
    },
    [selectedAgentId, loadAgents],
  );

  const handleEmojiChange = useCallback(
    async (emoji: string) => {
      const current = selectedAgent?.identity;
      await updateAgent(selectedAgentId, { identity: { ...current, emoji } });
      await loadAgents();
    },
    [selectedAgentId, selectedAgent, loadAgents],
  );

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <p className="text-muted-foreground text-sm">Loading agents...</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card className="overflow-hidden">
        <div className="flex h-[600px]">
          {/* Agent list panel */}
          <AgentListPanel
            agents={agentInfoList}
            onCreate={handleCreateAgent}
            onDelete={handleDeleteAgent}
            onSelect={id => {
              setSelectedAgentId(id);
              setActiveSubTab('overview');
            }}
            selectedId={selectedAgentId}
          />

          {/* Agent detail panel */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <AgentDetailHeader
              agent={agentInfo}
              onEmojiChange={handleEmojiChange}
              onNameChange={handleNameChange}
            />

            {/* Sub-tab buttons */}
            <div className="flex items-center gap-1 border-b px-6 py-2">
              <button
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  activeSubTab === 'overview'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted',
                )}
                onClick={() => setActiveSubTab('overview')}
                type="button">
                {t('agents_overview')}
              </button>
              <button
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  activeSubTab === 'files'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted',
                )}
                onClick={() => setActiveSubTab('files')}
                type="button">
                {t('agents_files')}
              </button>
              <button
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  activeSubTab === 'tools'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted',
                )}
                onClick={() => setActiveSubTab('tools')}
                type="button">
                {t('agents_tools')}
              </button>
              <button
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  activeSubTab === 'skills'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted',
                )}
                onClick={() => setActiveSubTab('skills')}
                type="button">
                {t('agents_skills')}
              </button>
            </div>

            {/* Sub-tab content */}
            {activeSubTab === 'overview' && (
              <ScrollArea className="flex-1">
                <div className="space-y-4 p-6">
                  <AgentOverview identityContent={identityContent} />
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm">{t('agents_workspaceFiles')}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-muted-foreground text-sm">
                        {allFiles.length} file{allFiles.length !== 1 ? 's' : ''}
                        {skillFiles.length > 0 &&
                          `, ${skillFiles.length} skill${skillFiles.length !== 1 ? 's' : ''}`}
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </ScrollArea>
            )}
            {activeSubTab === 'files' && (
              <AgentFilesTab
                files={allFiles}
                agentId={selectedAgentId}
                onReload={loadFiles}
              />
            )}
            {activeSubTab === 'tools' && (
              <AgentToolsTab agentId={selectedAgentId} onReload={loadAgents} />
            )}
            {activeSubTab === 'skills' && (
              <SkillConfig agentId={selectedAgentId} onMutate={loadFiles} />
            )}
          </div>
        </div>
      </Card>

      <ConfirmDialog state={confirmDialog} onClose={() => setConfirmDialog(emptyConfirm)} />
    </>
  );
};

export { AgentsConfig, formatFileSize, formatTimeAgo, parseIdentityField };
