import { cn } from '../../utils';
import { Button, Separator } from '../ui';
import { mermaid } from '@streamdown/mermaid';
import type { LucideIcon } from 'lucide-react';
import {
  BoldIcon,
  CodeIcon,
  ColumnsIcon,
  EyeIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  PencilIcon,
  QuoteIcon,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Streamdown } from 'streamdown';
import type { EditorView } from '@codemirror/view';

type MarkdownEditorMode = 'view' | 'raw' | 'split';

type ToolbarAction = {
  icon: LucideIcon;
  title: string;
  onClick: () => void;
  disabled?: boolean;
};

type MarkdownEditorProps = {
  content: string;
  onChange?: (content: string) => void;
  mode?: MarkdownEditorMode;
  onModeChange?: (mode: MarkdownEditorMode) => void;
  streaming?: boolean;
  showToolbar?: boolean;
  showModeToggle?: boolean;
  className?: string;
  toolbarActions?: ToolbarAction[];
};

const mermaidPlugin = mermaid;

const formattingActions: {
  icon: typeof BoldIcon;
  title: string;
  action: (view: EditorView) => void;
}[] = [
  {
    icon: BoldIcon,
    title: 'Bold',
    action: view => {
      const { from, to } = view.state.selection.main;
      const selected = view.state.sliceDoc(from, to);
      view.dispatch({ changes: { from, to, insert: `**${selected || 'bold'}**` } });
    },
  },
  {
    icon: ItalicIcon,
    title: 'Italic',
    action: view => {
      const { from, to } = view.state.selection.main;
      const selected = view.state.sliceDoc(from, to);
      view.dispatch({ changes: { from, to, insert: `_${selected || 'italic'}_` } });
    },
  },
  {
    icon: Heading1Icon,
    title: 'Heading 1',
    action: view => {
      const { from } = view.state.selection.main;
      const line = view.state.doc.lineAt(from);
      view.dispatch({ changes: { from: line.from, to: line.from, insert: '# ' } });
    },
  },
  {
    icon: Heading2Icon,
    title: 'Heading 2',
    action: view => {
      const { from } = view.state.selection.main;
      const line = view.state.doc.lineAt(from);
      view.dispatch({ changes: { from: line.from, to: line.from, insert: '## ' } });
    },
  },
  {
    icon: Heading3Icon,
    title: 'Heading 3',
    action: view => {
      const { from } = view.state.selection.main;
      const line = view.state.doc.lineAt(from);
      view.dispatch({ changes: { from: line.from, to: line.from, insert: '### ' } });
    },
  },
  {
    icon: LinkIcon,
    title: 'Link',
    action: view => {
      const { from, to } = view.state.selection.main;
      const selected = view.state.sliceDoc(from, to);
      view.dispatch({ changes: { from, to, insert: `[${selected || 'text'}](url)` } });
    },
  },
  {
    icon: CodeIcon,
    title: 'Code',
    action: view => {
      const { from, to } = view.state.selection.main;
      const selected = view.state.sliceDoc(from, to);
      if (selected.includes('\n')) {
        view.dispatch({ changes: { from, to, insert: `\`\`\`\n${selected}\n\`\`\`` } });
      } else {
        view.dispatch({ changes: { from, to, insert: `\`${selected || 'code'}\`` } });
      }
    },
  },
  {
    icon: QuoteIcon,
    title: 'Quote',
    action: view => {
      const { from } = view.state.selection.main;
      const line = view.state.doc.lineAt(from);
      view.dispatch({ changes: { from: line.from, to: line.from, insert: '> ' } });
    },
  },
  {
    icon: ListIcon,
    title: 'Bullet list',
    action: view => {
      const { from } = view.state.selection.main;
      const line = view.state.doc.lineAt(from);
      view.dispatch({ changes: { from: line.from, to: line.from, insert: '- ' } });
    },
  },
  {
    icon: ListOrderedIcon,
    title: 'Numbered list',
    action: view => {
      const { from } = view.state.selection.main;
      const line = view.state.doc.lineAt(from);
      view.dispatch({ changes: { from: line.from, to: line.from, insert: '1. ' } });
    },
  },
];

