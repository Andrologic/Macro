import React, { useEffect, useState } from 'react';
import { getExtensionTableDataProvider } from '../../services/extensionRuntimeApi';
import { Icon } from '../ui/Icon';
import {
  asArray,
  asRecord,
  asString,
  selectExtensionPayload,
  subscribeToExtensionViewRefresh,
} from './extensionViewUtils';

interface ExtensionTableViewProps {
  extensionId: string;
  viewId: string;
  title: string;
}

export const ExtensionTableView: React.FC<ExtensionTableViewProps> = ({
  extensionId,
  viewId,
  title,
}) => {
  const [table, setTable] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadTable = async () => {
      const provider = getExtensionTableDataProvider(extensionId, viewId);
      if (!provider) return;
      try {
        const nextTable = asRecord(await provider.getTable({}));
        if (!cancelled) {
          setTable(nextTable);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      }
    };
    void loadTable();
    const refreshSubscription = subscribeToExtensionViewRefresh(extensionId, viewId, () => {
      void loadTable();
    });
    return () => {
      cancelled = true;
      refreshSubscription.dispose();
    };
  }, [extensionId, viewId]);

  const columns = asArray(table?.columns).map(asRecord);
  const rows = asArray(table?.rows).map(asRecord);

  return (
    <section className="flex h-full flex-col bg-card">
      <div className="flex h-12 items-center gap-2 border-b border-border px-4">
        <Icon name="list" size={16} className="text-primary" />
        <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
      </div>
      <div className="flex-1 overflow-auto p-3">
        {error ? (
          <div className="text-sm text-destructive">{error}</div>
        ) : (
          <table className="min-w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                {columns.map((column, index) => (
                  <th
                    key={asString(column.id, `column-${index}`)}
                    className="sticky top-0 border-b border-border bg-card px-3 py-2 text-left text-xs font-semibold text-muted-foreground"
                  >
                    {asString(column.title, asString(column.id))}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => {
                const cells = asRecord(row.cells);
                return (
                  <tr
                    key={asString(row.id, `row-${rowIndex}`)}
                    className="cursor-pointer hover:bg-accent/30"
                    onClick={() => selectExtensionPayload(extensionId, viewId, row.payload ?? row, 'table')}
                  >
                    {columns.map((column, columnIndex) => {
                      const id = asString(column.id, `column-${columnIndex}`);
                      return (
                        <td key={id} className="border-b border-border/50 px-3 py-2 text-foreground">
                          {String(cells[id] ?? '')}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
};
