import React from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';

interface ProjectGitFlowConfirmationModalProps {
  projectName: string;
  branches: string[];
  currentBranch?: string | null;
  mainBranch: string;
  baseBranch: string;
  isSubmitting: boolean;
  validationMessage?: string | null;
  errorMessage?: string | null;
  onChangeMainBranch: (value: string) => void;
  onChangeBaseBranch: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}

export const ProjectGitFlowConfirmationModal: React.FC<ProjectGitFlowConfirmationModalProps> = ({
  projectName,
  branches,
  currentBranch,
  mainBranch,
  baseBranch,
  isSubmitting,
  validationMessage,
  errorMessage,
  onChangeMainBranch,
  onChangeBaseBranch,
  onClose,
  onConfirm,
}) => {
  const { t } = useTranslation();

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={onClose} />

      <div className="relative mx-4 w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="space-y-1">
            <div className="text-sm font-semibold text-foreground">
              {t('projects.gitFlowConfirmTitle', 'Confirm branch roles')}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t(
                'projects.gitFlowConfirmSubtitle',
                'Macro found uncommon branch names in {{projectName}}. Confirm which branch is the main branch and which one should receive feature work before saving the project.',
                { projectName }
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-lg p-1.5 transition-colors hover:bg-accent disabled:opacity-50"
          >
            <Icon name="x" size={16} className="text-muted-foreground" />
          </button>
        </header>

        <div className="space-y-4 px-5 py-5">
          <section className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <p className="text-xs text-amber-200">
              {t(
                'projects.gitFlowConfirmHelp',
                'You can keep the suggested mapping or adjust it if this repository uses an internal naming convention.'
              )}
            </p>
          </section>

          {currentBranch && (
            <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              {t('projects.gitFlowCurrentBranchLabel', 'Current branch')}: <span className="font-mono text-foreground">{currentBranch}</span>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-2">
              <span className="text-sm font-medium text-foreground">
                {t('projects.gitFlowMainBranch', 'Main branch')}
              </span>
              <select
                value={mainBranch}
                onChange={(event) => onChangeMainBranch(event.target.value)}
                disabled={isSubmitting}
                className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
              >
                {branches.map((branch) => (
                  <option key={`main-${branch}`} value={branch}>
                    {branch}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-2">
              <span className="text-sm font-medium text-foreground">
                {t('projects.gitFlowBaseBranch', 'Development/target branch')}
              </span>
              <select
                value={baseBranch}
                onChange={(event) => onChangeBaseBranch(event.target.value)}
                disabled={isSubmitting}
                className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
              >
                {branches.map((branch) => (
                  <option key={`base-${branch}`} value={branch}>
                    {branch}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {validationMessage && (
            <section className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2">
              <p className="text-xs text-amber-200">{validationMessage}</p>
            </section>
          )}

          {errorMessage && (
            <section className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2">
              <p className="text-xs text-red-300">{errorMessage}</p>
            </section>
          )}

          <section className="rounded-xl border border-border/50 bg-muted/20 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground">
              {t('projects.gitFlowDetectedBranches', 'Detected branches')}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {branches.map((branch) => (
                <span
                  key={branch}
                  className="rounded-full border border-border/60 bg-background px-2.5 py-1 font-mono text-[11px] text-muted-foreground"
                >
                  {branch}
                </span>
              ))}
            </div>
          </section>

          <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              {t('common.cancel', 'Cancel')}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={isSubmitting || !mainBranch || !baseBranch || Boolean(validationMessage)}
              className="rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
            >
              {isSubmitting
                ? t('project.saving', 'Saving...')
                : t('projects.gitFlowConfirmAction', 'Confirm and save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProjectGitFlowConfirmationModal;
