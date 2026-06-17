/**
 * Image artifact definition.
 *
 * Ported from ai-chatbot `artifacts/image/client.tsx`.
 * - Removed `'use client'` directive
 * - Replaced `@/` imports with `@extension/ui` and relative paths
 * - Uses local `ImageEditor` from `../components/editors/image-editor`
 */

import { Artifact } from '../components/create-artifact';
import { ImageEditor } from '../components/editors/image-editor';
import { CopyIcon, RedoIcon, UndoIcon } from '../components/icons';
import { imageContentToSrc } from '../image-src';
import { toast } from 'sonner';

export const imageArtifact = new Artifact({
  kind: 'image',
  description: 'Useful for image generation',
  onStreamPart: ({ streamPart, setArtifact }) => {
    const part = streamPart as { type: string; data: unknown };

    if (part.type === 'data-imageDelta') {
      setArtifact(draftArtifact => ({
        ...draftArtifact,
        content: part.data as string,
        isVisible: true,
        status: 'streaming',
      }));
    }
  },
  content: ({ content, title, status, isCurrentVersion, isInline }) => (
    <ImageEditor
      content={content}
      isCurrentVersion={isCurrentVersion}
      isInline={isInline}
      status={status}
      title={title}
    />
  ),
  actions: [
    {
      icon: <UndoIcon size={18} />,
      description: 'View Previous version',
      onClick: ({ handleVersionChange }) => {
        handleVersionChange('prev');
      },
      isDisabled: ({ currentVersionIndex }) => currentVersionIndex === 0,
    },
    {
      icon: <RedoIcon size={18} />,
      description: 'View Next version',
      onClick: ({ handleVersionChange }) => {
        handleVersionChange('next');
      },
      isDisabled: ({ isCurrentVersion }) => isCurrentVersion,
    },
    {
      icon: <CopyIcon size={18} />,
      description: 'Copy image to clipboard',
      onClick: ({ content }) => {
        const img = new Image();
        img.src = imageContentToSrc(content);

        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          ctx?.drawImage(img, 0, 0);
          canvas.toBlob(blob => {
            if (blob) {
              navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            }
          }, 'image/png');
        };

        toast.success('Copied image to clipboard!');
      },
    },
  ],
  toolbar: [],
});
