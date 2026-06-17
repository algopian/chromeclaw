import { imageContentToSrc } from '../../image-src';
import { cn } from '../../utils';

type ImageEditorProps = {
  content: string;
  title: string;
  status: 'streaming' | 'idle';
  isCurrentVersion: boolean;
  isInline?: boolean;
};

const ImageEditor = ({ content, title, status, isCurrentVersion, isInline }: ImageEditorProps) => {
  if (!content) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
        {status === 'streaming' ? 'Generating image...' : 'No image'}
      </div>
    );
  }

  const src = imageContentToSrc(content);

  return (
    <div
      className={cn(
        'flex items-center justify-center',
        isInline ? 'h-full' : 'h-full p-4',
        !isCurrentVersion && 'opacity-60',
      )}>
      <img
        alt={title}
        className={cn(
          'max-h-full rounded-lg object-contain',
          isInline ? 'max-w-full' : 'max-w-[90%]',
        )}
        src={src}
      />
    </div>
  );
};

export { ImageEditor };
