import { afterEach, describe, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProjectIcon } from './ProjectIcon';

describe('ProjectIcon', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    container?.remove();
    container = null;
    root = null;
  });

  const renderIcon = async (
    projectId: string,
    resolveIcon: NonNullable<React.ComponentProps<typeof ProjectIcon>['resolveIcon']>,
    projectPath = `C:\\projects\\${projectId}`,
  ) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <ProjectIcon project={{ id: projectId, path: projectPath }} resolveIcon={resolveIcon} />,
      );
      await Promise.resolve();
    });
  };

  it('renders the resolved project icon', async () => {
    await renderIcon('project-with-icon', async () => ({
      dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+',
      sourcePath: 'public/favicon.svg',
      revision: 'revision-1',
    }));

    const image = container?.querySelector('img');
    expect(image?.getAttribute('src')).toBe('data:image/svg+xml;base64,PHN2Zy8+');
    expect(image?.dataset.projectIcon).toBe('public/favicon.svg');
  });

  it('uses the requested CSS box while preserving the resolved image proportions', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <ProjectIcon
          project={{ id: 'non-square-icon', path: '/projects/non-square-icon' }}
          size={18}
          resolveIcon={async () => ({
            dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+',
            sourcePath: 'public/tall-icon.svg',
            revision: 'revision-1',
          })}
        />,
      );
      await Promise.resolve();
    });

    const image = container?.querySelector('img');
    expect(image?.style.width).toBe('18px');
    expect(image?.style.height).toBe('18px');
    expect(image?.classList.contains('object-contain')).toBe(true);
  });

  it('keeps the folder fallback when no icon is found', async () => {
    await renderIcon('project-without-icon', async () => null);

    expect(container?.querySelector('img')).toBeNull();
    const fallback = container?.querySelector('svg');
    expect(fallback?.getAttribute('width')).toBe('16');
    expect(fallback?.getAttribute('height')).toBe('16');
  });

  it('resolves again when a project id is reused for another path', async () => {
    let callCount = 0;
    const resolveIcon = async () => {
      callCount += 1;
      return {
        dataUrl: `data:image/png;base64,icon-${callCount}`,
        sourcePath: `icon-${callCount}.png`,
        revision: `revision-${callCount}`,
      };
    };

    await renderIcon('reused-project-id', resolveIcon, 'C:\\projects\\first');
    await act(async () => {
      root?.render(
        <ProjectIcon
          project={{ id: 'reused-project-id', path: 'C:\\projects\\second' }}
          resolveIcon={resolveIcon}
        />,
      );
      await Promise.resolve();
    });

    expect(callCount).toBe(2);
    expect(container?.querySelector('img')?.dataset.projectIcon).toBe('icon-2.png');
  });

  it('uses the folder fallback when the resolved image cannot be displayed', async () => {
    await renderIcon('broken-project-icon', async () => ({
      dataUrl: 'data:image/png;base64,invalid',
      sourcePath: 'icon.png',
      revision: 'broken-revision',
    }));

    await act(async () => {
      container?.querySelector('img')?.dispatchEvent(new Event('error'));
    });

    expect(container?.querySelector('img')).toBeNull();
    expect(container?.querySelector('svg')).not.toBeNull();
  });
});
