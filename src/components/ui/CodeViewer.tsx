import React, { Suspense, lazy } from 'react';
import { cn } from '../../utils/cn';
import { Skeleton } from '../shared/Skeleton';
import type { EditorView } from '@codemirror/view';
import type { CodeViewerLineHighlight } from './CodeMirrorEditor';

// =============================================================================
// LAZY LOADED CODEMIRROR COMPONENT
// =============================================================================
// CodeMirror is a heavy dependency (~500KB+), so we lazy load it

const CodeMirrorEditor = lazy(() => import('./CodeMirrorEditor'));

// =============================================================================
// LOADING SKELETON
// =============================================================================

const CodeViewerSkeleton: React.FC = () => (
  <div className="w-full h-full min-h-[200px] rounded-md overflow-hidden border border-border bg-card">
    <div className="p-4 space-y-2">
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
    </div>
  </div>
);

// =============================================================================
// CODE VIEWER PROPS
// =============================================================================

interface CodeViewerProps {
  code: string;
  language?: string;
  className?: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  wrapLines?: boolean;
  autoFocus?: boolean;
  onEditorReady?: (view: EditorView | null) => void;
  lineHighlights?: CodeViewerLineHighlight[];
  hideVerticalScrollbar?: boolean;
}

/**
 * CodeViewer - Displays code with syntax highlighting
 * 
 * PERFORMANCE OPTIMIZATION:
 * - Uses React.lazy() to defer loading CodeMirror until needed
 * - Shows skeleton UI while CodeMirror loads
 * - Reduces initial bundle size by ~500KB+
 */
export const CodeViewer: React.FC<CodeViewerProps> = ({
  code,
  language = 'typescript',
  className,
  readOnly = true,
  onChange,
  wrapLines = true,
  autoFocus = false,
  onEditorReady,
  lineHighlights = [],
  hideVerticalScrollbar = false,
}) => {
  return (
    <div className={cn("relative", className)}>
      <Suspense fallback={<CodeViewerSkeleton />}>
        <CodeMirrorEditor
          code={code}
          language={language}
          readOnly={readOnly}
          className={className}
          onChange={onChange}
          wrapLines={wrapLines}
          autoFocus={autoFocus}
          onEditorReady={onEditorReady}
          lineHighlights={lineHighlights}
          hideVerticalScrollbar={hideVerticalScrollbar}
        />
      </Suspense>
    </div>
  );
};

// =============================================================================
// PRELOAD UTILITY
// =============================================================================

/**
 * Preload CodeMirror editor component
 * Call this when anticipating code display (e.g., hovering over file)
 */
export const preloadCodeMirror = (): void => {
  void import('./CodeMirrorEditor');
};

export default CodeViewer;
