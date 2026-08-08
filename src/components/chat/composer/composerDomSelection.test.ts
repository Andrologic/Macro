import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  clearWindowSelection,
  domSelectionBelongsToElement,
  nodeBelongsToElement,
} from './composerDomSelection';

const originalGetSelection = window.getSelection.bind(window);

const stubWindowSelection = (selection: Partial<Selection> | null) => {
  Object.defineProperty(window, 'getSelection', {
    configurable: true,
    value: () => selection as Selection | null,
  });
};

describe('composer DOM selection helpers', () => {
  afterEach(() => {
    Object.defineProperty(window, 'getSelection', {
      configurable: true,
      value: originalGetSelection,
    });
    document.body.innerHTML = '';
  });

  it('detects nodes inside an element', () => {
    const root = document.createElement('div');
    const child = document.createElement('span');
    const outside = document.createElement('span');

    root.appendChild(child);

    expect(nodeBelongsToElement(root, root)).toBe(true);
    expect(nodeBelongsToElement(root, child)).toBe(true);
    expect(nodeBelongsToElement(root, outside)).toBe(false);
    expect(nodeBelongsToElement(null, child)).toBe(false);
    expect(nodeBelongsToElement(root, null)).toBe(false);
  });

  it('detects whether the current window selection belongs to an element', () => {
    const root = document.createElement('div');
    const child = document.createTextNode('hello');
    const outside = document.createTextNode('outside');

    root.appendChild(child);
    document.body.append(root, outside);

    stubWindowSelection({
      anchorNode: child,
      focusNode: child,
      rangeCount: 1,
    });

    expect(domSelectionBelongsToElement(root)).toBe(true);

    stubWindowSelection({
      anchorNode: outside,
      focusNode: outside,
      rangeCount: 1,
    });

    expect(domSelectionBelongsToElement(root)).toBe(false);

    stubWindowSelection({
      anchorNode: child,
      focusNode: child,
      rangeCount: 0,
    });

    expect(domSelectionBelongsToElement(root)).toBe(false);
  });

  it('clears the current window selection', () => {
    const removeAllRanges = mock(() => undefined);

    stubWindowSelection({
      rangeCount: 1,
      removeAllRanges,
    });

    clearWindowSelection();

    expect(removeAllRanges).toHaveBeenCalledTimes(1);
  });
});
