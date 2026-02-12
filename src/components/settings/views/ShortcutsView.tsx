import React, { useEffect, useMemo, useState } from 'react';
import { shortcutDefinitions, ShortcutCategory, ShortcutId } from '../../../shortcuts/catalog';
import { eventToBinding, formatBindingForDisplay, normalizeBinding } from '../../../shortcuts/utils';
import { useShortcutsStore } from '../../../stores/useShortcutsStore';
import { Input } from '../../ui/Input';
import { Icon } from '../../ui/Icon';
import { cn } from '../../../utils/cn';

const categoryLabels: Record<ShortcutCategory, string> = {
  app: 'Application',
  mode: 'Modes',
  layout: 'Layout',
  chat: 'Chat',
  ai: 'AI',
};

export const ShortcutsView: React.FC = () => {
  const { bindings, setBinding, resetBinding, resetAll } = useShortcutsStore();
  const [search, setSearch] = useState('');
  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null);
  const [pendingBinding, setPendingBinding] = useState<string | null>(null);

  useEffect(() => {
    if (!recordingId) return;

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        setRecordingId(null);
        setPendingBinding(null);
        return;
      }

      const nextBinding = eventToBinding(event);
      if (!nextBinding) return;
      setPendingBinding(nextBinding);
      setBinding(recordingId, nextBinding);
      setRecordingId(null);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [recordingId, setBinding]);

  const conflictMap = useMemo(() => {
    const map: Record<ShortcutId, ShortcutId[]> = {} as Record<ShortcutId, ShortcutId[]>;

    shortcutDefinitions.forEach((definition) => {
      const current = bindings[definition.id];
      if (!current) {
        map[definition.id] = [];
        return;
      }
      const normalized = normalizeBinding(current);
      const conflicts = shortcutDefinitions
        .filter((other) => other.id !== definition.id && bindings[other.id] && normalizeBinding(bindings[other.id] || '') === normalized)
        .map((other) => other.id);
      map[definition.id] = conflicts;
    });

    return map;
  }, [bindings]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return shortcutDefinitions;
    return shortcutDefinitions.filter((shortcut) =>
      [shortcut.label, shortcut.description, categoryLabels[shortcut.category]]
        .join(' ')
        .toLowerCase()
        .includes(query)
    );
  }, [search]);

  const grouped = useMemo(() => {
    return filtered.reduce<Record<ShortcutCategory, typeof shortcutDefinitions>>((acc, shortcut) => {
      acc[shortcut.category].push(shortcut);
      return acc;
    }, {
      app: [],
      mode: [],
      layout: [],
      chat: [],
      ai: [],
    });
  }, [filtered]);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search shortcuts..."
          className="max-w-sm"
        />
        <button
          onClick={() => resetAll()}
          className="h-9 px-3 rounded-lg border border-border text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          Reset all
        </button>
      </div>

      {recordingId && (
        <div className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">
          Press your shortcut now... (Esc to cancel)
        </div>
      )}

      <div className="space-y-6">
        {(Object.keys(grouped) as ShortcutCategory[]).map((category) => {
          if (grouped[category].length === 0) return null;
          return (
            <section key={category} className="space-y-3">
              <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {categoryLabels[category]}
              </h4>

              <div className="space-y-2">
                {grouped[category].map((shortcut) => {
                  const binding = bindings[shortcut.id];
                  const conflicts = conflictMap[shortcut.id] || [];
                  const hasConflict = conflicts.length > 0;
                  const isRecording = recordingId === shortcut.id;

                  return (
                    <div
                      key={shortcut.id}
                      className={cn(
                        'rounded-lg border border-border bg-card/50 p-3',
                        hasConflict && 'border-amber-500/40'
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground">{shortcut.label}</p>
                          <p className="text-xs text-muted-foreground">{shortcut.description}</p>
                          {hasConflict && (
                            <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                              Conflict with: {conflicts.join(', ')}
                            </p>
                          )}
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <span className={cn(
                            'text-xs px-2 py-1 rounded border bg-background',
                            isRecording ? 'border-primary text-primary' : 'border-border text-foreground'
                          )}>
                            {isRecording ? (pendingBinding ? formatBindingForDisplay(pendingBinding) : 'Listening...') : formatBindingForDisplay(binding)}
                          </span>

                          <button
                            onClick={() => {
                              setPendingBinding(null);
                              setRecordingId(shortcut.id);
                            }}
                            className="p-1.5 rounded border border-border hover:bg-accent transition-colors"
                            title="Record shortcut"
                          >
                            <Icon name="edit" size={12} className="text-muted-foreground" />
                          </button>

                          <button
                            onClick={() => setBinding(shortcut.id, null)}
                            className="p-1.5 rounded border border-border hover:bg-accent transition-colors"
                            title="Disable shortcut"
                          >
                            <Icon name="minus" size={12} className="text-muted-foreground" />
                          </button>

                          <button
                            onClick={() => resetBinding(shortcut.id)}
                            className="p-1.5 rounded border border-border hover:bg-accent transition-colors"
                            title="Reset to default"
                          >
                            <Icon name="rotate-ccw" size={12} className="text-muted-foreground" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
};
