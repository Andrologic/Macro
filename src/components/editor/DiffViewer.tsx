import React from 'react';
import { CodeViewer } from '../ui/CodeViewer';
import type { CodeDiff } from '../../types';
import { Icon } from '../ui/Icon';

interface DiffViewerProps {
  diff: CodeDiff;
}

export const DiffViewer: React.FC<DiffViewerProps> = ({ diff }) => {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-zinc-200">
          <Icon name="file-code" size={14} className="text-indigo-400" />
          <span className="font-mono text-xs text-zinc-400">{diff.file_path}</span>
        </div>
        <span className="text-xs text-zinc-500">{diff.language}</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <div className="text-xs text-zinc-400 mb-2">Before</div>
          <CodeViewer code={diff.old_content || '// empty'} language={diff.language as any} />
        </div>
        <div>
          <div className="text-xs text-zinc-400 mb-2">After</div>
          <CodeViewer code={diff.new_content || '// empty'} language={diff.language as any} />
        </div>
      </div>
    </div>
  );
};
