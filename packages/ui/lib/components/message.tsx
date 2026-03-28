import { DocumentPreview } from './document-preview';
import { ImageEditor } from './editors/image-editor';
import { MessageContent } from './elements/message';
import { Response } from './elements/response';
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from './elements/tool';
import { SparklesIcon } from './icons';
import { MessageActions } from './message-actions';
import { MessageEditor } from './message-editor';
import { MessageReasoning } from './message-reasoning';
import { PreviewAttachment } from './preview-attachment';
import { SearchResults, parseSearchResults } from './search-results';
import { isDocumentToolCall } from '../artifact-stream';
import { cn } from '../utils';
import { useState, useMemo, useCallback } from 'react';
import { toast } from 'sonner';
import type {
  ChatMessage,
  ChatMessagePart,
  StreamingStatus,
  ToolPartState,
} from '@extension/shared';

type PreviewMessageProps = {
  message: ChatMessage;
  isLoading: boolean;
  setMessages?: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  onEditSubmit?: (messageId: string, content: string) => void;
};

const PreviewMessage = ({ message, isLoading, setMessages, onEditSubmit }: PreviewMessageProps) => {
  const [mode, setMode] = useState<'view' | 'edit'>('view');

  const textContent = useMemo(
    () =>
      message.parts
        ?.filter((p): p is Extract<ChatMessagePart, { type: 'text' }> => p.type === 'text')
        .map(p => p.text)
        .join('') ?? '',
    [message.parts],
  );

  if (mode === 'edit' && message.role === 'user') {
    return (
      <div
        className="group/message fade-in animate-in w-full duration-200"
        data-role={message.role}
        data-testid={`message-${message.role}`}>
        <div className="flex w-full items-start justify-end gap-2 md:gap-3">
          <div className="max-w-[calc(100%-2.5rem)] sm:max-w-[min(fit-content,80%)]">
            <MessageEditor
              initialContent={textContent}
              onCancel={() => setMode('view')}
              onSend={content => {
                setMode('view');
                onEditSubmit?.(message.id, content);
              }}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="group/message fade-in animate-in w-full duration-200"
      data-role={message.role}
      data-testid={`message-${message.role}`}>
      <div
        className={cn('flex w-full items-start gap-2 md:gap-3', {
          'justify-end': message.role === 'user',
          'justify-start': message.role === 'assistant',
        })}>
        {message.role === 'assistant' && (
          <div className="bg-background ring-border -mt-1 flex size-8 shrink-0 items-center justify-center rounded-full ring-1">
            <SparklesIcon size={14} />
          </div>
        )}

        <div
          className={cn('flex flex-col', {
            'gap-2 md:gap-4': message.parts?.some(
              p => p.type === 'text' && 'text' in p && p.text?.trim(),
            ),
            'w-full':
              message.role === 'assistant' &&
              (message.parts?.some(p => p.type === 'text' && 'text' in p && p.text?.trim()) ||
                message.parts?.some(p => p.type === 'tool-call')),
            'max-w-[calc(100%-2.5rem)] sm:max-w-[min(fit-content,80%)]': message.role === 'user',
          })}>
          {/* File attachments for user messages */}
          {message.role === 'user' &&
            (() => {
              const fileParts = message.parts?.filter(
                (p): p is Extract<ChatMessagePart, { type: 'file' }> => p.type === 'file',
              );
              if (!fileParts?.length) return null;
              return (
                <div className="flex justify-end gap-2" data-testid="message-attachments">
                  {fileParts.map((fp, i) => (
                    <PreviewAttachment
                      attachment={{
                        name: fp.filename ?? 'file',
                        url: fp.url,
                        contentType: fp.mediaType ?? '',
                      }}
                      key={`${message.id}-file-${i}`}
                    />
                  ))}
                </div>
              );
            })()}

          {message.parts?.map((part, index) => {
            const key = `message-${message.id}-part-${index}`;

            if (part.type === 'reasoning') {
              const hasContent = part.text?.trim().length > 0;
              if (hasContent || isLoading) {
                return (
                  <MessageReasoning isLoading={isLoading} key={key} reasoning={part.text || ''} />
                );
              }
            }

            if (part.type === 'text') {
              return (
                <div key={key}>
                  <MessageContent
                    className={cn({
                      'wrap-break-word w-fit rounded-2xl px-3 py-2 text-right text-white':
                        message.role === 'user',
                      'bg-transparent px-0 py-0 text-left': message.role === 'assistant',
                    })}
                    data-testid="message-content"
                    style={message.role === 'user' ? { backgroundColor: '#006cff' } : undefined}>
                    <Response>{part.text}</Response>
                  </MessageContent>
                </div>
              );
            }

            if (part.type === 'file' && message.role !== 'user') {
              const isImage = part.mediaType?.startsWith('image/');
              if (isImage) {
                return (
                  <div className="my-1" key={key}>
                    <img
                      alt={part.filename ?? 'image'}
                      className="max-h-96 max-w-full rounded-lg object-contain"
                      src={
                        (part.data ?? part.url).startsWith('data:') ||
                        (part.data ?? part.url).startsWith('http')
                          ? (part.data ?? part.url)
                          : `data:image/png;base64,${part.data ?? part.url}`
                      }
                    />
                  </div>
                );
              }
              return (
                <div className="text-muted-foreground my-1 text-sm" key={key}>
                  {part.filename ?? 'file'}
                </div>
              );
            }

            if (part.type === 'tool-call' && isDocumentToolCall(part)) {
              const result = part.result as
                | { id?: string; title?: string; kind?: string }
                | undefined;
              const args = part.args as { title?: string; kind?: string } | undefined;
              return (
                <div className="w-full" key={key}>
                  <DocumentPreview
                    args={
                      args
                        ? {
                            title: args.title ?? 'Untitled',
                            kind: (args.kind ?? 'text') as 'text' | 'code' | 'sheet' | 'image',
                          }
                        : undefined
                    }
                    result={
                      result?.id
                        ? {
                            id: result.id,
                            title: result.title ?? 'Untitled',
                            kind: (result.kind ?? 'text') as 'text' | 'code' | 'sheet' | 'image',
                          }
                        : undefined
                    }
                  />
                </div>
              );
            }

            if (part.type === 'tool-call') {
              const state = (part.state ?? 'input-available') as ToolPartState;

              return (
                <ToolCallPart
                  args={part.args}
                  key={part.toolCallId}
                  part={part}
                  result={part.result}
                  state={state}
                  toolName={part.toolName}
                />
              );
            }

            return null;
          })}

          {/* Message actions (copy / edit) */}
          {!isLoading && textContent && (
            <MessageActions
              content={textContent}
              onEdit={
                message.role === 'user' && setMessages && onEditSubmit
                  ? () => setMode('edit')
                  : undefined
              }
              role={message.role}
            />
          )}
        </div>
      </div>
    </div>
  );
};

type ToolCallPartProps = {
  part: Extract<ChatMessagePart, { type: 'tool-call' }>;
  state: ToolPartState;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
};

const ToolCallPart = ({ part, state, toolName, args, result }: ToolCallPartProps) => {
  const handleCopy = useCallback(() => {
    const parts = [
      `Tool: ${toolName}`,
      `Parameters: ${JSON.stringify(args, null, 2)}`,
      result != null
        ? `Result: ${typeof result === 'string' ? result : JSON.stringify(result, null, 2)}`
        : null,
    ];
    navigator.clipboard.writeText(parts.filter(Boolean).join('\n\n')).then(() => {
      toast.success('Copied to clipboard');
    });
  }, [toolName, args, result]);

  const isComplete = state === 'output-available' || state === 'output-error';

  return (
  <div className="w-full" key={part.toolCallId}>
    <Tool className="w-full" defaultOpen={true}>
      <ToolHeader name={toolName} onCopy={isComplete ? handleCopy : undefined} state={state} />
      <ToolContent>
        {(state === 'input-available' || state === 'output-available' || state === 'output-error') && (
          <ToolInput input={args} />
        )}

        {state === 'output-available' && result != null ? (
          <ToolOutput output={<ToolResultRenderer result={result} toolName={toolName} />} />
        ) : null}

        {state === 'output-error' && result != null ? (
          <ToolOutput
            errorText={typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
            output={null}
          />
        ) : null}
      </ToolContent>
    </Tool>
  </div>
  );
};

const ToolResultRenderer = ({ toolName, result }: { toolName: string; result: unknown }) => {
  if (toolName === 'web_search') {
    const results = parseSearchResults(result);
    if (results.length > 0) {
      return (
        <div className="p-3">
          <SearchResults results={results} />
        </div>
      );
    }
  }

  return <pre className="p-3">{JSON.stringify(result, null, 2)}</pre>;
};

const ThinkingMessage = () => (
  <div
    className="group/message fade-in animate-in w-full duration-300"
    data-role="assistant"
    data-testid="message-assistant-loading">
    <div className="flex items-start justify-start gap-3">
      <div className="bg-background ring-border -mt-1 flex size-8 shrink-0 items-center justify-center rounded-full ring-1">
        <div className="animate-pulse">
          <SparklesIcon size={14} />
        </div>
      </div>

      <div className="flex w-full flex-col gap-2 md:gap-4">
        <div className="text-muted-foreground flex items-center gap-1 p-0 text-sm">
          <span className="animate-pulse">Thinking</span>
          <span className="inline-flex">
            <span className="animate-bounce [animation-delay:0ms]">.</span>
            <span className="animate-bounce [animation-delay:150ms]">.</span>
            <span className="animate-bounce [animation-delay:300ms]">.</span>
          </span>
        </div>
      </div>
    </div>
  </div>
);

export { PreviewMessage, ThinkingMessage };
export type { PreviewMessageProps, StreamingStatus };
