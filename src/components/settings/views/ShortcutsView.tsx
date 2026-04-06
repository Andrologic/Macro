import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { shortcutDefinitions, ShortcutCategory, ShortcutId } from '../../../shortcuts/catalog';
import { eventToBinding, formatBindingForDisplay, normalizeBinding } from '../../../shortcuts/utils';
import { useShortcutsStore } from '../../../stores/useShortcutsStore';
import { Input } from '../../ui/Input';
import { Icon } from '../../ui/Icon';
import { Switch } from '../../ui/Switch';
import { cn } from '../../../utils/cn';

const shortcutTranslationKeys: Record<
  ShortcutId,
  {
    label: string;
    description: string;
  }
> = {
  'app.openSettings': {
    label: 'shortcuts.items.appOpenSettings.label',
    description: 'shortcuts.items.appOpenSettings.description',
  },
  'app.closeSettings': {
    label: 'shortcuts.items.appCloseSettings.label',
    description: 'shortcuts.items.appCloseSettings.description',
  },
  'chat.newConversation': {
    label: 'shortcuts.items.chatNewConversation.label',
    description: 'shortcuts.items.chatNewConversation.description',
  },
  'app.switchMode.architect': {
    label: 'shortcuts.items.switchArchitect.label',
    description: 'shortcuts.items.switchArchitect.description',
  },
  'app.switchMode.implement': {
    label: 'shortcuts.items.switchImplement.label',
    description: 'shortcuts.items.switchImplement.description',
  },
  'app.switchMode.chat': {
    label: 'shortcuts.items.switchChat.label',
    description: 'shortcuts.items.switchChat.description',
  },
  'app.toggleLeftPanel': {
    label: 'shortcuts.items.toggleLeftPanel.label',
    description: 'shortcuts.items.toggleLeftPanel.description',
  },
  'app.toggleRightPanel': {
    label: 'shortcuts.items.toggleRightPanel.label',
    description: 'shortcuts.items.toggleRightPanel.description',
  },
  'ai.cycleProvider': {
    label: 'shortcuts.items.nextProvider.label',
    description: 'shortcuts.items.nextProvider.description',
  },
  'ai.cycleModel': {
    label: 'shortcuts.items.nextModel.label',
    description: 'shortcuts.items.nextModel.description',
  },
  'chat.stopStreaming': {
    label: 'shortcuts.items.stopStreaming.label',
    description: 'shortcuts.items.stopStreaming.description',
  },
  'chat.focusInput': {
    label: 'shortcuts.items.focusInput.label',
    description: 'shortcuts.items.focusInput.description',
  },
  'chat.historyPrevious': {
    label: 'shortcuts.items.historyPrevious.label',
    description: 'shortcuts.items.historyPrevious.description',
  },
  'chat.historyNext': {
    label: 'shortcuts.items.historyNext.label',
    description: 'shortcuts.items.historyNext.description',
  },
};