const MarkdownEditor = ({
  content,
  onChange,
  mode: controlledMode,
  onModeChange,
  streaming,
  showToolbar,
  showModeToggle,
  className,
  toolbarActions,
}: MarkdownEditorProps) => {
  const isEditable = !!onChange;
  const defaultMode: MarkdownEditorMode = isEditable ? 'raw' : 'view';
  const mode = controlledMode ?? defaultMode;
  const setMode = onModeChange ?? (() => {});

  const resolvedShowToolbar = showToolbar ?? isEditable;
  const resolvedShowModeToggle = showModeToggle ?? isEditable;

  // Force view mode for read-only
  const effectiveMode: MarkdownEditorMode = isEditable ? mode : 'view';

  const containerRef = useRef<HTMLDivElement>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const contentRef = useRef(content);
  contentRef.current = content;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Auto-scroll when streaming in view mode
  useEffect(() => {
    if (streaming && effectiveMode === 'view' && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [content, streaming, effectiveMode]);

  // Create / destroy CodeMirror based on mode
  useEffect(() => {
    if (effectiveMode === 'view') {
      if (editorViewRef.current) {
        editorViewRef.current.destroy();
        editorViewRef.current = null;
      }
      return;
    }
    if (!editorContainerRef.current) return;

    let destroyed = false;

    const loadEditor = async () => {
      const { EditorView: View, basicSetup } = await import('codemirror');
      const { EditorState } = await import('@codemirror/state');
      const { markdown } = await import('@codemirror/lang-markdown');
      const { oneDark } = await import('@codemirror/theme-one-dark');

      if (destroyed || !editorContainerRef.current) return;

      const isDark = document.documentElement.classList.contains('dark');

      const fontTheme = View.theme({
        '&': { fontSize: '14px' },
        '.cm-gutters': { fontSize: '14px' },
        '.cm-content': { fontFamily: 'ui-monospace, monospace' },
      });

      const updateListener = View.updateListener.of(update => {
        if (update.docChanged) {
          const newContent = update.state.doc.toString();
          contentRef.current = newContent;
          onChangeRef.current?.(newContent);
        }
      });

      const state = EditorState.create({
        doc: contentRef.current,
        extensions: [
          basicSetup,
          markdown(),
          View.lineWrapping,
          fontTheme,
          updateListener,
          ...(isDark ? [oneDark] : []),
        ],
      });

      editorViewRef.current = new View({
        state,
        parent: editorContainerRef.current,
      });
    };

    loadEditor();

    return () => {
      destroyed = true;
      if (editorViewRef.current) {
        editorViewRef.current.destroy();
        editorViewRef.current = null;
      }
    };
  }, [effectiveMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const showEditor = effectiveMode === 'raw' || effectiveMode === 'split';
  const showPreview = effectiveMode === 'view' || effectiveMode === 'split';

  return (
    <div className={cn('flex h-full flex-col', className)}>
      {/* Toolbar + mode toggle */}
      {(resolvedShowToolbar || resolvedShowModeToggle) && (
        <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5">
          {resolvedShowToolbar && (
            <div className="flex items-center gap-0.5">
              {formattingActions.map(({ icon: Icon, title, action }) => (
                <Button
                  key={title}
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  title={title}
                  disabled={effectiveMode === 'view'}
                  onClick={() => {
                    if (editorViewRef.current) {
                      action(editorViewRef.current);
                      editorViewRef.current.focus();
                    }
                  }}>
                  <Icon className="size-3.5" />
                </Button>
              ))}
            </div>
          )}
          {resolvedShowToolbar && resolvedShowModeToggle && (
            <Separator orientation="vertical" className="mx-1 h-5" />
          )}
          {resolvedShowModeToggle && (
            <div className="flex items-center gap-0.5">
              <Button
                variant={effectiveMode === 'raw' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setMode('raw')}>
                <PencilIcon className="mr-1 size-3" />
                Raw
              </Button>
              <Button
                variant={effectiveMode === 'view' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setMode('view')}>
                <EyeIcon className="mr-1 size-3" />
                Preview
              </Button>
              <Button
                variant={effectiveMode === 'split' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setMode('split')}>
                <ColumnsIcon className="mr-1 size-3" />
                Split
              </Button>
            </div>
          )}
          {toolbarActions && toolbarActions.length > 0 && (
            <>
              <Separator orientation="vertical" className="mx-1 h-5" />
              <div className="flex items-center gap-0.5">
                {toolbarActions.map(({ icon: Icon, title, onClick, disabled }) => (
                  <Button
                    key={title}
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    title={title}
                    disabled={disabled}
                    onClick={onClick}>
                    <Icon className="size-3.5" />
                  </Button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Editor / Preview area */}
      <div className="flex min-h-0 flex-1 gap-2 overflow-hidden">
        <div
          ref={editorContainerRef}
          className={cn(
            'overflow-auto [&_.cm-editor]:h-full [&_.cm-editor.cm-focused]:outline-none',
            !showEditor && 'hidden',
            showPreview && showEditor ? 'w-1/2' : 'w-full',
          )}
        />
        {showPreview && (
          <div
            ref={containerRef}
            className={cn(
              'overflow-auto p-4',
              showEditor ? 'w-1/2 rounded border' : 'w-full',
            )}>
            <Streamdown
              className="prose dark:prose-invert max-w-none text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_pre]:!bg-[unset] [&_pre]:!text-[unset]"
              plugins={{ mermaid: mermaidPlugin }}>
              {content || '*Empty*'}
            </Streamdown>
          </div>
        )}
      </div>
    </div>
  );
};

export { MarkdownEditor };
export type { MarkdownEditorProps, MarkdownEditorMode };
