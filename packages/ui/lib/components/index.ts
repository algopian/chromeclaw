// Core chat components
export { Chat } from './chat';
export type { ChatProps } from './chat';
export { AgentSwitcher } from './agent-switcher';
export type { AgentSwitcherProps, AgentSwitcherAgent } from './agent-switcher';
export { Messages } from './messages';
export { PreviewMessage, ThinkingMessage } from './message';
export type { PreviewMessageProps } from './message';
export { MessageReasoning } from './message-reasoning';
export { MessageActions } from './message-actions';
export type { MessageActionsProps } from './message-actions';
export { MessageEditor } from './message-editor';
export type { MessageEditorProps } from './message-editor';
export { ChatInput } from './chat-input';
export { ChatHeader } from './chat-header';
export type { ChatHeaderProps } from './chat-header';
export { ContextStatusBadge } from './context-status';
export type { ContextStatusBadgeProps } from './context-status';
export {
  ChatSidebar,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  clampSidebarWidth,
} from './sidepanel-sidebar';
export type { ChatSidebarProps } from './sidepanel-sidebar';
export { SessionList } from './session-list';
export type { SessionListProps } from './session-list';
export { Greeting } from './greeting';
export { SuggestedActions } from './suggested-actions';
export type { SuggestedActionsProps } from './suggested-actions';

// Setup
export { FirstRunSetup } from './first-run-setup';
export type { FirstRunSetupProps } from './first-run-setup';

// Artifacts
export { ArtifactPanel } from './artifact-panel';
export { ArtifactActions } from './artifact-actions';
export { ArtifactCloseButton } from './artifact-close-button';
export { ArtifactMessages } from './artifact-messages';
export { Artifact } from './create-artifact';
export type {
  ArtifactActionContext,
  ArtifactToolbarContext,
  ArtifactToolbarItem,
} from './create-artifact';
export { DocumentPreview } from './document-preview';
export { DiffView } from './diffview';
export { DocumentToolResult, DocumentToolCall } from './document';
export {
  DocumentSkeleton as ArtifactDocumentSkeleton,
  InlineDocumentSkeleton,
} from './document-skeleton';
export { Toolbar, Tools } from './toolbar';
export { VersionFooter } from './version-footer';

// Tool results
export { SearchResults, parseSearchResults } from './search-results';
export type { SearchResult } from './search-results';

// Attachments
export { PreviewAttachment } from './preview-attachment';
export type { PreviewAttachmentProps } from './preview-attachment';
export { AttachmentsButton } from './attachments-button';
export type { AttachmentsButtonProps } from './attachments-button';
export { MicButton } from './mic-button';
export type { MicButtonProps } from './mic-button';

// Data stream
export { DataStreamProvider, useDataStream } from './data-stream-provider';
export type { DataStreamDelta } from './data-stream-provider';
export { DataStreamHandler } from './data-stream-handler';

// Console (code execution output)
export { Console } from './console';
export type { ConsoleOutput, ConsoleOutputContent } from './console';

// Theme
export { ThemeProvider, useTheme } from './theme-provider';

// UI components
export { SubmitButton } from './submit-button';
export { toast } from './toast';
export type { ToastProps } from './toast';
export { ChatItem } from './sidebar-history-item';
export { VisibilitySelector } from './visibility-selector';
export type { VisibilityType } from './visibility-selector';

// Sub-modules (elements and editors are re-exported inline; ai-elements has
// too many naming collisions so consumers import from '@extension/ui/ai-elements')
export * from './elements/index';
export * from './editors/index';

// shadcn UI primitives
export * from './ui/index';

// Subagent progress
export { SubagentProgressCard, SubagentResultCard } from './subagent-progress-card';
export type { SubagentProgressCardProps, SubagentResultCardProps } from './subagent-progress-card';

// Workspace tree
export { TreeNode } from './workspace-tree-node';
export type { TreeNodeProps } from './workspace-tree-node';

// Shared components (formerly @extension/ui)
export * from './LoadingSpinner';
export * from './error-display/ErrorDisplay';
export * from './icons';
