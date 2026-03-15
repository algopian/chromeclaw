/** Artifact kind — matches the tool names used in the LLM system prompt. */
type ArtifactKind = 'text' | 'code' | 'sheet' | 'image';

/** UI state for the currently-active artifact. */
interface UIArtifact {
  documentId: string;
  chatId?: string;
  title: string;
  kind: ArtifactKind;
  content: string;
  isVisible: boolean;
  status: 'streaming' | 'idle';
}

/** Stored artifact version in IndexedDB. */
interface ArtifactVersion {
  id: string;
  documentId: string;
  content: string;
  createdAt: number;
}

export type { ArtifactKind, UIArtifact, ArtifactVersion };
