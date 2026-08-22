import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useAppUpdateStore } from '../../stores/useAppUpdateStore';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useTaskStore } from '../../stores/useTaskStore';
import {
  selectRestartSafetySnapshot,
  type RestartSafetySnapshot,
} from '../../services/restartSafety';
import { prepareForPotentialShutdown } from '../../services/windowShutdown';
import { PREF_KEYS, savePreference } from '../../services/preferences';
import { isProjectGitActionable } from '../../services/globalProjects';
import { MarkdownRenderer } from '../chat/MarkdownRenderer';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';
import { notify } from '../ui/toastService';

const getRestartSafetySnapshot = (): RestartSafetySnapshot => {
  const chatState = useChatStore.getState();
  const taskState = useTaskStore.getState();
  return selectRestartSafetySnapshot({
    conversations: chatState.conversations,
    conversationRuntimeById: chatState.conversationRuntimeById,
    conversationCompactionStatusById: chatState.conversationCompactionStatusById,
    tasks: taskState.tasks,
    taskCommandRuns: taskState.taskCommandRuns,
  });
};

const getSelectedWorkspacePaths = (): string[] => {
  const { projectGroups, selectedGroupId } = useAppStore.getState();
  if (!selectedGroupId) return [];
  return projectGroups
    .find((group) => group.id === selectedGroupId)
    ?.projects
    .filter((project) => isProjectGitActionable(project))
    .map((project) => project.path)
    .filter((path) => path.trim().length > 0) ?? [];
};

export const UpdateModal: React.FC = () => {
  const { t } = useTranslation();
  const [phase, update, error, errorOperation, detailsOpen, closeDetails, installAndRestart] =
    useAppUpdateStore(
      useShallow((state) => [
        state.phase,
        state.availableUpdate,
        state.error,
        state.errorOperation,
        state.detailsOpen,
        state.closeDetails,
        state.installAndRestart,
      ]),
    );
  const [restartWarning, setRestartWarning] = useState<RestartSafetySnapshot | null>(null);
  const safeActionRef = useRef<HTMLButtonElement>(null);

  if (!detailsOpen || !update) return null;

  const close = () => {
    setRestartWarning(null);
    closeDetails();
  };

  const install = async (force: boolean) => {
    try {
      await prepareForPotentialShutdown(getSelectedWorkspacePaths());
    } catch (prepareError) {
      notify.error(t('updates.prepareFailed', 'Macro could not prepare the restart'), {
        description: prepareError instanceof Error ? prepareError.message : String(prepareError),
      });
      return;
    }

    if (!force) {
      const safety = getRestartSafetySnapshot();
      if (safety.hasActiveWork) {
        setRestartWarning(safety);
        return;
      }
    }

    if (update.notes.trim()) {
      try {
        await savePreference(PREF_KEYS.RELEASE_NOTES_PENDING_UPDATE, {
          version: update.version,
          content: update.notes,
        });
      } catch (releaseNoteError) {
        console.warn('Failed to preserve updater release notes:', releaseNoteError);
      }
    }

    const installed = await installAndRestart();
    if (!installed) {
      notify.error(t('updates.installFailed', 'The update could not be installed'), {
        description: useAppUpdateStore.getState().error ?? undefined,
      });
    }
  };

  const requestRestart = () => {
    const safety = getRestartSafetySnapshot();
    if (safety.hasActiveWork) {
      setRestartWarning(safety);
      return;
    }
    void install(false);
  };

  const forceRestart = () => {
    setRestartWarning(getRestartSafetySnapshot());
    void install(true);
  };

  const isInstalling = phase === 'installing';
  const canInstall = phase === 'ready'
    || (phase === 'error' && errorOperation === 'install');
  const activeItems = restartWarning
    ? [...restartWarning.activeAgents, ...restartWarning.activeImplementations]
    : [];

  return (
    <Dialog
      title={restartWarning
        ? t('updates.activeWorkTitle', 'Agents are still running')
        : t('updates.dialogTitle', 'Macro update')}
      onClose={isInstalling ? () => undefined : close}
      initialFocusRef={safeActionRef}
      backdropClassName="fixed inset-0 z-[12500] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm"
    >
      <article className="flex max-h-[min(86vh,720px)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-2xl ring-1 ring-white/5">
        {restartWarning ? (
          <>
            <header className="border-b border-border px-5 py-5 sm:px-6">
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-amber-500/10 p-2 text-amber-400">
                  <Icon name="triangle-alert" size={18} />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-foreground">
                    {t('updates.activeWorkTitle', 'Agents are still running')}
                  </h2>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {t(
                      'updates.activeWorkDescription',
                      '{{count}} active task may lose its current output if Macro restarts now.',
                      { count: restartWarning.activeWorkCount },
                    )}
                  </p>
                </div>
              </div>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
              <ul className="space-y-2">
                {activeItems.map((activity) => (
                  <li key={`${activity.kind}:${activity.id}`} className="rounded-lg border border-border bg-background/45 px-3 py-2">
                    <div className="truncate text-sm font-medium text-foreground">
                      {activity.title ?? activity.id}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {activity.kind === 'agent'
                        ? t('updates.agentActivity', 'Agent')
                        : t('updates.implementActivity', 'Implement execution')}
                      {' · '}{activity.phase}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            <footer className="flex justify-end gap-2 border-t border-border bg-background/30 px-5 py-4 sm:px-6">
              <Button ref={safeActionRef} type="button" size="sm" variant="primary" onClick={close}>
                {t('updates.wait', 'Wait')}
              </Button>
              <Button type="button" size="sm" variant="error" onClick={forceRestart}>
                {t('updates.restartAnyway', 'Restart anyway')}
              </Button>
            </footer>
          </>
        ) : (
          <>
            <header className="border-b border-border px-5 py-5 sm:px-6">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <div className="rounded-lg bg-primary/10 p-2 text-primary">
                    <Icon name="download" size={18} />
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
                      {t('updates.available', 'Update available')}
                    </p>
                    <h2 className="mt-1 text-lg font-semibold text-foreground">
                      Macro v{update.version}
                    </h2>
                    {update.date ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {new Date(update.date).toLocaleDateString()}
                      </p>
                    ) : null}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={t('common.close', 'Close')}
                  title={t('common.close', 'Close')}
                  disabled={isInstalling}
                  onClick={close}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                >
                  <Icon name="x" size={16} />
                </button>
              </div>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
              {update.notes.trim() ? (
                <MarkdownRenderer content={update.notes} className="release-notes-markdown" />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t('updates.noNotes', 'No release notes were provided for this version.')}
                </p>
              )}
              {error ? (
                <p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                  {error}
                </p>
              ) : null}
            </div>
            <footer className="flex items-center justify-between gap-3 border-t border-border bg-background/30 px-5 py-4 sm:px-6">
              <p className="text-xs text-muted-foreground">
                {phase === 'downloading'
                  ? t('updates.downloadInProgress', 'The signed update is downloading in the background.')
                  : t('updates.restartRequired', 'Macro will reopen after the update is installed.')}
              </p>
              <div className="flex shrink-0 gap-2">
                <Button ref={safeActionRef} type="button" size="sm" variant="ghost" disabled={isInstalling} onClick={close}>
                  {t('updates.later', 'Later')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="primary"
                  isLoading={isInstalling}
                  disabled={!canInstall}
                  onClick={requestRestart}
                >
                  {t('updates.restartAndUpdate', 'Restart and update')}
                </Button>
              </div>
            </footer>
          </>
        )}
      </article>
    </Dialog>
  );
};

export default UpdateModal;
