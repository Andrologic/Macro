import React, { useEffect, useMemo, useState } from 'react';
import type { Project } from '../../types';
import * as tauriIpc from '../../services/tauriIpc';
import type { ProjectIconDto } from '../../services/tauriIpc';
import { createProjectIconBatch } from '../../services/projectIconBatch';
import { cn } from '../../utils/cn';
import { Icon, type IconName } from '../ui/Icon';

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 64;

type ProjectIconResolver = (projectId: string) => Promise<ProjectIconDto | null>;

interface ProjectIconCacheEntry {
  expiresAt: number;
  result?: ProjectIconDto | null;
  promise?: Promise<ProjectIconDto | null>;
}

const projectIconCache = new Map<string, ProjectIconCacheEntry>();
const resolveDefaultProjectIcon = createProjectIconBatch((projectIds) =>
  tauriIpc.workspaceResolveProjectIcons(projectIds));

const pruneProjectIconCache = (): void => {
  const now = Date.now();
  for (const [cacheKey, entry] of projectIconCache) {
    if (entry.expiresAt <= now) projectIconCache.delete(cacheKey);
  }
  while (projectIconCache.size > MAX_CACHE_ENTRIES) {
    const oldestResolvedKey = Array.from(projectIconCache.entries())
      .find(([, entry]) => !entry.promise)?.[0];
    if (!oldestResolvedKey) break;
    projectIconCache.delete(oldestResolvedKey);
  }
};

const setProjectIconCache = (cacheKey: string, entry: ProjectIconCacheEntry): void => {
  projectIconCache.delete(cacheKey);
  projectIconCache.set(cacheKey, entry);
  pruneProjectIconCache();
};

const resolveCachedProjectIcon = (
  cacheKey: string,
  resolver: () => Promise<ProjectIconDto | null>,
): Promise<ProjectIconDto | null> => {
  pruneProjectIconCache();
  const cached = projectIconCache.get(cacheKey);
  if (cached) {
    if (cached.promise) return cached.promise;
    if ('result' in cached) return Promise.resolve(cached.result ?? null);
  }

  const promise = resolver()
    .then((result) => {
      setProjectIconCache(cacheKey, {
        expiresAt: Date.now() + CACHE_TTL_MS,
        result,
      });
      return result;
    })
    .catch((error) => {
      projectIconCache.delete(cacheKey);
      throw error;
    });
  setProjectIconCache(cacheKey, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    promise,
  });
  return promise;
};

interface ProjectIconProps {
  project: Pick<Project, 'id' | 'path'>;
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
  const cacheKey = useMemo(
    () => `${project.id}\0${project.path.trim().replace(/\\/g, '/')}`,
    [project.id, project.path],
  );
  const [resolvedIcon, setResolvedIcon] = useState<{
    cacheKey: string;
    icon: ProjectIconDto | null;
  } | null>(null);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setResolvedIcon(null);
    setImageFailed(false);
    if (
      !resolveIcon
      && (!tauriIpc.isTauriAvailable() || typeof tauriIpc.workspaceResolveProjectIcons !== 'function')
    ) return;

    let active = true;
    resolveCachedProjectIcon(
      cacheKey,
      () => resolveIcon?.(project.id) ?? resolveDefaultProjectIcon(project.id),
    )
      .then((result) => {
        if (active) setResolvedIcon({ cacheKey, icon: result });
      })
      .catch(() => {
        if (active) setResolvedIcon({ cacheKey, icon: null });
      });
    return () => {
      active = false;
    };
  }, [cacheKey, project.id, resolveIcon]);

  const icon = resolvedIcon?.cacheKey === cacheKey ? resolvedIcon.icon : null;
  if (!icon || imageFailed) {
    return <Icon name={fallbackIcon} size={size} className={className} />;
  }

  return (
    <img
      src={icon.dataUrl}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size }}
      data-project-icon={icon.sourcePath}
      draggable={false}
      className={cn('shrink-0 rounded-sm object-contain', className)}
      onError={() => setImageFailed(true)}
    />
  );
};
