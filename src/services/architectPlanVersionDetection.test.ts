import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  installTauriRuntimeMock,
  removeTauriRuntimeMock,
} from '../test-utils/tauriRuntime';
import {
  detectProjectVersion,
  detectProjectVersions,
} from './architectPlanVersionDetection';

afterEach(() => {
  removeTauriRuntimeMock();
});

describe('architectPlanVersionDetection', () => {
  it('does not invoke IPC without a project path or a Tauri runtime', async () => {
    const invoke = installTauriRuntimeMock(mock(async () => {
      throw new Error('IPC should not be called');
    }));

    expect(await detectProjectVersion({ id: 'without-path', path: '   ' })).toEqual({
      projectId: 'without-path',
      version: null,
      sourcePath: null,
    });
    expect(invoke).not.toHaveBeenCalled();

    removeTauriRuntimeMock();
    expect(await detectProjectVersion({ id: 'without-tauri', path: '/workspace/app' })).toEqual({
      projectId: 'without-tauri',
      version: null,
      sourcePath: null,
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('prefers package.json and permits reading outside the active workspace', async () => {
    const invoke = installTauriRuntimeMock(mock(async (command, payload) => {
      expect(command).toBe('fs_read_file');
      expect(payload).toMatchObject({
        path: 'C:/projects/macro/package.json',
        allowOutsideWorkspace: true,
      });
      return { content: JSON.stringify({ version: 'v1.8.0' }) };
    }));

    expect(await detectProjectVersion({ id: 'macro', path: 'C:/projects/macro/' })).toEqual({
      projectId: 'macro',
      version: '1.8.0',
      sourcePath: 'package.json',
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('continues through read errors and invalid JSON before using a Cargo version', async () => {
    const readPaths: string[] = [];
    installTauriRuntimeMock(mock(async (_command, payload) => {
      const path = String(payload?.path);
      readPaths.push(path);
      expect(payload?.allowOutsideWorkspace).toBe(true);

      if (path.endsWith('/package.json')) {
        throw new Error('missing package manifest');
      }
      if (path.endsWith('/src-tauri/tauri.conf.json')) {
        return { content: '{invalid-json' };
      }
      if (path.endsWith('/src-tauri/Cargo.toml')) {
        return { content: '[package]\nname = "macro"\nversion = "0.9.4"' };
      }
      throw new Error(`unexpected read: ${path}`);
    }));

    expect(await detectProjectVersion({ id: 'desktop', path: '/projects/desktop' })).toEqual({
      projectId: 'desktop',
      version: '0.9.4',
      sourcePath: 'src-tauri/Cargo.toml',
    });
    expect(readPaths).toEqual([
      '/projects/desktop/package.json',
      '/projects/desktop/src-tauri/tauri.conf.json',
      '/projects/desktop/src-tauri/Cargo.toml',
    ]);
  });

  it('preserves project order and isolates failures during multi-project detection', async () => {
    const readsByProject = new Map<string, string[]>();
    installTauriRuntimeMock(mock(async (_command, payload) => {
      const path = String(payload?.path);
      const project = path.includes('/broken/') ? 'broken' : 'working';
      readsByProject.set(project, [...(readsByProject.get(project) || []), path]);

      if (project === 'broken') {
        throw new Error('unreadable project');
      }
      if (path.endsWith('/package.json')) {
        return { content: JSON.stringify({ name: 'working' }) };
      }
      if (path.endsWith('/src-tauri/tauri.conf.json')) {
        return { content: JSON.stringify({ version: 'v3.1.0' }) };
      }
      throw new Error(`unexpected read: ${path}`);
    }));

    expect(
      await detectProjectVersions([
        { id: 'broken', path: '/projects/broken' },
        { id: 'working', path: '/projects/working' },
      ]),
    ).toEqual([
      { projectId: 'broken', version: null, sourcePath: null },
      { projectId: 'working', version: '3.1.0', sourcePath: 'src-tauri/tauri.conf.json' },
    ]);
    expect(readsByProject.get('broken')).toEqual([
      '/projects/broken/package.json',
      '/projects/broken/src-tauri/tauri.conf.json',
      '/projects/broken/src-tauri/Cargo.toml',
      '/projects/broken/Cargo.toml',
    ]);
    expect(readsByProject.get('working')).toEqual([
      '/projects/working/package.json',
      '/projects/working/src-tauri/tauri.conf.json',
    ]);
  });
});
