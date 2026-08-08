export const nodeBelongsToElement = (
  element: HTMLElement | null,
  node: Node | null
): boolean => {
  return Boolean(element && node && (node === element || element.contains(node)));
};

export const domSelectionBelongsToElement = (element: HTMLElement | null): boolean => {
  if (typeof window === 'undefined' || !element) {
    return false;
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return false;
  }

  return (
    nodeBelongsToElement(element, selection.anchorNode) ||
    nodeBelongsToElement(element, selection.focusNode)
  );
};

export const clearWindowSelection = () => {
  if (typeof window === 'undefined') {
    return;
  }

  window.getSelection()?.removeAllRanges();
};
