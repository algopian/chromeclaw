import { useT } from '@extension/i18n';
import { importSkillFromZip, parseSkillFrontmatter } from '@extension/shared';
import {
  listSkillFiles,
  listWorkspaceFiles,
  createWorkspaceFile,
  updateWorkspaceFile,
  deleteWorkspaceFilesByPrefix,
  copyGlobalSkillsToAllAgents,
} from '@extension/storage';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ScrollArea,
  cn,
} from '@extension/ui';
import {
  ZapIcon,
  UploadIcon,
  TrashIcon,
  AlertTriangleIcon,
} from 'lucide-react';
import { nanoid } from 'nanoid';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { DbWorkspaceFile } from '@extension/storage';
import { getSkillDisplayName } from './skill-display-utils.js';
import type { SkillWithMeta } from './skill-display-utils.js';
import { ConfirmDialog, emptyConfirm } from './confirm-dialog.js';
import type { ConfirmDialogState } from './confirm-dialog.js';

interface SkillConfigProps {
  agentId?: string;
  onMutate?: () => void;
}

const SkillConfig = ({ agentId, onMutate }: SkillConfigProps) => {
  const t = useT();
  const [skills, setSkills] = useState<SkillWithMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>(emptyConfirm);
  const importInputRef = useRef<HTMLInputElement>(null);

  const loadSkills = useCallback(async () => {
    const files = await listSkillFiles(agentId);
    const enriched: SkillWithMeta[] = files.map(file => {
      const meta = parseSkillFrontmatter(file.content);
      return {
        file,
        displayName: meta?.name ?? getSkillDisplayName(file.name),
        description: meta?.description ?? '',
      };
    });
    setSkills(enriched);
    setLoading(false);
  }, [agentId]);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const notifyMutate = useCallback(async () => {
    await loadSkills();
    onMutate?.();
  }, [loadSkills, onMutate]);

  const handleToggle = useCallback(
    async (file: DbWorkspaceFile) => {
      if (agentId && (!file.agentId || file.agentId === '')) {
        // Agent context + global skill — create an agent-scoped override
        await createWorkspaceFile({
          id: nanoid(),
          name: file.name,
          content: file.content,
          enabled: !file.enabled,
          owner: file.owner,
          predefined: file.predefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          agentId,
        });
      } else {
        await updateWorkspaceFile(file.id, { enabled: !file.enabled });
      }
      await notifyMutate();
    },
    [agentId, notifyMutate],
  );

  const handleDelete = useCallback(
    (file: DbWorkspaceFile) => {
      const skill = skills.find(s => s.file.id === file.id);
      const name = skill?.displayName ?? file.name;
      // Derive the skill directory prefix (e.g. "skills/my-skill/") from the SKILL.md path
      const skillDirPrefix = file.name.replace(/SKILL\.md$/, '');
      setConfirmDialog({
        open: true,
        title: t('common_delete'),
        description: t('skill_deleteConfirm', name),
        destructive: true,
        onConfirm: async () => {
          await deleteWorkspaceFilesByPrefix(skillDirPrefix, agentId);
          await notifyMutate();
          toast.success(t('skill_deleted'));
        },
      });
    },
    [skills, agentId, notifyMutate, t],
  );

  const handleImportSkill = useCallback(() => {
    importInputRef.current?.click();
  }, []);

  const handleImportFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = '';

      try {
        const result = await importSkillFromZip(file);
        const existing = await listWorkspaceFiles(agentId);
        const skillDirPrefix = result.skillDir + '/';
        if (existing.find(f => f.name.startsWith(skillDirPrefix))) {
          toast.error(t('skill_importExists', skillDirPrefix));
          return;
        }
        const now = Date.now();
        for (const importFile of result.files) {
          const wsFile: DbWorkspaceFile = {
            id: nanoid(),
            name: `${result.skillDir}/${importFile.path}`,
            content: importFile.content,
            enabled: true,
            owner: 'user',
            predefined: false,
            createdAt: now,
            updatedAt: now,
            ...(agentId ? { agentId } : {}),
          };
          await createWorkspaceFile(wsFile);
        }
        if (!agentId) {
          await copyGlobalSkillsToAllAgents();
        }
        await notifyMutate();
        toast.success(t('skill_importedSkill', result.name));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('skill_importFailed'));
      }
    },
    [agentId, notifyMutate, t],
  );

  const skillList = (
    <>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{t('skill_installedSkills')}</h3>
        <div className="flex gap-2">
          <Button onClick={handleImportSkill} size="sm" variant="outline">
            <UploadIcon className="mr-1 size-4" /> {t('skill_importZip')}
          </Button>
        </div>
      </div>
      {loading ? (
        <p className="text-muted-foreground text-sm">{t('skill_loadingSkills')}</p>
      ) : skills.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('skill_noSkills')}</p>
      ) : (
        <div className="divide-y rounded-md border">
          {skills.map(({ file, displayName, description }) => (
            <div className="flex items-center gap-3 px-3 py-2.5" key={file.id}>
              <ZapIcon className="size-4 shrink-0 text-amber-500" />
              <div className="min-w-0 flex-1">
                <div
                  className={cn(
                    'text-sm font-medium',
                    !file.enabled && 'text-muted-foreground line-through',
                  )}>
                  {displayName}
                </div>
                {description && (
                  <p className="text-muted-foreground truncate text-xs">{description}</p>
                )}
              </div>
              <button
                className={cn(
                  'shrink-0 rounded px-1.5 py-0.5 text-xs font-medium',
                  file.enabled ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                )}
                onClick={() => handleToggle(file)}
                title={file.enabled ? 'Disable' : 'Enable'}
                type="button">
                {file.enabled ? t('common_on') : t('common_off')}
              </button>
              <div className="flex shrink-0 gap-1">
                {!file.predefined && (
                  <Button
                    onClick={() => handleDelete(file)}
                    size="icon-sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive">
                    <TrashIcon className="size-4" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );

  const hiddenInput = (
    <input
      accept=".zip"
      className="hidden"
      onChange={handleImportFileSelected}
      ref={importInputRef}
      type="file"
    />
  );

  if (agentId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ScrollArea className="flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block">
          <div className="space-y-4 p-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <ZapIcon className="size-4 text-amber-500" />
                  {t('skill_title')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">{skillList}</CardContent>
            </Card>
          </div>
        </ScrollArea>
        {hiddenInput}
        <ConfirmDialog state={confirmDialog} onClose={() => setConfirmDialog(emptyConfirm)} />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ZapIcon className="size-5 text-amber-500" />
          {t('skill_title')}
        </CardTitle>
        <CardDescription>{t('skill_description')}</CardDescription>
        <p className="text-muted-foreground mt-2 flex items-start gap-1.5 text-xs">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          {t('skill_browserWarning')}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {skillList}
        {hiddenInput}
      </CardContent>
      <ConfirmDialog state={confirmDialog} onClose={() => setConfirmDialog(emptyConfirm)} />
    </Card>
  );
};

export { SkillConfig };
