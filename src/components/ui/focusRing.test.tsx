import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Button } from './Button';
import { Input } from './Input';
import { PanelHeaderIconButton } from './PanelHeaderIconButton';
import { Switch } from './Switch';

describe('focus ring controls', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('leaves the shared focus treatment to the global focus rule', async () => {
    await act(async () => {
      root.render(
        <>
          <Button>Save</Button>
          <Input error />
          <Switch checked />
          <PanelHeaderIconButton icon="plus" label="Add" />
        </>,
      );
    });

    const controls = container.querySelectorAll('button, input');
    expect(controls).toHaveLength(4);
    controls.forEach((control) => {
      expect(control.className).not.toMatch(/focus-visible:ring/);
      expect(control.className).not.toMatch(/ring-offset/);
    });
  });
});