export const ShortcutsView: React.FC = () => {
  const { t } = useTranslation();
  const {
    bindings,
    promptHistoryNavigationMode,
    setPromptHistoryNavigationMode,
    setBinding,
    resetBinding,
    resetAll,
  } = useShortcutsStore();
  const [search, setSearch] = useState('');
  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null);
  const [pendingBinding, setPendingBinding] = useState<string | null>(null);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);

  const categoryLabels = useMemo<Record<ShortcutCategory, string>>(
    () => ({
      app: t('shortcuts.categories.app', 'Application'),
      mode: t('shortcuts.categories.mode', 'Modes'),
      layout: t('shortcuts.categories.layout', 'Layout'),
      chat: t('shortcuts.categories.chat', 'Chat'),
      ai: t('shortcuts.categories.ai', 'AI'),
    }),
    [t]
  );

  const localizedShortcutDefinitions = useMemo(
    () =>
      shortcutDefinitions.map((shortcut) => ({
        ...shortcut,
        label: t(shortcutTranslationKeys[shortcut.id].label, shortcut.label),
        description: t(
          shortcutTranslationKeys[shortcut.id].description,
          shortcut.description
        ),
      })),
    [t]
  );

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
    if (!query) return localizedShortcutDefinitions;
    return localizedShortcutDefinitions.filter((shortcut) =>
      [shortcut.label, shortcut.description, categoryLabels[shortcut.category]]
        .join(' ')
        .toLowerCase()
        .includes(query)
    );
  }, [categoryLabels, localizedShortcutDefinitions, search]);

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
          placeholder={t('shortcuts.searchPlaceholder', 'Search shortcuts...')}
          className="max-w-sm"
        />
        <button
          onClick={() => setConfirmResetOpen(true)}
          className="h-9 px-3 rounded-lg border border-border text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          {t('shortcuts.resetAll', 'Reset all')}
        </button>
      </div>

      {recordingId && (
        <div className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">
          {t('shortcuts.recordingHint', 'Press your shortcut now... (Esc to cancel)')}
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
                  const isPromptHistoryShortcut =
                    shortcut.id === 'chat.historyPrevious' || shortcut.id === 'chat.historyNext';
                  const isPromptHistoryShortcutDisabled =
                    isPromptHistoryShortcut && promptHistoryNavigationMode !== 'shortcut_only';

                  return (
                    <React.Fragment key={shortcut.id}>
                      {shortcut.id === 'chat.historyPrevious' && (
                        <div className="rounded-lg border border-border bg-card/50 p-3">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="text-sm font-medium text-foreground">
                                {t('shortcuts.promptHistoryBehavior', 'Prompt history behavior')}
                              </p>
                              <p className="text-xs text-muted-foreground mt-0.5">
                                {t(
                                  'shortcuts.promptHistoryBehaviorDesc',
                                  'Use dedicated shortcuts (Ctrl/Cmd + ArrowUp/ArrowDown) instead of contextual ArrowUp/ArrowDown.'
                                )}
                              </p>
                            </div>
                            <Switch
                              checked={promptHistoryNavigationMode === 'shortcut_only'}
                              onCheckedChange={(checked) =>
                                setPromptHistoryNavigationMode(checked ? 'shortcut_only' : 'contextual_arrows')
                              }
                            />
                          </div>
                        </div>
                      )}

                      <div
                        className={cn(
                          'rounded-lg border border-border bg-card/50 p-3',
                          hasConflict && 'border-amber-500/40',
                          isPromptHistoryShortcutDisabled && 'opacity-50'
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-foreground">
                              {shortcut.label}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {shortcut.description}
                            </p>
                            {isPromptHistoryShortcutDisabled && (
                              <p className="text-xs text-muted-foreground mt-1">
                                {t(
                                  'shortcuts.disabledInContextualMode',
                                  'Disabled while contextual ArrowUp/ArrowDown mode is active.'
                                )}
                              </p>
                            )}
                            {hasConflict && (
                              <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                                {t('shortcuts.conflictWith', 'Conflict with')}: {conflicts.join(', ')}
                              </p>
                            )}
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <span className={cn(
                              'text-xs px-2 py-1 rounded border bg-background',
                              isRecording ? 'border-primary text-primary' : 'border-border text-foreground'
                            )}>
                              {isRecording
                                ? (pendingBinding
                                  ? formatBindingForDisplay(pendingBinding)
                                  : t('common.listening', 'Listening...'))
                                : formatBindingForDisplay(binding)}
                            </span>

                            <button
                              onClick={() => {
                                setPendingBinding(null);
                                setRecordingId(shortcut.id);
                              }}
                              disabled={isPromptHistoryShortcutDisabled}
                              className="p-1.5 rounded border border-border hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                              title={t('shortcuts.recordShortcut', 'Record shortcut')}
                            >
                              <Icon name="edit" size={12} className="text-muted-foreground" />
                            </button>

                            <button
                              onClick={() => setBinding(shortcut.id, null)}
                              disabled={isPromptHistoryShortcutDisabled}
                              className="p-1.5 rounded border border-border hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                              title={t('shortcuts.disableShortcut', 'Disable shortcut')}
                            >
                              <Icon name="minus" size={12} className="text-muted-foreground" />
                            </button>

                            <button
                              onClick={() => resetBinding(shortcut.id)}
                              disabled={isPromptHistoryShortcutDisabled}
                              className="p-1.5 rounded border border-border hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                              title={t('shortcuts.resetDefault', 'Reset to default')}
                            >
                              <Icon name="rotate-ccw" size={12} className="text-muted-foreground" />
                            </button>
                          </div>
                        </div>
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      {confirmResetOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-2xl">
            <div className="px-4 py-3 border-b border-border">
              <h3 className="text-sm font-semibold text-foreground">
                {t('shortcuts.resetAllTitle', 'Reset all shortcuts?')}
              </h3>
              <p className="text-xs text-muted-foreground mt-1">
                {t(
                  'shortcuts.resetAllDescription',
                  'This will restore all key bindings to their default values.'
                )}
              </p>
            </div>
            <div className="px-4 py-3 flex items-center justify-end gap-2">
              <button
                onClick={() => setConfirmResetOpen(false)}
                className="h-8 px-3 rounded-md border border-border text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                onClick={() => {
                  resetAll();
                  setConfirmResetOpen(false);
                }}
                className="h-8 px-3 rounded-md bg-destructive/90 text-destructive-foreground text-sm hover:bg-destructive transition-colors"
              >
                {t('shortcuts.resetAll', 'Reset all')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
