import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import * as tauriIpc from '../../services/tauriIpc';
import { useCodeFileStore } from '../../stores/useCodeFileStore';
import { useAppStore } from '../../stores/useAppStore';

interface DebugWorkspaceExplorerProps {
  className?: string;
}

type ExplorerNode = {
  key: string;
  name: string;
  path: string;
  type: 'file' | 'directory';
  children: ExplorerNode[];
};

const NODE_INDENT = 14;

const formatErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'object' && error !== null) {
    const candidate = error as { message?: unknown; error?: { message?: unknown } };
    if (typeof candidate.message === 'string' && candidate.message.trim()) {
      return candidate.message;
    }
    if (typeof candidate.error?.message === 'string' && candidate.error.message.trim()) {
      return candidate.error.message;
    }
  }

  return String(error);
};

const sortNodes = (nodes: ExplorerNode[]): ExplorerNode[] => {
  return nodes
    .sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    })
    .map((node) => ({
      ...node,
      children: sortNodes(node.children),
    }));
};

const buildTree = (paths: string[]): ExplorerNode[] => {
  const root: ExplorerNode[] = [];

  for (const rawPath of paths) {
    const normalized = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!normalized || normalized === '.') continue;

    const segments = normalized.split('/').filter(Boolean);
    let currentNodes = root;
    let currentPath = '';

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const isLeaf = index === segments.length - 1;
      const nodeType: ExplorerNode['type'] = isLeaf ? 'file' : 'directory';

      let node = currentNodes.find((candidate) => candidate.name === segment);
      if (!node) {
        node = {
          key: currentPath,
          name: segment,
          path: currentPath,
          type: nodeType,
          children: [],
        };
        currentNodes.push(node);
      }

      if (!isLeaf && node.type === 'file') {
        node.type = 'directory';
      }

      currentNodes = node.children;
    }
  }

  return sortNodes(root);
};

interface TreeNodeProps {
  node: ExplorerNode;
  depth: number;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  onOpenFile: (path: string) => void;
}

const TreeNode: React.FC<TreeNodeProps> = ({
  node,
  depth,
  expandedFolders,
  onToggleFolder,
  onOpenFile,
}) => {
  const isFolder = node.type === 'directory';
  const isOpen = isFolder ? expandedFolders.has(node.path) : false;

  const handleClick = () => {
    if (isFolder) {
      onToggleFolder(node.path);
      return;
    }
    onOpenFile(node.path);
  };

  return (
    <div>
      <button
        onClick={handleClick}
        className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-sm hover:bg-accent transition-colors"
        style={{ paddingLeft: `${depth * NODE_INDENT + 8}px` }}
      >
        {isFolder ? (
          <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={12} className="text-muted-foreground" />
        ) : (
          <span className="w-3" />
        )}

        <Icon
          name={isFolder ? (isOpen ? 'folder-open' : 'folder') : 'file'}
          size={14}
          className={cn(isFolder ? 'text-amber-500/90' : 'text-muted-foreground')}
        />

        <span className="truncate text-foreground text-left flex-1">{node.name}</span>
      </button>

      {isFolder && isOpen && node.children.map((child) => (
        <TreeNode
          key={child.key}
          node={child}
          depth={depth + 1}
          expandedFolders={expandedFolders}
          onToggleFolder={onToggleFolder}
          onOpenFile={onOpenFile}
        />
      ))}
    </div>
  );
};

