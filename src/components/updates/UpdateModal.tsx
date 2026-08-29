import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useAppUpdateStore } from '../../stores/useAppUpdateStore';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useTaskStore } from '../../stores/useTaskStore';
import {
  hasUnapprovedRestartSafetyActivity,
  selectRestartSafetySnapshot,
  type RestartSafetySnapshot,
} from '../../services/restartSafety';
import { beginAppShutdownGate } from '../../services/appShutdownGate';
import { isProjectGitActionable } from '../../services/globalProjects';
import { PREF_KEYS, savePreference } from '../../services/preferences';
import { prepareForPotentialShutdown } from '../../services/windowShutdown';
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
  const [
    phase,
    update,
    errorOperation,
    detailsOpen,
    closeDetails,
    installAndRestart,
    reset,
    checkForUpdates,
  ] = useAppUpdateStore(
    useShallow((state) => [
      state.phase,
      state.availableUpdate,
      state.errorOperation,
      state.detailsOpen,
      state.closeDetails,
      state.installAndRestart,
      state.reset,
      state.checkForUpdates,
    ]),
  );
  const [restartWarning, setRestartWarning] = useState<RestartSafetySnapshot | null>(null);
  const closeActionRef = useRef<HTMLButtonElement>(null);

  if (!detailsOpen || !update) return null;

  const redownload = async () => {
    await reset();
    const outcome = await checkForUpdates({ explicit: true });
    if (outcome === 'error') {
      notify.error(t('updates.downloadFailed', 'The update could not be downloaded'));
    }
  };

  const needsRedownload = phase === 'error' && errorOperation === 'install';
  const isInstalling = phase === 'installing';

  const close = () => {
    setRestartWarning(null);
    closeDetails();
  };

  const install = async (approvedSafety: RestartSafetySnapshot) => {
    const releaseShutdownGate = beginAppShutdownGate();
    const currentSafety = getRestartSafetySnapshot();
    if (hasUnapprovedRestartSafetyActivity(approvedSafety, currentSafety)) {
      releaseShutdownGate();
      setRestartWarning(currentSafety);
      return;
    }

    try {
      await prepareForPotentialShutdown(getSelectedWorkspacePaths());
    } catch {
      releaseShutdownGate();
      notify.error(t('updates.prepareFailed', 'Macro could not prepare the restart'));
      return;
    }

    if (update.notes.trim()) {
      try {
        await savePreference(PREF_KEYS.RELEASE_NOTES_PENDING_UPDATE, {
          version: update.version,
          content: update.notes,
        });
      } catch {
        // Release notes are useful after relaunch, but never block a verified update.
      }
    }

    if (!(await installAndRestart())) {
      releaseShutdownGate();
      notify.error(t('updates.installFailed', 'The update could not be installed'), {
        description: useAppUpdateStore.getState().error ?? undefined,
      });
    }
  };

  const requestInstall = () => {
    const safety = getRestartSafetySnapshot();
    if (safety.hasActiveWork) {
      setRestartWarning(safety);
      return;
    }
    void install(safety);
  };

  const activeItems = restartWarning
    ? [...restartWarning.activeAgents, ...restartWarning.activeImplementations]
    : [];

  if (restartWarning) {
    return (
      <Dialog
        title={t('updates.activeWorkTitle', 'Agents are still running')}
        onClose={isInstalling ? () => undefined : close}
        initialFocusRef={closeActionRef}
      >
        <article className="w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-2xl">
          <header className="border-b border-border px-5 py-5">
            <h2 className="text-lg font-semibold text-foreground">
              {t('updates.activeWorkTitle', 'Agents are still running')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('updates.activeWorkDescription', '{{count}} active task may lose its current output if Macro closes now.', {
                count: restartWarning.activeWorkCount,
              })}
            </p>
          </header>
          <ul className="max-h-64 space-y-2 overflow-y-auto px-5 py-4">
            {activeItems.map((activity) => (
              <li key={`${activity.kind}:${activity.id}`} className="rounded-lg border border-border bg-background/45 px-3 py-2 text-sm">
                {activity.title ?? activity.id}
              </li>
            ))}
          </ul>
          <footer className="flex justify-end gap-2 border-t border-border px-5 py-4">
            <Button ref={closeActionRef} type="button" size="sm" variant="primary" onClick={close}>
              {t('updates.wait', 'Wait')}
            </Button>
            <Button type="button" size="sm" variant="error" onClick={() => void install(restartWarning)}>
              {t('updates.restartAnyway', 'Install anyway')}
            </Button>
          </footer>
        </article>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={t('updates.dialogTitle', 'Macro update')}
      onClose={isInstalling ? () => undefined : close}
      initialFocusRef={closeActionRef}
      backdropClassName="fixed inset-0 z-[12500] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm"
    >
      <article className="flex max-h-[min(86vh,720px)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-2xl ring-1 ring-white/5">
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
              onClick={close}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label={t('common.close', 'Close')}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          {update.notes.trim() ? (
            <MarkdownRenderer content={update.notes} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('updates.noNotes', 'No release notes were provided for this update.')}
            </p>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-border bg-background/30 px-5 py-4 sm:px-6">
          <p className="text-xs text-muted-foreground">
            {t('updates.installsNextLaunch', 'It will be installed the next time Macro opens.')}
          </p>
          <div className="flex shrink-0 gap-2">
            <Button ref={closeActionRef} type="button" size="sm" variant="ghost" disabled={isInstalling} onClick={close}>
              {t('common.close', 'Close')}
            </Button>
            {needsRedownload ? (
              <Button type="button" size="sm" variant="primary" onClick={() => void redownload()}>
                {t('updates.downloadAgain', 'Download again')}
              </Button>
            ) : (
              <Button type="button" size="sm" variant="primary" isLoading={isInstalling} onClick={requestInstall}>
                {t('updates.installNow', 'Install now')}
              </Button>
            )}
          </div>
        </footer>
      </article>
    </Dialog>
  );
};

export default UpdateModal;
