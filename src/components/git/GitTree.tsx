import React from 'react';
import { Icon } from '../ui/Icon';
import { Badge } from '../ui/Badge';
import { cn } from '../../utils/cn';
import { GitNode, GitNodeStatus } from '../../types';
import { useCodeFileStore } from '../../stores/useCodeFileStore';
import { services } from '../../services';

interface GitTreeProps {
  nodes: GitNode[];
  modifiedFilesCount: number;
  branch: string;
  className?: string;
}

const statusConfig: Record<GitNodeStatus, { icon: string; color: string; label: string }> = {
  added: { icon: 'arrow-up-right', color: 'text-accent-success', label: 'added' },
  modified: { icon: 'arrow-up-right', color: 'text-accent-warning', label: 'modified' },
  deleted: { icon: 'arrow-down-right', color: 'text-accent-error', label: 'deleted' },
  renamed: { icon: 'arrow-up-right', color: 'text-accent-primary', label: 'renamed' },
};

interface GitTreeNodeProps {
  node: GitNode;
  depth?: number;
}

const GitTreeNode: React.FC<GitTreeNodeProps> = ({ node, depth = 0 }) => {
  const [isOpen, setIsOpen] = React.useState(true);
  const openFileViewer = useCodeFileStore((state) => state.openFileViewer);

  const hasChildren = node.children && node.children.length > 0;
  const status = node.status ? statusConfig[node.status] : null;

  const handleNodeClick = async () => {
    if (hasChildren) {
      setIsOpen(!isOpen);
      return;
    }

    if (node.type === 'file') {
      try {
        const fileContent = await services.getFileContent(node.path);
        openFileViewer(node.path, fileContent.content, fileContent.language as any);
      } catch (error) {
        console.error('Failed to load file content:', error);
        // Fallback for demo
        openFileViewer(node.path, "// Erreur de chargement ou fichier non trouvé dans le mock.", 'typescript');
      }
    }
  };

  return (
    <div>
      <div
        className="flex items-center gap-2 py-1.5 hover:bg-border/50 rounded px-2 transition-colors cursor-pointer"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={handleNodeClick}
      >
        {/* Expand/Collapse Icon */}
        {hasChildren ? (
          <span onClick={(e) => { e.stopPropagation(); setIsOpen(!isOpen); }}>
            <Icon
              name={isOpen ? 'chevron-down' : 'chevron-right'}
              size={12}
              className="text-text-muted"
            />
          </span>
        ) : (
          <span className="w-3" />
        )}

        {/* File/Folder Icon */}
        <Icon
          name={node.type === 'directory' ? 'folder' : 'file-code'}
          size={14}
          className={cn(
            node.type === 'directory'
              ? 'text-accent-primary'
              : status?.color || 'text-text-muted'
          )}
        />

        {/* Name */}
        <span className="text-sm text-text-secondary flex-1 truncate">
          {node.name}
        </span>

        {/* Status Badge */}
        {status && (
          <Badge variant="default" size="sm" className="text-xs">
            <Icon
              name={status.icon as any}
              size={8}
              className={status.color}
            />
            {status.label}
          </Badge>
        )}
      </div>

      {/* Children */}
      {hasChildren && isOpen && (
        <div>
          {node.children!.map((child, index) => (
            <GitTreeNode
              key={`${child.name}-${index}`}
              node={child}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const GitTree: React.FC<GitTreeProps> = ({
  nodes,
  modifiedFilesCount,
  branch,
  className,
}) => {
  return (
    <div className={cn('h-full flex flex-col', className)}>
      {/* Header */}
      <div className="h-12 border-b border-border bg-elevated flex items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <Icon name="git-branch" size={14} className="text-accent-primary" />
          <span className="text-sm font-medium text-text-primary">
            {branch}
          </span>
        </div>
        <Badge variant="primary" size="sm">
          {modifiedFilesCount} changes
        </Badge>
      </div>

      {/* Legend */}
      <div className="px-4 py-2 border-b border-border/50 bg-elevated">
        <div className="flex items-center gap-3 text-xs text-text-muted">
          <span className="flex items-center gap-1">
            <Icon name="arrow-up-right" size={10} className="text-accent-success" />
            Added
          </span>
          <span className="flex items-center gap-1">
            <Icon name="arrow-up-right" size={10} className="text-accent-warning" />
            Modified
          </span>
          <span className="flex items-center gap-1">
            <Icon name="arrow-down-right" size={10} className="text-accent-error" />
            Deleted
          </span>
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto">
        <div className="py-2">
          {nodes.map((node, index) => (
            <GitTreeNode key={`${node.name}-${index}`} node={node} />
          ))}
        </div>
      </div>
    </div>
  );
};
