import { CodeEditor } from './editors/code-editor';
import { ImageEditor } from './editors/image-editor';
import { MarkdownEditor, type MarkdownEditorMode } from './editors/markdown-editor';
import { SheetEditor } from './editors/sheet-editor';
import { DocumentSkeleton } from './document-skeleton';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui';
import { initialArtifactData, useArtifact } from '../hooks/use-artifact';
import { createWorkspaceFile } from '@extension/storage';
import { AnimatePresence, motion } from 'framer-motion';
import { CopyIcon, DownloadIcon, FolderIcon, SaveIcon, XIcon } from 'lucide-react';
import { nanoid } from 'nanoid';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

const PureArtifactPanel = () => {
  const { artifact, setArtifact } = useArtifact();

  const [editorContent, setEditorContent] = useState(artifact.content);
  const [editorMode, setEditorMode] = useState<MarkdownEditorMode>('raw');
  const lastSyncedContentRef = useRef(artifact.content);

  // Sync editorContent when artifact changes externally (streaming or switching artifacts)
  useEffect(() => {
    if (artifact.content !== lastSyncedContentRef.current) {
      setEditorContent(artifact.content);
      lastSyncedContentRef.current = artifact.content;
      setEditorMode('raw');
    }
  }, [artifact.documentId, artifact.content]);

  const handleContentChange = useCallback((value: string) => {
    setEditorContent(value);
  }, []);

  const handleClose = useCallback(() => {
    setArtifact(current =>
      current.status === 'streaming'
        ? { ...current, isVisible: false }
        : { ...initialArtifactData, status: 'idle' },
    );
  }, [setArtifact]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(artifact.kind === 'text' ? editorContent : artifact.content);
    toast.success('Copied to clipboard!');
  }, [artifact.content, artifact.kind, editorContent]);

  const handleSaveToDisk = useCallback(() => {
    const filename = `${artifact.title || 'untitled'}.md`;
    const blob = new Blob([editorContent], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Downloaded as ' + filename);
  }, [artifact.title, editorContent]);

  const handleSaveToWorkspace = useCallback(async () => {
    const now = Date.now();
    await createWorkspaceFile({
      id: nanoid(),
      name: `documents/${artifact.title || 'untitled'}.md`,
      content: editorContent,
      enabled: true,
      owner: 'user',
      predefined: false,
      createdAt: now,
      updatedAt: now,
    });
    toast.success('Saved to workspace');
  }, [artifact.title, editorContent]);

  const isTextArtifact = artifact.kind === 'text';
  const isIdle = artifact.status === 'idle';
  const charCount = editorContent.length;
  const tokenEstimate = Math.ceil(charCount / 4);

  const renderContent = () => {
    if (!artifact.content && !editorContent && artifact.status === 'idle') {
      return <DocumentSkeleton artifactKind={artifact.kind} />;
    }

    const commonProps = {
      content: artifact.content,
      status: artifact.status,
      isCurrentVersion: true,
    };

    switch (artifact.kind) {
      case 'text':
        return (
          <MarkdownEditor
            className="px-4 py-8 md:px-14 md:py-12"
            content={editorContent}
            streaming={artifact.status === 'streaming'}
            onChange={isIdle ? handleContentChange : undefined}
            mode={editorMode}
            onModeChange={setEditorMode}
            toolbarActions={isIdle && editorContent ? [
              { icon: DownloadIcon, title: 'Save to disk', onClick: handleSaveToDisk },
              { icon: FolderIcon, title: 'Save to workspace', onClick: handleSaveToWorkspace },
            ] : undefined}
          />
        );
      case 'code':
        return <CodeEditor {...commonProps} />;
      case 'sheet':
        return <SheetEditor {...commonProps} />;
      case 'image':
        return <ImageEditor {...commonProps} isInline={false} title={artifact.title} />;
      default:
        return (
          <MarkdownEditor
            className="px-4 py-8 md:px-14 md:py-12"
            content={editorContent}
            streaming={artifact.status === 'streaming'}
            onChange={isIdle ? handleContentChange : undefined}
            mode={editorMode}
            onModeChange={setEditorMode}
            toolbarActions={isIdle && editorContent ? [
              { icon: DownloadIcon, title: 'Save to disk', onClick: handleSaveToDisk },
              { icon: FolderIcon, title: 'Save to workspace', onClick: handleSaveToWorkspace },
            ] : undefined}
          />
        );
    }
  };

  return (
    <AnimatePresence>
      {artifact.isVisible && (
        <motion.div
          animate={{ opacity: 1, x: 0 }}
          className="bg-background fixed inset-0 z-50 flex flex-col"
          exit={{ opacity: 0, x: 100 }}
          initial={{ opacity: 0, x: 100 }}>
          {/* Header */}
          <div className="flex items-center justify-between border-b p-2">
            <div className="flex items-center gap-2">
              <Button onClick={handleClose} size="icon-sm" variant="ghost">
                <XIcon className="size-4" />
              </Button>
              <div className="flex flex-col">
                <span className="truncate text-sm font-medium">{artifact.title || 'Untitled'}</span>
                {artifact.status === 'streaming' && (
                  <span className="text-muted-foreground text-xs">Streaming...</span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-1">
              {isTextArtifact && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      disabled={!editorContent || !isIdle}
                      size="icon-sm"
                      variant="ghost">
                      <SaveIcon className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={handleSaveToDisk}>
                      <DownloadIcon className="mr-2 size-4" />
                      Save to disk
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={handleSaveToWorkspace}>
                      <FolderIcon className="mr-2 size-4" />
                      Save to workspace
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <Button
                disabled={!artifact.content || artifact.status === 'streaming'}
                onClick={handleCopy}
                size="icon-sm"
                variant="ghost">
                <CopyIcon className="size-4" />
              </Button>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-hidden">{renderContent()}</div>

          {/* Footer — text artifacts only */}
          {isTextArtifact && (
            <div className="text-muted-foreground flex items-center justify-between border-t px-3 py-1.5 text-xs">
              <span>
                {charCount.toLocaleString()} chars / ~{tokenEstimate.toLocaleString()} tokens
              </span>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
};

const ArtifactPanel = memo(PureArtifactPanel);

export { ArtifactPanel };
