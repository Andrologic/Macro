import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let persistedConventionalRoots: Record<string, boolean> | null = null;
const patchConfigTopLevelMock = mock(async (
  _kind: string,
  _scope: unknown,
  key: string,
  update: unknown,
) => {
  if (key === 'conventionalRoots' && typeof update === 'function') {
    persistedConventionalRoots = update({ agents: true }) as Record<string, boolean>;
  }
  return {};
});

mock.module('../../../stores/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) => selector({
    snapshot: {
      effective: {
        skills: {
          conventionalRoots: {
            agents: true,
            codex: false,
            opencode: true,
            claude: true,
          },
        },
      },
      projectEffective: {},
    },
  }),
}));

mock.module('../../../services/configDocuments', () => ({
  patchConfigTopLevel: patchConfigTopLevelMock,
}));

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

mock.module('../../ui/toastService', () => ({
  notify: { error: mock(() => undefined) },
}));

let importCounter = 0;

describe('SkillSourcesPanel', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    mock.restore();
  });

  it('preserves inherited source choices when writing the first sparse override', async () => {
    persistedConventionalRoots = null;
    patchConfigTopLevelMock.mockClear();
    importCounter += 1;
    const { SkillSourcesPanel } = await import(
      `./SkillSourcesPanel.tsx?inherited-sources=${importCounter}`
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<SkillSourcesPanel projects={[]} onChanged={async () => undefined} />);
    });
    const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');

    await act(async () => {
      checkboxes[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(persistedConventionalRoots as Record<string, boolean> | null).toEqual({
      agents: true,
      codex: false,
      opencode: false,
      claude: true,
    });
  });
});
