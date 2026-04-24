import type { Project } from '../types';
import * as tauriIpc from './tauriIpc';
import { normalizeVersionSlug } from './architectPlanKinds';

export interface DetectedProjectVersion {
  projectId: string;
  version: string | null;
  sourcePath: string | null;
}

const VERSION_FILES = [
  'package.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
  'Cargo.toml',
];

const joinPath = (basePath: string, relativePath: string): string =>
  `${basePath.replace(/[\\/]+$/, '')}/${relativePath}`;

const parseJsonVersion = (raw: string): string | null => {
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; package?: { version?: unknown } };
    const value =
      typeof parsed.version === 'string'
        ? parsed.version
        : typeof parsed.package?.version === 'string'
          ? parsed.package.version
          : null;
    return normalizeVersionSlug(value);
  } catch {
    return null;
  }
};

const parseTomlVersion = (raw: string): string | null => {
  const packageSection = /^\s*\[package\]\s*$/m.exec(raw);
  const searchArea = packageSection ? raw.slice(packageSection.index) : raw;
  const match = /^\s*version\s*=\s*["']([^"']+)["']/m.exec(searchArea);
  return normalizeVersionSlug(match?.[1]);
};

const parseVersionForFile = (relativePath: string, raw: string): string | null => {
  if (relativePath.endsWith('.json')) {
    return parseJsonVersion(raw);
  }
  if (relativePath.endsWith('.toml')) {
    return parseTomlVersion(raw);
  }
  return null;
};

export const detectProjectVersion = async (
  project: Pick<Project, 'id' | 'path'>,
): Promise<DetectedProjectVersion> => {
  const projectPath = typeof project.path === 'string' ? project.path.trim() : '';
  if (!projectPath || !tauriIpc.isTauriAvailable()) {
    return {
      projectId: project.id,
      version: null,
      sourcePath: null,
    };
  }

  for (const relativePath of VERSION_FILES) {
    const fullPath = joinPath(projectPath, relativePath);
    try {
      const content = await tauriIpc.fsReadFileWithOptions({
        path: fullPath,
        allowOutsideWorkspace: true,
      });
      const version = parseVersionForFile(relativePath, content.content || '');
      if (version) {
        return {
          projectId: project.id,
          version,
          sourcePath: relativePath,
        };
      }
    } catch {
      // Version detection is best-effort and must never block plan creation.
    }
  }

  return {
    projectId: project.id,
    version: null,
    sourcePath: null,
  };
};

export const detectProjectVersions = async (
  projects: Array<Pick<Project, 'id' | 'path'>>,
): Promise<DetectedProjectVersion[]> =>
  Promise.all(projects.map((project) => detectProjectVersion(project)));
