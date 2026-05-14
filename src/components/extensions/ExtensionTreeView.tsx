import React, { useEffect, useState } from 'react';
import { getExtensionTreeDataProvider } from '../../services/extensionRuntimeApi';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';
import {
  asRecord,
  asString,
  selectExtensionPayload,
  subscribeToExtensionViewRefresh,
} from './extensionViewUtils';

interface ExtensionTreeViewProps {
  extensionId: string;
  viewId: string;
  title: string;
}

interface TreeItemRecord {
  id: string;
  label: string;
  description: string;
  payload: unknown;
}

const toTreeItem = (item: unknown, index: number): TreeItemRecord => {
  const record = asRecord(item);
  return {
    id: asString(record.id, `item-${index}`),
    label: asString(record.label ?? record.name, `Item ${index + 1}`),
    description: asString(record.description),
    payload: record.payload ?? item,
  };
};

export const ExtensionTreeView: React.FC<ExtensionTreeViewProps> = ({
  extensionId,
  viewId,
  title,
}) => {
  const [items, setItems] = useState<TreeItemRecord[]>([]);
  const [expanded, setExpanded] = useState<Record<string, TreeItemRecord[] | undefined>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadRoot = async () => {
      const provider = getExtensionTreeDataProvider(extensionId, viewId);
      if (!provider) return;
      try {
        const children = await provider.getChildren();
        if (!cancelled) {
          setItems((children ?? []).map(toTreeItem));
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      }
    };
    void loadRoot();
    const refreshSubscription = subscribeToExtensionViewRefresh(extensionId, viewId, () => {
      void loadRoot();
    });
    return () => {
      cancelled = true;
      refreshSubscription.dispose();
    };
  }, [extensionId, viewId]);

  const toggle = async (item: TreeItemRecord) => {
    if (expanded[item.id]) {
      setExpanded((current) => ({ ...current, [item.id]: undefined }));
      return;
    }
    const provider = getExtensionTreeDataProvider(extensionId, viewId);
    if (!provider) return;
    try {
      const children = await provider.getChildren(item.payload);
      setExpanded((current) => ({
        ...current,
        [item.id]: (children ?? []).map(toTreeItem),
      }));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  };

  const renderItem = (item: TreeItemRecord, depth = 0) => {
    const children = expanded[item.id];
    return (
      <div key={item.id}>
        <button
          type="button"
          className={cn(
            'flex min-h-8 w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent/40',
            selectedId === item.id && 'bg-primary/10 text-primary',
          )}
          style={{ paddingLeft: `${12 + depth * 14}px` }}
          onClick={() => {
            setSelectedId(item.id);
            selectExtensionPayload(extensionId, viewId, item.payload, 'tree');
          }}
          onDoubleClick={() => void toggle(item)}
        >
          <Icon
            name={children ? 'chevron-down' : 'chevron-right'}
            size={13}
            className="shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {item.description && (
            <span className="shrink-0 text-xs text-muted-foreground">{item.description}</span>
          )}
        </button>
        {children?.map((child) => renderItem(child, depth + 1))}
      </div>
    );
  };

  return (
    <section className="flex h-full flex-col bg-card">
      <div className="flex h-12 items-center gap-2 border-b border-border px-4">
        <Icon name="folder-tree" size={16} className="text-primary" />
        <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {error ? (
          <div className="px-4 py-3 text-sm text-destructive">{error}</div>
        ) : (
          items.map((item) => renderItem(item))
        )}
      </div>
    </section>
  );
};
