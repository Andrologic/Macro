import { describe, expect, it } from 'bun:test';
import {
  getEmptyProjectOpenSelection,
  getFallbackProjectOpenApps,
  NONE_PROJECT_OPEN_APP_ID,
  sanitizeProjectOpenAppCatalog,
} from './projectOpenDefaults';

describe('projectOpenDefaults', () => {
  it('returns a usable macOS fallback catalog', () => {
    const catalog = getFallbackProjectOpenApps('macos');
    expect(catalog.editor.map((app) => app.id)).toContain('vscode');
    expect(catalog.terminal.map((app) => app.id)).toContain('terminal');
    expect(catalog.files.map((app) => app.id)).toContain('finder');
  });

  it('returns a usable Windows fallback catalog', () => {
    const catalog = getFallbackProjectOpenApps('windows');
    expect(catalog.terminal.map((app) => app.id)).toContain('windows-terminal');
    expect(catalog.files.map((app) => app.id)).toContain('explorer');
  });

  it('creates a none-only default selection', () => {
    expect(getEmptyProjectOpenSelection()).toEqual({
      editor: NONE_PROJECT_OPEN_APP_ID,
      terminal: NONE_PROJECT_OPEN_APP_ID,
      files: NONE_PROJECT_OPEN_APP_ID,
    });
  });

  it('adds a do-nothing option when the catalog omits it', () => {
    const catalog = sanitizeProjectOpenAppCatalog({
      editor: [{ id: 'vscode', label: 'Visual Studio Code', action: 'editor', kind: 'detected' }],
      terminal: [],
      files: [{ id: 'finder', label: 'Finder', action: 'files', kind: 'builtin' }],
    });

    expect(catalog.editor[0]?.id).toBe(NONE_PROJECT_OPEN_APP_ID);
    expect(catalog.terminal[0]?.id).toBe(NONE_PROJECT_OPEN_APP_ID);
    expect(catalog.files[0]?.id).toBe(NONE_PROJECT_OPEN_APP_ID);
  });
});
