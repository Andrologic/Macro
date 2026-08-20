import React, { useEffect, useState } from 'react';
import type { Project } from '../../types';
import * as tauriIpc from '../../services/tauriIpc';
import type { ProjectIconDto } from '../../services/tauriIpc';
import { cn } from '../../utils/cn';
import { Icon, type IconName } from '../ui/Icon';

const CACHE_TTL_MS = 5 * 60 * 1000;

type ProjectIconResolver = (projectId: string) => Promise<ProjectIconDto | null>;

interface ProjectIconCacheEntry {
  expiresAt: number;
  result?: ProjectIconDto | null;
  promise?: Promise<ProjectIconDto | null>;
}

const projectIconCache = new Map<string, ProjectIconCacheEntry>();

const resolveCachedProjectIcon = (
  projectId: string,
  resolver: ProjectIconResolver,
): Promise<ProjectIconDto | null> => {
  const cached = projectIconCache.get(projectId);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.promise) return cached.promise;
    if ('result' in cached) return Promise.resolve(cached.result ?? null);
  }

  const promise = resolver(projectId)
    .then((result) => {
      projectIconCache.set(projectId, {
        expiresAt: Date.now() + CACHE_TTL_MS,
        result,
      });
      return result;
    })
    .catch((error) => {
      projectIconCache.delete(projectId);
      throw error;
    });
  projectIconCache.set(projectId, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    promise,
  });
  return promise;
};

interface ProjectIconProps {
  project: Pick<Project, 'id'>;
  size?: number;
  className?: string;
  fallbackIcon?: IconName;
  resolveIcon?: ProjectIconResolver;
}

export const ProjectIcon: React.FC<ProjectIconProps> = ({
  project,
  size = 16,
  className,
  fallbackIcon = 'folder-git-2',
  resolveIcon,
}) => {
  const [resolvedIcon, setResolvedIcon] = useState<{
    projectId: string;
    icon: ProjectIconDto | null;
  } | null>(null);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setResolvedIcon(null);
    setImageFailed(false);
    const defaultResolver = tauriIpc.workspaceResolveProjectIcon;
    if (
      !resolveIcon
      && (!tauriIpc.isTauriAvailable() || typeof defaultResolver !== 'function')
    ) return;

    let active = true;
    resolveCachedProjectIcon(project.id, resolveIcon ?? defaultResolver)
      .then((result) => {
        if (active) setResolvedIcon({ projectId: project.id, icon: result });
      })
      .catch(() => {
        if (active) setResolvedIcon({ projectId: project.id, icon: null });
      });
    return () => {
      active = false;
    };
  }, [project.id, resolveIcon]);

  const icon = resolvedIcon?.projectId === project.id ? resolvedIcon.icon : null;
  if (!icon || imageFailed) {
    return <Icon name={fallbackIcon} size={size} className={className} />;
  }

  return (
    <img
      src={icon.dataUrl}
      alt=""
      width={size}
      height={size}
      data-project-icon={icon.sourcePath}
      draggable={false}
      className={cn('shrink-0 rounded-sm object-contain', className)}
      onError={() => setImageFailed(true)}
    />
  );
};