export const DebugWorkspaceExplorer: React.FC<DebugWorkspaceExplorerProps> = ({ className }) => {
  const openFileViewer = useCodeFileStore((state) => state.openFileViewer);
  const selectedGroupId = useAppStore((state) => state.selectedGroupId);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const projectGroups = useAppStore((state) => state.projectGroups);
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const activeProject = useMemo(() => {
    if (!selectedGroupId) return null;
    const group = projectGroups.find((candidate) => candidate.id === selectedGroupId);
    if (!group) return null;

    if (selectedProjectId) {
      return group.projects.find((project) => project.id === selectedProjectId) ?? null;
    }

    return group.projects[0] ?? null;
  }, [projectGroups, selectedGroupId, selectedProjectId]);

  const activeRootPath = (activeProject?.path || '.').replace(/\\/g, '/').replace(/\/$/, '') || '.';

  const tree = useMemo(() => buildTree(filePaths), [filePaths]);

  const loadTree = async () => {
    if (!tauriIpc.isTauriAvailable()) {
      setLastError('Tauri runtime required to browse the workspace tree.');
      setFilePaths([]);
      return;
    }

    setIsLoading(true);
    setLastError(null);

    try {
      const entries = await tauriIpc.fsListDir({
        path: activeRootPath,
        recursive: true,
        includeHidden: false,
        allowOutsideWorkspace: true,
      });

      const normalizedRoot = activeRootPath.replace(/\\/g, '/').replace(/\/$/, '');
      const rootPrefix = normalizedRoot === '.' ? '' : `${normalizedRoot.replace(/^\.\//, '')}/`;

      const files = entries
        .filter((entry) => entry.kind === 'file')
        .map((entry) => {
          const relative = entry.relative_path.replace(/\\/g, '/').replace(/^\.\//, '');
          const absolute = entry.path.replace(/\\/g, '/');

          if (normalizedRoot.startsWith('/') && absolute.startsWith(`${normalizedRoot}/`)) {
            return absolute.slice(normalizedRoot.length + 1);
          }

          if (!rootPrefix) return relative;
          return relative.startsWith(rootPrefix) ? relative.slice(rootPrefix.length) : relative;
        })
        .filter((path) => path && !path.startsWith('.git/'));

      setFilePaths(files);
      setExpandedFolders(new Set(['src', 'src/components']));
    } catch (error) {
      setLastError(formatErrorMessage(error));
      setFilePaths([]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadTree();
  }, [activeRootPath]);

  const toggleFolder = (path: string) => {
    setExpandedFolders((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const openFile = async (path: string) => {
    const resolvedPath = activeRootPath === '.' ? path : `${activeRootPath}/${path}`;
    try {
      const file = await tauriIpc.fsReadFileWithOptions({
        path: resolvedPath,
        allowOutsideWorkspace: true,
      });
      const content = file.is_binary
        ? `Binary file (${file.size} bytes, encoding=${file.encoding}).`
        : file.content;
      const language = file.is_binary ? 'text' : file.language;
      openFileViewer(resolvedPath, content, language);
    } catch (error) {
      openFileViewer(
        resolvedPath,
        `Unable to read file: ${formatErrorMessage(error)}`,
        'text'
      );
    }
  };

  return (
    <aside className={cn('h-full w-full bg-card border-r border-border flex flex-col', className)}>
      <div className="h-12 border-b border-border flex items-center justify-between px-4">
        <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Icon name="folder-open" size={16} className="text-primary" />
          {activeProject?.name || 'Explorer'}
        </h1>
        <button
          onClick={() => void loadTree()}
          className="p-1 rounded hover:bg-accent transition-colors"
          title="Refresh tree"
        >
          <Icon name="refresh-cw" size={14} className="text-muted-foreground" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {isLoading && (
          <div className="px-2 py-4 text-sm text-muted-foreground">Loading files…</div>
        )}

        {!isLoading && lastError && (
          <div className="px-2 py-4 text-sm text-red-500">{lastError}</div>
        )}

        {!isLoading && !lastError && tree.length === 0 && (
          <div className="px-2 py-4 text-sm text-muted-foreground">No files found.</div>
        )}

        {!isLoading && !lastError && tree.map((node) => (
          <TreeNode
            key={node.key}
            node={node}
            depth={0}
            expandedFolders={expandedFolders}
            onToggleFolder={toggleFolder}
            onOpenFile={openFile}
          />
        ))}
      </div>
    </aside>
  );
};

export default DebugWorkspaceExplorer;
