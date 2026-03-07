import React, { Suspense, lazy } from 'react';
import { cn } from '../../utils/cn';
import { Skeleton } from '../shared/Skeleton';

// =============================================================================
// LAZY LOADED CODEMIRROR COMPONENT
// =============================================================================
// CodeMirror is a heavy dependency (~500KB+), so we lazy load it

const CodeMirrorEditor = lazy(() => import('./CodeMirrorEditor'));

// =============================================================================
// LOADING SKELETON
// =============================================================================

const CodeViewerSkeleton: React.FC = () => (
  <div className="w-full h-full min-h-[200px] bg-[#282c34] rounded-md overflow-hidden">
    <div className="p-4 space-y-2">
      <Skeleton className="h-4 w-full bg-gray-700" />
      <Skeleton className="h-4 w-11/12 bg-gray-700" />
      <Skeleton className="h-4 w-4/5 bg-gray-700" />
      <Skeleton className="h-4 w-full bg-gray-700" />
      <Skeleton className="h-4 w-3/4 bg-gray-700" />
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
