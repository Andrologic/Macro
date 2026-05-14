import React, { useEffect, useState } from 'react';
import {
  getExtensionDetailsProvider,
  getLatestExtensionSelection,
  subscribeExtensionRuntime,
} from '../../services/extensionRuntimeApi';
import { Icon } from '../ui/Icon';
import { asArray, asRecord, asString } from './extensionViewUtils';

interface ExtensionDetailsViewProps {
  extensionId: string;
  viewId: string;
  title: string;
}

export const ExtensionDetailsView: React.FC<ExtensionDetailsViewProps> = ({
  extensionId,
  viewId,
  title,
}) => {
  const [details, setDetails] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadDetails = async () => {
      const provider = getExtensionDetailsProvider(extensionId, viewId);
      if (!provider) return;
      try {
        const selection =
          getLatestExtensionSelection(extensionId);
        const nextDetails = asRecord(await provider.getDetails(selection));
        if (!cancelled) {
          setDetails(nextDetails);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      }
    };
    void loadDetails();
    const subscription = subscribeExtensionRuntime(() => void loadDetails());
    return () => {
      cancelled = true;
      subscription.dispose();
    };
  }, [extensionId, viewId]);

  const sections = asArray(details?.sections).map(asRecord);

  return (
    <section className="flex h-full flex-col bg-card">
      <div className="flex h-12 items-center gap-2 border-b border-border px-4">
        <Icon name="file-text" size={16} className="text-primary" />
        <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {error ? (
          <div className="text-sm text-destructive">{error}</div>
        ) : (
          <div className="space-y-4">
            <div>
              <h3 className="text-base font-semibold text-foreground">
                {asString(details?.title, title)}
              </h3>
              <p className="text-sm text-muted-foreground">{asString(details?.subtitle)}</p>
            </div>
            {sections.map((section, index) => (
              <div key={asString(section.id, `section-${index}`)} className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {asString(section.title, 'Details')}
                </h4>
                <div className="space-y-1 rounded-lg border border-border bg-background/60 p-3">
                  {asArray(section.rows).map((row, rowIndex) => {
                    const record = asRecord(row);
                    return (
                      <div
                        key={`${asString(record.label, 'row')}-${rowIndex}`}
                        className="grid grid-cols-[96px_1fr] gap-3 text-sm"
                      >
                        <span className="text-muted-foreground">{asString(record.label)}</span>
                        <span className="min-w-0 break-words text-foreground">
                          {String(record.value ?? '')}
                        </span>
                      </div>
                    );
                  })}
                  {asString(section.content) && (
                    <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-xs text-foreground">
                      {asString(section.content)}
                    </pre>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
};
