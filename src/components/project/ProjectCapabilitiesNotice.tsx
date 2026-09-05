import { useTranslation } from 'react-i18next';
import type { Project } from '../../types';
import { getProjectCapabilities } from '../../services/projectCapabilities';

export function ProjectCapabilitiesNotice({ project }: {
  project: Pick<Project, 'path'> & Partial<Pick<Project, 'pathKind'>>;
}) {
  const { t } = useTranslation();
  if (getProjectCapabilities(project).reason !== 'wsl') return null;
  return <p role="status" className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
    {t('implement.wslCapabilities', 'For WSL projects, metadata synchronization, task worktrees, file review and the merge workflow are unavailable. Basic Git operations remain available. Use a local clone for these task workflows.')}
  </p>;
}
