import React, { useEffect, useMemo, useState } from 'react';
import { getExtensionGraphDataProvider } from '../../services/extensionRuntimeApi';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';
import {
  asArray,
  asRecord,
  asString,
  selectExtensionPayload,
  subscribeToExtensionViewRefresh,
} from './extensionViewUtils';

interface ExtensionGraphViewProps {
  extensionId: string;
  viewId: string;
  title: string;
}

interface GraphNodeRecord {
  id: string;
  label: string;
  kind: string;
  payload: unknown;
}

const toGraphNode = (item: unknown, index: number): GraphNodeRecord => {
  const record = asRecord(item);
  return {
    id: asString(record.id, `node-${index}`),
    label: asString(record.label ?? record.name, `Node ${index + 1}`),
    kind: asString(record.kind ?? record.type, 'node'),
    payload: record.payload ?? item,
  };
};

export const ExtensionGraphView: React.FC<ExtensionGraphViewProps> = ({
  extensionId,
  viewId,
  title,
}) => {
  const [graph, setGraph] = useState<Record<string, unknown> | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadGraph = async () => {
      const provider = getExtensionGraphDataProvider(extensionId, viewId);
      if (!provider) return;
      try {
        const nextGraph = asRecord(await provider.getGraph());
        if (!cancelled) {
          setGraph(nextGraph);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      }
    };
    void loadGraph();
    const refreshSubscription = subscribeToExtensionViewRefresh(extensionId, viewId, () => {
      void loadGraph();
    });
    return () => {
      cancelled = true;
      refreshSubscription.dispose();
    };
  }, [extensionId, viewId]);

  const nodes = useMemo(
    () => asArray(graph?.nodes).map(toGraphNode),
    [graph],
  );
  const metadata = asRecord(graph?.metadata);
  const filter = asString(metadata.activeFilter, 'All');

  return (
    <section className="flex h-full flex-col bg-background">
      <div className="flex h-12 items-center justify-between border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="network" size={16} className="text-primary" />
          <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
        </div>
        <span className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
          {filter}
        </span>
      </div>
      <div className="relative flex-1 overflow-auto p-4">
        {error ? (
          <div className="text-sm text-destructive">{error}</div>
        ) : (
          <div className="grid auto-rows-[minmax(72px,auto)] grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
            {nodes.map((node) => (
              <button
                type="button"
                key={node.id}
                className={cn(
                  'min-h-18 rounded-lg border border-border bg-card px-3 py-3 text-left shadow-sm transition-colors hover:border-primary/50 hover:bg-accent/30',
                  selectedId === node.id && 'border-primary bg-primary/10',
                )}
                onClick={() => {
                  setSelectedId(node.id);
                  selectExtensionPayload(extensionId, viewId, node.payload, 'graph');
                }}
              >
                <div className="truncate text-sm font-medium text-foreground">{node.label}</div>
                <div className="mt-1 truncate text-xs text-muted-foreground">{node.kind}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
};
