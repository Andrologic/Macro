import { afterEach, describe, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Icon } from './Icon';

describe('Icon', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  const flushRender = async () => {
    await Promise.resolve();
  };

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await flushRender();
    });
    container?.remove();
    container = null;
    root = null;
  });

  it('renders the save icon used by the write workspace tool', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<Icon name="save" />);
      await flushRender();
    });

    expect(container.querySelector('svg')).not.toBeNull();
  });
});
