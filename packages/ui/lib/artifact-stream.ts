import { saveArtifact } from '@extension/storage';
import { nanoid } from 'nanoid';
import type { UIArtifact } from './artifact-types';
import type { ChatMessagePart } from '@extension/shared';
import type { Dispatch, SetStateAction } from 'react';

/**
 * Detect create_document tool calls in message parts
 * and update the UIArtifact state accordingly.
 */
const processArtifactToolCall = (
  part: ChatMessagePart,
  setArtifact: Dispatch<SetStateAction<UIArtifact>>,
  chatId?: string,
): boolean => {
  if (part.type !== 'tool-call') return false;

  if (part.toolName !== 'create_document') return false;

  const args = part.args as Record<string, unknown> | undefined;
  if (!args) return false;

  const documentId = (args.id as string) ?? nanoid();
  const title = (args.title as string) ?? 'Untitled';
  const kind = (args.kind as string) ?? 'text';

  setArtifact(prev => ({
    ...prev,
    documentId,
    chatId,
    title,
    kind: kind as UIArtifact['kind'],
    isVisible: true,
    status: 'streaming',
    content: '',
  }));

  return true;
};

/**
 * Process a text delta that may belong to an artifact stream.
 * Returns true if the delta was consumed by an artifact.
 */
const processArtifactDelta = (
  delta: string,
  artifact: UIArtifact,
  setArtifact: Dispatch<SetStateAction<UIArtifact>>,
): boolean => {
  if (artifact.status !== 'streaming' || artifact.documentId === 'init') return false;

  setArtifact(prev => ({
    ...prev,
    content: prev.content + delta,
    isVisible: prev.isVisible || prev.content.length > 300,
  }));

  return true;
};

/**
 * Finalize the artifact stream and save to IndexedDB.
 */
const finalizeArtifact = async (
  artifact: UIArtifact,
  chatId: string,
  setArtifact: Dispatch<SetStateAction<UIArtifact>>,
): Promise<void> => {
  if (artifact.documentId === 'init' || !artifact.content) return;

  setArtifact(prev => ({ ...prev, status: 'idle' }));

  const now = Date.now();
  await saveArtifact({
    id: artifact.documentId,
    chatId,
    kind: artifact.kind,
    title: artifact.title,
    content: artifact.content,
    createdAt: now,
    updatedAt: now,
  });
};

/**
 * Detect if a message part is a create_document tool call.
 */
const isDocumentToolCall = (part: ChatMessagePart): boolean =>
  part.type === 'tool-call' && part.toolName === 'create_document';

export { processArtifactToolCall, processArtifactDelta, finalizeArtifact, isDocumentToolCall };
