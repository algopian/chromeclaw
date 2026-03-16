import { useArtifact } from '../hooks/use-artifact';
import { cn } from '../utils';
import { getArtifactById } from '@extension/storage';
import { FileIcon, ImageIcon, Loader2Icon, MaximizeIcon } from 'lucide-react';
import { useCallback, useRef } from 'react';
import type { ArtifactKind } from '../artifact-types';
import type { MouseEvent } from 'react';

type DocumentPreviewProps = {
  result?: { id: string; title: string; kind: ArtifactKind };
  args?: { title: string; kind: ArtifactKind };
};

const DocumentPreview = ({ result, args }: DocumentPreviewProps) => {
  const { artifact, setArtifact } = useArtifact();
  const hitboxRef = useRef<HTMLDivElement>(null);

  const title = result?.title ?? args?.title ?? 'Untitled';
  const kind = result?.kind ?? args?.kind ?? 'text';
  const documentId = result?.id ?? artifact.documentId;
  const isStreaming = artifact.status === 'streaming';

  const handleClick = useCallback(
    async (e: MouseEvent<HTMLDivElement>) => {
      e.stopPropagation();
      if (artifact.status === 'streaming') {
        setArtifact(prev => ({ ...prev, isVisible: true }));
        return;
      }
      // Try loading content from IndexedDB
      if (documentId && documentId !== 'init') {
        try {
          const stored = await getArtifactById(documentId);
          if (stored) {
            setArtifact({
              documentId,
              chatId: stored.chatId,
              title,
              kind,
              content: stored.content,
              isVisible: true,
              status: 'idle',
            });
            return;
          }
        } catch {
          // Fall through to default behavior
        }
      }
      // Fallback: open panel with whatever content is available
      setArtifact(prev => ({ ...prev, documentId, title, kind, isVisible: true }));
    },
    [setArtifact, documentId, title, kind, artifact.status],
  );

  // If artifact is already visible, show a compact reference
  if (artifact.isVisible) {
    return (
      <div className="border-border inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm">
        {kind === 'image' ? <ImageIcon className="size-4" /> : <FileIcon className="size-4" />}
        <span className="truncate">{title}</span>
      </div>
    );
  }

  return (
    <div
      className={cn('relative w-full max-w-sm cursor-pointer')}
      onClick={handleClick}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ')
          handleClick(e as unknown as MouseEvent<HTMLDivElement>);
      }}
      ref={hitboxRef}
      role="button"
      tabIndex={0}>
      {/* Header */}
      <div className="border-border dark:bg-muted flex items-center justify-between gap-2 rounded-t-xl border border-b-0 p-3">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">
            {isStreaming ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : kind === 'image' ? (
              <ImageIcon className="size-4" />
            ) : (
              <FileIcon className="size-4" />
            )}
          </span>
          <span className="truncate text-sm font-medium">{title}</span>
        </div>
        <MaximizeIcon className="text-muted-foreground size-4" />
      </div>

      {/* Preview body */}
      <div className="border-border bg-muted dark:bg-muted h-24 overflow-hidden rounded-b-xl border border-t-0 p-4">
        {kind === 'image' ? (
          <div className="bg-muted-foreground/20 h-full w-full animate-pulse rounded" />
        ) : (
          <div className="space-y-2">
            <div className="bg-muted-foreground/20 h-3 w-3/4 animate-pulse rounded" />
            <div className="bg-muted-foreground/20 h-3 w-1/2 animate-pulse rounded" />
            <div className="bg-muted-foreground/20 h-3 w-2/3 animate-pulse rounded" />
          </div>
        )}
      </div>
    </div>
  );
};

export { DocumentPreview };
